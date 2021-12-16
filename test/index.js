// @flow
import {
  ShardRegistrar,
  type ShardRegistrarOptions,
  umzugMigrationOptions,
} from '../src'
import { database } from './database'
import { describe, it, afterEach, before, beforeEach } from 'mocha'
import { expect } from 'chai'
import emitted from 'p-event'
import delay from 'delay'
import { range } from 'lodash'
import { Client } from 'pg'
import Umzug from 'umzug'
import UmzugPostgresStorage from './util/UmzugPostgresStorage'
import poll from '@jcoreio/poll'

async function prepareTestDatabase(): Promise<void> {
  let client
  await poll(async (): Promise<void> => {
    client = new Client({ ...database, database: 'postgres' })
    await client.connect()
    await client.end()
  }, 1000).timeout(15000)
  // try {
  //   const {
  //     rows: [{ database_exists }],
  //   } = await client.query({
  //     text: `SELECT EXISTS (SELECT FROM pg_database WHERE datname = $1) AS database_exists`,
  //     values: [database.database],
  //   })
  //   if (!database_exists) {
  //     await client.query(`CREATE DATABASE ${database.database};`)
  //   }
  // } finally {
  //   await client.end()
  // }

  client = new Client({ ...database })
  await client.connect()
  try {
    await client.query(`DROP SCHEMA IF EXISTS public CASCADE;`)
    await client.query(`CREATE SCHEMA public;`)
  } finally {
    await client.end()
  }
}

before(async function (): Promise<void> {
  this.timeout(30000)

  await prepareTestDatabase()
})

beforeEach(async function (): Promise<void> {
  this.timeout(30000)
  const client = new Client({ ...database })
  await client.connect()

  const umzug = new Umzug({
    storage: new UmzugPostgresStorage({ database }),
    storageOptions: {
      database: database.database,
      relation: '"SequelizeMeta"',
      column: 'name',
    },
    migrations: {
      ...umzugMigrationOptions(),
      params: [{ query: (sql: string) => client.query(sql) }],
    },
  })

  try {
    await umzug.up()
  } finally {
    await client.end()
  }
})

describe('ShardRegistrar', function () {
  this.timeout(30000)
  let registrars = []

  beforeEach(async function (): Promise<void> {
    registrars = []
  })
  afterEach(async function (): Promise<void> {
    await Promise.all(registrars.map((registrar) => registrar.stop()))
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
    const options = {
      database,
      cluster,
      heartbeatInterval,
      gracePeriod,
      reshardInterval,
    }
    const registrar1 = createRegistrar(options)
    const registrar2 = createRegistrar(options)
    const registrar3 = createRegistrar(options)

    await Promise.all([
      expect(emitted(registrar1, 'shardChanged')).to.eventually.deep.equal({
        shard: 0,
        numShards: 1,
      }),
      registrar1.start(),
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
    ])

    await delay(heartbeatInterval * 3000)
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
    ])
  })
  it(`two clusters of registrars operating simultaneously`, async function (): Promise<void> {
    const heartbeatInterval = 1
    const gracePeriod = 3
    const reshardInterval = 5
    const numShards = 10
    const clusterA = range(numShards).map(() =>
      createRegistrar({
        database,
        cluster: 'a',
        heartbeatInterval,
        gracePeriod,
        reshardInterval,
      })
    )
    const clusterB = range(numShards).map(() =>
      createRegistrar({
        database,
        cluster: 'b',
        heartbeatInterval,
        gracePeriod,
        reshardInterval,
      })
    )
    const aEvents = Promise.all(
      clusterA.map((registrar) =>
        emitted(registrar, 'shardChanged', (e) => e.numShards === numShards)
      )
    )
    const bEvents = Promise.all(
      clusterB.map((registrar) =>
        emitted(registrar, 'shardChanged', (e) => e.numShards === numShards)
      )
    )

    await Promise.all([
      aEvents,
      bEvents,
      ...clusterA.map((registrar) => registrar.start()),
      ...clusterB.map((registrar) => registrar.start()),
    ])

    expect((await aEvents).map((e) => e.shard).sort()).to.deep.equal(
      range(numShards)
    )
    expect((await bEvents).map((e) => e.shard).sort()).to.deep.equal(
      range(numShards)
    )
  })
})
