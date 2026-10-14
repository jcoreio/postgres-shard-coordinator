CREATE FUNCTION register_shard(
  target_cluster text,
  target_holder uuid,
  time_to_live interval,
  now timestamptz
)
RETURNS "ShardReservations" AS $$
DECLARE
  r "ShardReservations";
  expired "ShardReservations";
BEGIN
  INSERT INTO "ShardReservations" (
      cluster,
      holder,
      "expiresAt"
    )
    VALUES (
      target_cluster,
      target_holder,
      now + time_to_live
    )
    ON CONFLICT (holder) DO UPDATE
      SET "expiresAt" = EXCLUDED."expiresAt"
    RETURNING * INTO r;

  IF r.shard IS NULL THEN
    SELECT * INTO expired FROM "ShardReservations"
      WHERE cluster = target_cluster
        AND holder != target_holder
        AND "expiresAt" <= now
        AND shard IS NOT NULL
      LIMIT 1;
    IF expired.shard IS NOT NULL THEN
      DELETE FROM "ShardReservations" d
        WHERE (d.cluster, d.holder) = (target_cluster, expired.holder);
      UPDATE "ShardReservations"
        SET shard = expired.shard
        WHERE (cluster, holder) = (target_cluster, target_holder)
        RETURNING expired.shard INTO r.shard;
    END IF;
  END IF;

  RETURN r;
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "reshard_ShardReservations"(
  target_cluster text,
  reshard_interval interval,
  now timestamptz
)
RETURNS timestamp with time zone AS $$
DECLARE
    r RECORD;
    reshardAt timestamp with time zone;
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

DROP FUNCTION register_shard(text, text, interval);

CREATE OR REPLACE FUNCTION "reshard_ShardReservations"(
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