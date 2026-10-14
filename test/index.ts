import {
  ShardRegistrar,
  type ShardRegistrarOptions,
  umzugMigrationOptions,
} from '../src'
import { database } from './database'
import { describe, it, after, afterEach, before, beforeEach } from 'mocha'
import { expect } from 'chai'
// @ts-expect-error not dealing with types for now
import emitted from 'p-event'
import delay from 'delay'
import { range } from 'lodash'
import { Client, Pool } from 'pg'
import PgIpc from '@jcoreio/pg-ipc'
import Umzug from 'umzug'
import UmzugPostgresStorage from './util/UmzugPostgresStorage'
import poll from '@jcoreio/poll'
import { ShardReservation } from '../src/schema/ShardReservation'
import { ShardReservationCluster } from '../src/schema/ShardReservationCluster'
import { createClock } from '@sinonjs/fake-timers'
import _debug from 'debug'

const debug = _debug('ShardRegistrar:test')

async function prepareTestDatabase(): Promise<void> {
  await poll(async (): Promise<void> => {
    const client = new Client({ ...database, database: 'postgres' })
    await client.connect()
    await client.end()
  }, 1000).timeout(15000)

  const client = new Client({ ...database })
  await client.connect()
  try {
    await client.query(`DROP SCHEMA IF EXISTS public CASCADE;`)
    await client.query(`CREATE SCHEMA public;`)
  } finally {
    await client.end()
  }
}

const pool = new Pool({ ...database })
// eslint-disable-next-line no-console
pool.on('error', (error) => console.error(error.stack))

const ipc = new PgIpc({
  // @ts-expect-error ugh
  newClient: () => new Client({ ...database }),
})
// eslint-disable-next-line no-console
ipc.on('error', (error) => console.error(error.stack))

before(async function (): Promise<void> {
  this.timeout(30000)

  await prepareTestDatabase()
})

beforeEach(async function (): Promise<void> {
  this.timeout(30000)

  const storageOptions = {
    pool,
    relation: '"SequelizeMeta"',
    column: 'name',
  }

  const umzug = new Umzug({
    storage: new UmzugPostgresStorage(storageOptions),
    // @ts-expect-error not worth messing with
    migrations: {
      ...umzugMigrationOptions({ pool }),
    },
  })

  await umzug.up()
})

after(() => Promise.all([pool.end(), ipc.end()]))

