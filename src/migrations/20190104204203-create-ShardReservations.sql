CREATE TABLE "ShardReservationClusters" (
  "cluster" character varying(32) not null,
  "reshardedAt" timestamp with time zone,
  PRIMARY KEY ("cluster")
);

CREATE TABLE "ShardReservations" (
  "cluster" character varying(32) not null,
  shard int,
  holder uuid not null,
  "expiresAt" timestamp with time zone not null,
  PRIMARY KEY (holder),
  CONSTRAINT "ShardReservations_cluster_fkey"
    FOREIGN KEY ("cluster")
    REFERENCES "ShardReservationClusters" ("cluster")
    ON UPDATE CASCADE
    ON DELETE CASCADE
);
CREATE INDEX "ShardReservations_cluster_expiresAt_idx"
  ON "ShardReservations" ("cluster", "expiresAt");
CREATE INDEX "ShardReservations_cluster_shard_holder_idx"
  ON "ShardReservations" ("cluster", shard, holder);

CREATE FUNCTION "reshard_ShardReservations"(
  target_cluster text,
  reshard_interval interval
)
RETURNS timestamp with time zone AS $$
DECLARE
    r RECORD;
    reshardAt timestamp with time zone;
    now timestamp with time zone := CURRENT_TIMESTAMP;
BEGIN
  reshardAt := (
    SELECT "reshardedAt" + reshard_interval
      FROM "ShardReservationClusters"
      WHERE "cluster" = target_cluster
      -- aquire an exclusive lock on the cluster
      FOR UPDATE
  );

  IF reshardAt IS NOT NULL AND reshardAt > now + INTERVAL '1 seconds' THEN
    RETURN reshardAt;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "ShardReservations"
    WHERE "cluster" = target_cluster
      AND (
        "expiresAt" <= now
        OR "shard" IS NULL
      )
  ) THEN
    RETURN NULL;
  END IF;

  DELETE FROM "ShardReservations"
    WHERE "cluster" = target_cluster
      AND "expiresAt" <= now;

  FOR r IN UPDATE "ShardReservations" updated
    SET shard = src.shard
    FROM (
    SELECT holder, row_number() OVER (
        PARTITION BY "cluster"
        ORDER BY shard NULLS LAST, holder
      ) - 1 AS shard,
      COUNT(*) OVER (PARTITION BY "cluster") AS "numShards"
      FROM "ShardReservations"
      WHERE "cluster" = target_cluster
    ) AS src
    WHERE updated."cluster" = target_cluster AND updated.holder = src.holder
    RETURNING updated.holder, updated.shard, src."numShards"
  LOOP
    PERFORM pg_notify(
      'shardInfo/' || r.holder,
      json_build_object('shard', r.shard, 'numShards', r."numShards") #>> '{}'
    );
  END LOOP;

  UPDATE "ShardReservationClusters"
    SET "reshardedAt" = now
    WHERE "cluster" = target_cluster;

  RETURN NULL;
END;
$$
LANGUAGE plpgsql;

-- down

DROP FUNCTION "reshard_ShardReservations"(text, interval);
DROP TABLE "ShardReservations";

DROP TABLE "ShardReservationClusters";
