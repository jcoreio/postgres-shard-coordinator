// @flow

import requireEnv from '@jcoreio/require-env'

export const database = {
  user: requireEnv('DB_USER'),
  host: requireEnv('DB_HOST'),
  database: requireEnv('DB_NAME'),
  password: requireEnv('DB_PASSWORD'),
  port: parseInt(requireEnv('DB_PORT')),
}
