// @flow

import requireEnv from '@jcoreio/require-env'
import { type ShardRegistrarOptions } from '../src'

export const database: $PropertyType<ShardRegistrarOptions, 'database'> = {
  user: 'postgres',
  host: 'localhost',
  database: 'postgres',
  password: 'password',
  port: parseInt(requireEnv('DB_PORT')),
}
