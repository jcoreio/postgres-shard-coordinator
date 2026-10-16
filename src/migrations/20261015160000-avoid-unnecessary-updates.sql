CREATE OR REPLACE FUNCTION "reshard_ShardReservations"(
  target_cluster text,
  reshard_interval interval,
  now timestamptz
)
RETURNS timestamp with time zone AS $$
DECLARE
    r RECORD;
    reshardAt timestamp with time zone;
    num_shards_before int;
    num_shards_after int;
    changed boolean;
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

  SELECT COUNT(*) INTO num_shards_before
    FROM "ShardReservations"
    WHERE cluster = target_cluster
      AND shard IS NOT NULL;

  DELETE FROM "ShardReservations"
    WHERE "cluster" = target_cluster
      AND "expiresAt" <= now;

  SELECT COUNT(*) INTO num_shards_after
    FROM "ShardReservations"
    WHERE cluster = target_cluster;

  changed = false;

  FOR r IN UPDATE "ShardReservations" updated
    SET shard = src.shard
    FROM (
    SELECT holder, shard as prev_shard, row_number() OVER (
        PARTITION BY "cluster"
        ORDER BY shard NULLS LAST, holder
      ) - 1 AS shard,
      COUNT(*) OVER (PARTITION BY "cluster") AS "numShards"
      FROM "ShardReservations"
      WHERE "cluster" = target_cluster
    ) AS src
    WHERE updated."cluster" = target_cluster
      AND updated.holder = src.holder
      AND (updated.shard IS DISTINCT FROM src.shard OR num_shards_before != num_shards_after)
    RETURNING updated.holder, updated.shard, src."numShards", src.prev_shard
  LOOP
    IF num_shards_before != num_shards_after OR r.prev_shard IS DISTINCT FROM r.shard THEN
      changed = true;
      PERFORM pg_notify(
        'shardInfo/' || r.holder,
        json_build_object('shard', r.shard, 'numShards', r."numShards") #>> '{}'
      );
    END IF;
  END LOOP;

  IF changed THEN
    UPDATE "ShardReservationClusters"
      SET "reshardedAt" = now
      WHERE "cluster" = target_cluster;
  END IF;

  RETURN NULL;
END;
$$
LANGUAGE plpgsql;

-- down

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
