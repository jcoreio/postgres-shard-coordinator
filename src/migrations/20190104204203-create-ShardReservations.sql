CREATE TABLE "ShardReservationClusters" (
  "cluster" character varying(32) not null,
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

CREATE FUNCTION "reshard_ShardReservations"(target_cluster text)
RETURNS VOID AS $$
DECLARE
    r RECORD;
BEGIN
  FOR r IN UPDATE "ShardReservations" updated
    SET shard = src.shard
    FROM (
    SELECT holder, row_number() OVER (
        PARTITION BY "cluster"
        ORDER BY shard NULLS LAST
      ) - 1 AS shard,
      COUNT(*) OVER (PARTITION BY "cluster") AS "numShards"
      FROM "ShardReservations"
      WHERE "cluster" = target_cluster
    ) AS src
    WHERE updated."cluster" = target_cluster AND updated.holder = src.holder
    RETURNING updated.holder, updated.shard, src."numShards"
  LOOP
    PERFORM pg_notify('shardInfo/' || r.holder, row_to_json(r) #>> '{}');
  END LOOP;
END;
$$
LANGUAGE plpgsql;
-- down

DROP FUNCTION "reshard_ShardReservations"(text);
DROP TABLE "ShardReservations";

DROP TABLE "ShardReservationClusters";
