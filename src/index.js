/**
 * @flow
 * @prettier
 */
import EventEmitter from '@jcoreio/typed-event-emitter'
import { Client, type Result } from 'pg'
import uuidv4 from 'uuid/v4'
import debug from 'debug'
import { throttle } from 'lodash'

import ShardReservationCluster from './schema/ShardReservationCluster'

import ShardReservation from './schema/ShardReservation'

type Events = {
  shardChanged: [{ shard: number, numShards: number }],
}

export type ShardRegistrarOptions = {
  cluster: string,
  database: {
    database: string,
    user: string,
    password: string,
    host: string,
    port: number,
  },
  heartbeatInterval: number,
  gracePeriod: number,
}

export class ShardRegistrar extends EventEmitter<Events> {
  _options: ShardRegistrarOptions
  _heartbeatTimeout: ?TimeoutID
  _holder: string = uuidv4()
  _client: Client
  _shard: ?number
  _numShards: ?number
  _running: boolean = false
  _debug = debug(this._holder.substring(0, 8))
  _upsertedCluster: boolean = false
  _lastQuery: ?Promise<any>

  constructor(options: ShardRegistrarOptions) {
    super()
    this._options = options
    this._client = new Client(options.database)
  }

  shardInfo(): { shard: number, numShards: number } {
    const shard = this._shard
    const numShards = this._numShards
    if (shard == null || numShards == null) {
      throw new Error('no shard has been reserved')
    }
    return { shard, numShards }
  }

  async start(): Promise<void> {
    if (this._running) return
    this._running = true
    this._upsertedCluster = false
    const { _holder: holder } = this
    await this._client.connect()
    this._client.on('notification', this._onNotification)
    this._client.on('error', this._onError)
    await this._query(`LISTEN "shardInfo/${holder}"`)
    this._onHeartbeat()
  }

  async stop(): Promise<void> {
    if (!this._running) return
    this._running = false
    if (this._heartbeatTimeout != null) clearTimeout(this._heartbeatTimeout)
    this._client.removeListener('notification', this._onNotification)
    try {
      await this._lastQuery
    } catch (error) {
      // ignore
    }
    await this._client.end()
    this._client.removeListener('error', this._onError)
    this._client = new Client(this._options.database)
  }

  _onError = (err: Error) => console.error(err.stack) // eslint-disable-line no-console

  _setShard({ shard, numShards }: { shard: number, numShards: number }) {
    if (shard !== this._shard || numShards !== this._numShards) {
      this._shard = shard
      this._numShards = numShards
      this.emit('shardChanged', { shard, numShards })
    }
  }

  _onNotification = throttle(
    ({ channel, payload }: { channel: string, payload: string }) => {
      this._debug(channel, payload)
      const obj = JSON.parse(payload)
      // istanbul ignore next
      if (!obj) return
      const { shard, numShards } = obj
      // istanbul ignore next
      if (typeof shard !== 'number' || typeof numShards !== 'number') return
      this._setShard({ shard, numShards })
    },
    1000
  )

  _onHeartbeat = async (): Promise<void> => {
    let startTime = Date.now()
    let delay
    this._register().catch((err: Error) => {
      console.error(err.stack) // eslint-disable-line no-console
      delay = 100
    })
    delay = Math.max(
      0,
      startTime + this._options.heartbeatInterval * 1000 - Date.now()
    )
    if (this._running) {
      this._heartbeatTimeout = setTimeout(this._onHeartbeat, delay)
    }
  }

  async _query(sql: string, params?: Array<any>): Promise<Result> {
    this._debug(sql, params)
    if (!this._running) throw new Error('already stopped')
    const result = await (this._lastQuery = this._client.query(sql, params))
    this._debug(result.rows)
    return result
  }

  async _register(): Promise<void> {
    const { _holder: holder } = this
    const { cluster, heartbeatInterval, gracePeriod } = this._options

    try {
      if (!this._upsertedCluster) {
        await this._query(upsertClusterQuery, [cluster])
        this._upsertedCluster = true
      }

      await this._query('BEGIN;')
      const interval = `${heartbeatInterval + gracePeriod} seconds`
      let result

      await this._query(lockQuery, [cluster])

      result = await this._query(upsertQuery, [cluster, holder, interval])

      let reshard = result.rows[0].shard == null

      const {
        rows: [{ isCoordinator }],
      } = await this._query(selectIsCoordinatorQuery, [holder, cluster])

      if (isCoordinator) {
        result = await this._query(deleteExpiredQuery, [cluster])
        if (result.rowCount) reshard = true
      }
      if (reshard) {
        await this._query(`SELECT "reshard_ShardReservations"($1);`, [cluster])
      }

      await this._query('COMMIT;')
    } catch (error) {
      await this._query('ROLLBACK;').catch(() => {})
      throw error
    }
  }
}

const upsertClusterQuery = `
INSERT INTO ${ShardReservationCluster.tableName} (
    ${ShardReservationCluster.cluster}
  )
  VALUES ($1)
  ON CONFLICT (${ShardReservationCluster.cluster}) DO NOTHING;
`
  .trim()
  .replace(/\s+/g, ' ')

const lockQuery = `
SELECT 1
  FROM ${ShardReservation.tableName}
  WHERE ${ShardReservation.cluster} = $1
  FOR UPDATE;
`
  .trim()
  .replace(/\s+/g, ' ')

const upsertQuery = `
INSERT INTO ${ShardReservation.tableName} (
    ${ShardReservation.cluster},
    ${ShardReservation.holder},
    ${ShardReservation.expiresAt}
  )
  VALUES (
    $1,
    $2,
    CURRENT_TIMESTAMP + $3::interval
  )
  ON CONFLICT (${ShardReservation.holder}) DO UPDATE
    SET ${ShardReservation.expiresAt} = CURRENT_TIMESTAMP + $3::interval,
      ${ShardReservation.shard} = CASE
        WHEN ${ShardReservation.tableName}.${ShardReservation.expiresAt}
          <= CURRENT_TIMESTAMP
        THEN NULL
        ELSE ${ShardReservation.tableName}.${ShardReservation.shard}
      END
  RETURNING ${ShardReservation.tableName};
`
  .trim()
  .replace(/\s+/g, ' ')

const selectIsCoordinatorQuery = `
SELECT $1 = (
  SELECT ${ShardReservation.holder} FROM ${ShardReservation.tableName}
    WHERE ${ShardReservation.cluster} = $2
      AND ${ShardReservation.expiresAt} > CURRENT_TIMESTAMP
    ORDER BY ${ShardReservation.shard}
    LIMIT 1
  ) AS "isCoordinator";
`
  .trim()
  .replace(/\s+/g, ' ')

const deleteExpiredQuery = `
DELETE FROM ${ShardReservation.tableName}
  WHERE ${ShardReservation.cluster} = $1
    AND ${ShardReservation.expiresAt} <= CURRENT_TIMESTAMP;
`
  .trim()
  .replace(/\s+/g, ' ')
