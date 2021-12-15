// @flow

import requireEnv from '@jcoreio/require-env'
import { type ShardRegistrarOptions } from '../src'

export const database: $PropertyType<ShardRegistrarOptions, 'database'> = {
  user: requireEnv('DB_USER'),
  host: requireEnv('DB_HOST'),
  database: requireEnv('DB_NAME'),
  password: requireEnv('DB_PASSWORD'),
  port: parseInt(requireEnv('DB_PORT')),
}
