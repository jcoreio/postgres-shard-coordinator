import requireEnv from '@jcoreio/require-env'

export const database = {
  user: 'postgres',
  host: 'localhost',
  database: 'postgres',
  password: 'password',
  port: parseInt(requireEnv('DB_PORT')),
}
