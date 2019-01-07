module.exports = function(env) {
  env.setDefaults({
    DB_HOST: 'localhost',
    DB_USER: 'postgres',
    DB_PORT: '5432',
    DB_NAME: 'postgres_shard_coordinator_test',
    DB_PASSWORD: 'password',
  })
}
