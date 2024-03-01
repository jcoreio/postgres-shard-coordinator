import { Client } from 'pg'

type Config = {
  database: {
    user: string
    host: string
    database: string
    password: string
    port: number
  }
  column: string
  relation: string
}

export default class UmzugPostgresStorage {
  config: Config
  constructor(config: Config | { storageOptions: Config }) {
    if ('storageOptions' in config) {
      this.config = config.storageOptions
    } else {
      this.config = config
    }
  }

  async query(sql) {
    const client = new Client(this.config.database)
    try {
      await client.connect()
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.config.relation} (
            "${this.config.column}" character varying(255)
        );
      `)
      return await client.query(sql)
    } finally {
      await client.end()
    }
  }

  async logMigration(migrationName) {
    await this.query(`
      INSERT INTO ${this.config.relation}
        ("${this.config.column}")
      SELECT '${migrationName}'
        WHERE NOT EXISTS (
          SELECT "${this.config.column}" FROM ${this.config.relation}
          WHERE "${this.config.column}" = '${migrationName}'
        );
    `)
  }

  async unlogMigration(migrationName) {
    await this.query(`
      DELETE FROM ${this.config.relation}
      WHERE "${this.config.column}" = '${migrationName}'
    `)
  }

  async executed() {
    const { rows } = await this.query(`
      SELECT "${this.config.column}"
      FROM ${this.config.relation}
      ORDER BY "${this.config.column}" ASC;
    `)
    return rows.map((row) => row[this.config.column])
  }
}
