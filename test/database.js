// @flow

import requireEnv from '@jcoreio/require-env'

export const database: {|
  user: string,
  host: string,
  database: string,
  password: string,
  port: number,
|} = {
  user: 'postgres',
  host: 'localhost',
  database: 'postgres',
  password: 'password',
  port: parseInt(requireEnv('DB_PORT')),
}
