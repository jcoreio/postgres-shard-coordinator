CREATE OR REPLACE FUNCTION register_shard(
  target_cluster text,
  target_holder uuid,
  time_to_live interval,
  now timestamptz
)
RETURNS "ShardReservations" AS $$
DECLARE
  c "ShardReservationClusters";
  r "ShardReservations";
  expired "ShardReservations";
BEGIN
  -- aquire an exclusive lock on the cluster
  SELECT cluster INTO c FROM "ShardReservationClusters"
    WHERE cluster = target_cluster
    FOR UPDATE;

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

-- down

CREATE OR REPLACE FUNCTION register_shard(
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