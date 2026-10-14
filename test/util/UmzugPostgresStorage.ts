type Config = {
  pool: { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> }
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

  async query(sql: string) {
    await this.config.pool.query(`
        CREATE TABLE IF NOT EXISTS ${this.config.relation} (
            "${this.config.column}" character varying(255)
        );
      `)
    return await this.config.pool.query(sql)
  }

  async logMigration(migrationName: string) {
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

  async unlogMigration(migrationName: string) {
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
    return rows.map((row) => String(row[this.config.column]))
  }
}
