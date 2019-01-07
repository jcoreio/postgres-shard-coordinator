/**
 * @flow
 * @prettier
 */

import path from 'path'
import Umzug, { type Migration } from 'umzug'
import logger from 'log4jcore'
import { Client } from 'pg'
import UmzugPostgresStorage from './util/UmzugPostgresStorage'

const log = logger('postgres-shard-coordinator:migrate')

type Options = {
  storageOptions: {
    database: {
      database: string,
      user: string,
      password: string,
      host: string,
      port: number,
    },
    relation: string,
    column: string,
  },
}

const migrationsDir = path.join(__dirname, 'migrations')

export default function createUmzug({ storageOptions }: Options): Umzug {
  const query = async (sql: string): Promise<any> => {
    const client = new Client(storageOptions.database)
    try {
      await client.connect()
      return await client.query(sql)
    } finally {
      await client.end()
    }
  }

  return new Umzug({
    logging: log.info.bind(log),
    storage: new UmzugPostgresStorage(storageOptions),
    migrations: {
      params: [],
      path: migrationsDir,
      traverseDirectories: true,
      pattern: /^\d+[\w-]+\.sql$/,
      customResolver(file: string): Migration {
        const code = require('fs').readFileSync(file, 'utf8')
        const [up, down] = code.split(/^-- down.*$/im).map(s => s.trim())
        if (!up) {
          throw new Error(`${path.basename(file)}: up SQL not found`)
        }
        if (!down) {
          throw new Error(`${path.basename(file)}: down SQL not found`)
        }
        return {
          up: () => query(up),
          down: () => query(down),
        }
      },
    },
  })
}
