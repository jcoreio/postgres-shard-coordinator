/**
 * @flow
 * @prettier
 */

import path from 'path'
const migrationsDir = path.join(__dirname, 'migrations')

export type MigrationParams = {
  query: (sql: string) => Promise<any>,
}

export interface Migration {
  up(MigrationParams): Promise<any>;
  down(MigrationParams): Promise<any>;
}

export default function umzugMigrationOptions(): {
  path: string,
  pattern: RegExp,
  customResolver(file: string): Migration,
} {
  return {
    path: migrationsDir,
    pattern: /^\d+-.+\.sql$/,
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
        up: ({ query }) => query(up),
        down: ({ query }) => query(down),
      }
    },
  }
}
