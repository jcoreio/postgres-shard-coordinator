/* eslint-env node */

import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Umzug from 'umzug'
import { umzugMigrationOptions } from '../src'
import { Client } from 'pg'
import { before, after, beforeEach } from 'mocha'
import { database } from './database'
import ShardReservationCluster from '../src/schema/ShardReservationCluster'
import UmzugPostgresStorage from './util/UmzugPostgresStorage'
import debug from 'debug'

const migrationDebug = debug('postgres-shard-coordinator:migrate')

chai.use(chaiAsPromised)

if (process.argv.indexOf('--watch') >= 0) {
  before(() => process.stdout.write('\u001b[2J\u001b[1;1H\u001b[3J'))
}

const client = new Client(database)

before(async function(): Promise<void> {
  await client.connect()

  const query = async (sql: string): Promise<any> => {
    const client = new Client(database)
    try {
      await client.connect()
      migrationDebug(sql)
      return await client.query(sql)
    } finally {
      await client.end()
    }
  }

  const umzug = new Umzug({
    logging: migrationDebug,
    storage: new UmzugPostgresStorage({
      database,
      relation: '"SequelizeMeta"',
      column: 'name',
    }),
    migrations: {
      ...umzugMigrationOptions(),
      params: [{ query }],
    },
  })

  await umzug.down()
  await umzug.up()
})

beforeEach(async function(): Promise<void> {
  await client.query(`TRUNCATE ${ShardReservationCluster.tableName} CASCADE;`)
})

after(async function(): Promise<void> {
  await client.end()
})
