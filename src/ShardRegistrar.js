/**
 * @flow
 * @prettier
 */
import EventEmitter from '@jcoreio/typed-event-emitter'
import uuidv4 from 'uuid/v4'
import debug from 'debug'
import ShardReservationCluster from './schema/ShardReservationCluster'
import ShardReservation from './schema/ShardReservation'

const RESHARD_DEBUG = debug.enabled('ShardRegistrar:reshard')

export type ShardRegistrarEvents = {|
  shardChanged: [{| shard: number, numShards: number |}],
  error: [Error],
|}

type PgResult = $ReadOnly<{
  rows: { [string]: any }[],
  ...
}>

type PgListener = (channel: string, payload: any) => any

interface PgIpc {
  notify(channel: string, payload?: any): Promise<void>;
  listen(channel: string, listener: PgListener): Promise<void>;
  unlisten(channel: string, listener: PgListener): Promise<void>;
}

interface PgPool {
  query(sql: string, params?: any[]): Promise<PgResult>;
}

export type ShardRegistrarOptions = $ReadOnly<{
  cluster: string,
  pool: PgPool,
  ipc: PgIpc,
  heartbeatInterval: number,
  gracePeriod: number,
  reshardInterval: number,
  ...
}>

export default class ShardRegistrar extends EventEmitter<ShardRegistrarEvents> {
  _options: ShardRegistrarOptions
  _heartbeatTimeout: ?TimeoutID
  _holder: string = uuidv4()
  _pool: PgPool
  _ipc: PgIpc
  _shard: ?number
  _numShards: ?number
  _running: boolean = false
  _debug: any = debug(`ShardRegistrar:${this._holder.substring(0, 8)}`)
  _upsertedCluster: boolean = false
  _lastQuery: ?Promise<PgResult>

  constructor(options: ShardRegistrarOptions) {
    super()
    this._options = options
    this._pool = options.pool
    this._ipc = options.ipc
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
    this._ipc.listen(`shardInfo/${this._holder}`, this._onNotification)
    this._onHeartbeat()
  }

  async stop(): Promise<void> {
    if (!this._running) return
    this._running = false
    if (this._heartbeatTimeout != null) clearTimeout(this._heartbeatTimeout)
    this._ipc.unlisten(`shardInfo/${this._holder}`, this._onNotification)
    try {
      await this._lastQuery
    } catch (error) {
      // ignore
    }
  }

  _onError: (err: Error) => any = (err: Error) => this.emit('error', err)

  _setShard({ shard, numShards }: { shard: number, numShards: number }) {
    if (shard !== this._shard || numShards !== this._numShards) {
      this._shard = shard
      this._numShards = numShards
      this.emit('shardChanged', { shard, numShards })
    }
  }

  _onNotification: (channel: string, payload: any) => any = (
    channel: string,
    payload: any
  ) => {
    this._debug(channel, payload)
    try {
      if (!payload) {
        throw new Error(
          `received invalid payload from Postgres channel "${channel}": ${String(
            payload
          )}`
        )
      }
      const { shard, numShards } = payload
      if (typeof shard !== 'number' || typeof numShards !== 'number') {
        throw new Error(
          `received invalid payload from Postgres channel "${channel}": ${String(
            payload
          )}`
        )
      }
      this._setShard({ shard, numShards })
    } catch (error) {
      this.emit('error', error)
    }
  }

  _onHeartbeat: () => Promise<void> = async (): Promise<void> => {
    let nextTime = Date.now() + this._options.heartbeatInterval * 1000
    const reshardAt: ?Date = await this._register()
    if (reshardAt) nextTime = Math.min(nextTime, reshardAt.getTime())
    const delay = Math.max(0, nextTime - Date.now())
    if (this._running) {
      this._heartbeatTimeout = setTimeout(this._onHeartbeat, delay)
    }
  }

  async _query(sql: string, params?: Array<any>): Promise<PgResult> {
    this._debug(sql, params)
    if (!this._running) throw new Error('already stopped')
    const result = await (this._lastQuery = this._pool.query(sql, params))
    this._debug(result.rows)
    return result
  }

  async _register(): Promise<?Date> {
    const { _holder: holder } = this
    const { cluster, heartbeatInterval, gracePeriod } = this._options
    const interval = `${heartbeatInterval + gracePeriod} seconds`
    const reshardInterval = `${this._options.reshardInterval} seconds`

    try {
      if (!this._upsertedCluster) {
        await this._query(upsertClusterQuery, [cluster])
        this._upsertedCluster = true
      }
      await this._query(registerQuery, [cluster, holder, interval])
      const {
        rows: [{ isCoordinator }],
      } = await this._query(selectIsCoordinatorQuery, [holder, cluster])
      let reshardAt: ?Date
      if (isCoordinator) {
        ;({
          rows: [{ reshardAt }],
        } = (await this._query(
          `SELECT "reshard_ShardReservations"($1, $2::interval) AS "reshardAt";`,
          [cluster, reshardInterval]
        ): any))
        if (RESHARD_DEBUG) {
          const { rows } = await this._query(
            `SELECT * FROM ${ShardReservation.tableName} WHERE ${ShardReservation.cluster} = $1 ORDER BY ${ShardReservation.shard} NULLS LAST, ${ShardReservation.holder}`,
            [cluster]
          )
          console.table(rows) // eslint-disable-line no-console
        }
      }

      return reshardAt
    } catch (error) {
      if (this._running) this.emit('error', error)
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

const registerQuery = `
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
    ORDER BY ${ShardReservation.shard} NULLS LAST, ${ShardReservation.holder}
    LIMIT 1
  ) AS "isCoordinator";
`
  .trim()
  .replace(/\s+/g, ' ')