describe('ShardRegistrar', function () {
  this.timeout(30000)
  let registrars: ShardRegistrar[] = []

  beforeEach(async function (): Promise<void> {
    registrars = []
    await pool.query(`DELETE FROM ${ShardReservation.tableName};`)
    await pool.query(`DELETE FROM ${ShardReservationCluster.tableName};`)
  })
  afterEach(async function (): Promise<void> {
    for (const registrar of registrars) await registrar.stop()
  })

  function createRegistrar(options: ShardRegistrarOptions): ShardRegistrar {
    const registrar = new ShardRegistrar(options)
    registrars.push(registrar)
    return registrar
  }

  it('sequential three node test', async function (): Promise<void> {
    const cluster = 'a'
    const heartbeatInterval = 1
    const gracePeriod = 3
    const reshardInterval = 5
    const clock = createClock(Date.now())
    const tickSeconds = async (seconds: number) => {
      while (seconds) {
        await delay(10)
        await clock.tickAsync(Math.min(seconds, 1) * 1000)
        debug('ticked to', new Date(clock.now))
        seconds = Math.max(seconds - 1, 0)
      }
    }
    const options = {
      pool,
      ipc,
      cluster,
      heartbeatInterval,
      gracePeriod,
      reshardInterval,
      clock,
    }
    const registrar1 = createRegistrar({ ...options, name: 'registrar1' })
    const registrar2 = createRegistrar({ ...options, name: 'registrar2' })
    const registrar3 = createRegistrar({ ...options, name: 'registrar3' })

    await Promise.all([
      expect(emitted(registrar1, 'shardChanged')).to.eventually.deep.equal({
        shard: 0,
        numShards: 1,
      }),
      registrar1.start(),
      tickSeconds(reshardInterval),
    ])

    await Promise.all([
      expect(emitted(registrar1, 'shardChanged')).to.eventually.deep.equal({
        shard: 0,
        numShards: 2,
      }),
      expect(emitted(registrar2, 'shardChanged')).to.eventually.deep.equal({
        shard: 1,
        numShards: 2,
      }),
      registrar2.start(),
      tickSeconds(reshardInterval),
    ])

    await tickSeconds(heartbeatInterval)
    expect(registrar1.shardInfo()).to.deep.equal({
      shard: 0,
      numShards: 2,
    })
    expect(registrar2.shardInfo()).to.deep.equal({
      shard: 1,
      numShards: 2,
    })

    await Promise.all([
      expect(emitted(registrar2, 'shardChanged')).to.eventually.deep.equal({
        shard: 0,
        numShards: 1,
      }),
      registrar1.stop(),
      tickSeconds(reshardInterval),
    ])

    await Promise.all([
      expect(emitted(registrar1, 'shardChanged')).to.eventually.deep.equal({
        shard: 1,
        numShards: 2,
      }),
      expect(emitted(registrar2, 'shardChanged')).to.eventually.deep.equal({
        shard: 0,
        numShards: 2,
      }),
      registrar1.start(),
      tickSeconds(reshardInterval),
    ])

    await Promise.all([
      expect(emitted(registrar1, 'shardChanged')).to.eventually.deep.equal({
        shard: 1,
        numShards: 3,
      }),
      expect(emitted(registrar2, 'shardChanged')).to.eventually.deep.equal({
        shard: 0,
        numShards: 3,
      }),
      expect(emitted(registrar3, 'shardChanged')).to.eventually.deep.equal({
        shard: 2,
        numShards: 3,
      }),
      registrar3.start(),
      tickSeconds(reshardInterval),
    ])
  })
  it('new nodes claim expired slots', async function (): Promise<void> {
    const cluster = 'a'
    const heartbeatInterval = 1
    const gracePeriod = 3
    const reshardInterval = 10
    const clock = createClock(Date.now())
    const tickSeconds = async (seconds: number) => {
      while (seconds) {
        await delay(10)
        await clock.tickAsync(Math.min(seconds, 1) * 1000)
        debug('ticked to', new Date(clock.now))
        seconds = Math.max(seconds - 1, 0)
      }
    }
    const options = {
      pool,
      ipc,
      cluster,
      heartbeatInterval,
      gracePeriod,
      reshardInterval,
      clock,
    }
    const registrar1 = createRegistrar({ ...options, name: 'registrar1' })
    const registrar2 = createRegistrar({ ...options, name: 'registrar2' })
    const registrar3 = createRegistrar({ ...options, name: 'registrar3' })

    await Promise.all([
      expect(emitted(registrar1, 'shardChanged')).to.eventually.deep.equal({
        shard: 0,
        numShards: 1,
      }),
      registrar1.start(),
      tickSeconds(10.5),
    ])

    await Promise.all([
      expect(emitted(registrar1, 'shardChanged')).to.eventually.deep.equal({
        shard: 0,
        numShards: 2,
      }),
      expect(emitted(registrar2, 'shardChanged')).to.eventually.deep.equal({
        shard: 1,
        numShards: 2,
      }),
      registrar2.start(),
      tickSeconds(10.5),
    ])

    await tickSeconds(3)
    expect(registrar1.shardInfo()).to.deep.equal({
      shard: 0,
      numShards: 2,
    })
    expect(registrar2.shardInfo()).to.deep.equal({
      shard: 1,
      numShards: 2,
    })

    await registrar1.stop()
    await tickSeconds(4)

    await Promise.all([
      expect(emitted(registrar3, 'shardChanged')).to.eventually.deep.equal({
        shard: 0,
        numShards: 2,
      }),
      registrar3.start(),
      tickSeconds(5),
    ])
  })
  it(`single node unregister test`, async function () {
    const cluster = 'a'
    const heartbeatInterval = 1
    const gracePeriod = 3
    const reshardInterval = 5
    const clock = createClock(Date.now())
    const tickSeconds = async (seconds: number) => {
      while (seconds) {
        await delay(10)
        await clock.tickAsync(Math.min(seconds, 1) * 1000)
        debug('ticked to', new Date(clock.now))
        seconds = Math.max(seconds - 1, 0)
      }
    }
    const options = {
      pool,
      ipc,
      cluster,
      heartbeatInterval,
      gracePeriod,
      reshardInterval,
      clock,
    }
    const registrar1 = createRegistrar({ ...options, name: 'registrar1' })
    await Promise.all([
      expect(emitted(registrar1, 'shardChanged')).to.eventually.deep.equal({
        shard: 0,
        numShards: 1,
      }),
      registrar1.start(),
      tickSeconds(reshardInterval),
    ])
    await registrar1.stop({ unregister: true })

    const registrar2 = createRegistrar({ ...options, name: 'registrar2' })
    await Promise.all([
      expect(emitted(registrar2, 'shardChanged')).to.eventually.deep.equal({
        shard: 0,
        numShards: 1,
      }),
      registrar2.start(),
      tickSeconds(reshardInterval),
    ])
  })
  it(`two clusters of registrars operating simultaneously`, async function (): Promise<void> {
    const heartbeatInterval = 1
    const gracePeriod = 3
    const reshardInterval = 5
    const numShards = 10
    const clock = createClock(Date.now())
    const tickSeconds = async (seconds: number) => {
      while (seconds) {
        await delay(10)
        await clock.tickAsync(Math.min(seconds, 1) * 1000)
        debug('ticked to', new Date(clock.now))
        seconds = Math.max(seconds - 1, 0)
      }
    }
    const clusterA = range(numShards).map((i) =>
      createRegistrar({
        name: `clusterA[${i}]`,
        pool,
        ipc,
        cluster: 'a',
        heartbeatInterval,
        gracePeriod,
        reshardInterval,
        clock,
      })
    )
    const clusterB = range(numShards).map((i) =>
      createRegistrar({
        name: `clusterB[${i}]`,
        pool,
        ipc,
        cluster: 'b',
        heartbeatInterval,
        gracePeriod,
        reshardInterval,
        clock,
      })
    )
    const aEvents: Promise<{ shard: number; numShards: number }[]> =
      Promise.all(
        clusterA.map((registrar) =>
          emitted(
            registrar,
            'shardChanged',
            (e: { shard: number; numShards: number }) =>
              e.numShards === numShards
          )
        )
      )
    const bEvents: Promise<{ shard: number; numShards: number }[]> =
      Promise.all(
        clusterB.map((registrar) =>
          emitted(
            registrar,
            'shardChanged',
            (e: { shard: number; numShards: number }) =>
              e.numShards === numShards
          )
        )
      )

    await Promise.all([
      aEvents,
      bEvents,
      ...clusterA.map((registrar) => registrar.start()),
      ...clusterB.map((registrar) => registrar.start()),
      tickSeconds(reshardInterval),
    ])

    expect((await aEvents).map((e) => e.shard).sort()).to.deep.equal(
      range(numShards)
    )
    expect((await bEvents).map((e) => e.shard).sort()).to.deep.equal(
      range(numShards)
    )
  })
})
