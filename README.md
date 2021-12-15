# @jcoreio/postgres-shard-coordinator

[![CircleCI](https://circleci.com/gh/jcoreio/postgres-shard-coordinator.svg?style=svg&circle-token=b008aa0f99297a9d8fb7ac7d0d1329b1a1e16f95)](https://circleci.com/gh/jcoreio/postgres-shard-coordinator)
[![Coverage Status](https://codecov.io/gh/jcoreio/postgres-shard-coordinator/branch/master/graph/badge.svg)](https://codecov.io/gh/jcoreio/postgres-shard-coordinator)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![Commitizen friendly](https://img.shields.io/badge/commitizen-friendly-brightgreen.svg)](http://commitizen.github.io/cz-cli/)
[![npm version](https://badge.fury.io/js/%40jcoreio%2Fpostgres-shard-coordinator.svg)](https://badge.fury.io/js/%40jcoreio%2Fpostgres-shard-coordinator)

Helps processes pick a unique shard index and determine the number of shards,
using Postgres to coordinate registration.

# Introduction

This is designed for any situation where batch processing needs to be divided
between multiple processes using hash-based sharding. For example, Clarity uses
multiple processes to handle the notification queue; each process restricts
itself to events where

```
  knuth_hash(userId) % numShards >= (shard * MAX_USER_ID) / numShards &&
  knuth_hash(userId) % numShards < ((shard + 1) * MAX_USER_ID) / numShards
```

Each of these processes can use `@jcoreio/postgres-shard-coordinator` to pick a unique
`shard` index and determine the total `numShards` (number of processes) in a
decentralized fashion that automatically adapts as processes are spawned or die.

# Usage

```
npm i --save @jcoreio/postgres-shard-coordinator
```

## Database migration

You will need to perform provided migrations to create the tables and functions
for coordination:

```js
import { Client } from 'pg'
import Umzug from 'umzug'
import { umzugMigrationOptions } from '@jcoreio/postgres-shard-coordinator'

export default async function migrate({ database }) {
  const umzug = new Umzug({
    storage: 'umzug-postgres-storage',
    storageOptions: {
      database,
      relation: '"SequelizeMeta"',
      column: 'name',
    },
    migrations: {
      ...umzugMigrationOptions(),
      params: [{ query }],
    },
  })

  await umzug.up()
}

async function query(sql) {
  const client = new Client(database)
  try {
    await client.connect()
    migrationDebug(sql)
    return await client.query(sql)
  } finally {
    await client.end()
  }
}
```

## Shard registration

```js
import { ShardRegistrar } from '@jcoreio/postgres-shard-coordinator'
import requireEnv from '@jcoreio/require-env'
import migrate from './migrate'

const database = {
  user: requireEnv('DB_USER'),
  host: requireEnv('DB_HOST'),
  database: requireEnv('DB_NAME'),
  password: requireEnv('DB_PASSWORD'),
  port: parseInt(requireEnv('DB_PORT')),
  native: true, // optional, use pg-native
}

const registrar = new ShardRegistrar({
  database,
  cluster: 'clarity_notifications',
  heartbeatInterval: 60, // seconds
  gracePeriod: 30, // seconds
  reshardInterval: 60, // seconds
})

registrar.on('shardChanged', ({ shard, numShards }) => {
  // reconfigure the notification queue processor
})
registrar.on('error', (err) => console.error(err.stack))

migrate({ database }).then(() => registrar.start())
```
