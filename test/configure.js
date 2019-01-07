/* eslint-env node */

import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import createUmzug from '../src/umzug'
import { Client } from 'pg'
import { before, after, beforeEach } from 'mocha'
import ShardReservation from '../src/schema/ShardReservation'
import { database } from './database'

chai.use(chaiAsPromised)

if (process.argv.indexOf('--watch') >= 0) {
  before(() => process.stdout.write('\u001b[2J\u001b[1;1H\u001b[3J'))
}

const client = new Client(database)

before(async function(): Promise<void> {
  await client.connect()
  const umzug = createUmzug({
    storageOptions: {
      database,
      relation: '"SequelizeMeta"',
      column: 'name',
    },
  })
  await umzug.down()
  await umzug.up()
})

beforeEach(async function(): Promise<void> {
  await client.query(`TRUNCATE ${ShardReservation.tableName} CASCADE;`)
})

after(async function(): Promise<void> {
  await client.end()
})
