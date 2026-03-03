/**
 * ATLAS PostgreSQL Adapter (ATLAS-12)
 * Drop-in replacement for better-sqlite3 when storage.database = "postgres".
 *
 * Usage in config.yml:
 *   storage:
 *     database: postgres
 *     path: "postgresql://user:pass@localhost:5432/atlas"
 *
 * The adapter wraps pg.Pool with a synchronous-looking interface
 * (using synchronous execution is not possible with pg, so this module
 * is async-native and Atlas switches to async paths when pg is active).
 */
import pg from 'pg';
const { Pool } = pg;

export class PgAdapter {
  constructor(connectionString) {
    this.pool = new Pool({ connectionString });
    this._isSqlite = false;
  }

  async exec(sql) {
    const client = await this.pool.connect();
    try {
      // Split on semicolons for multi-statement exec
      const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
      for (const stmt of statements) {
        // Convert SQLite-specific syntax to PostgreSQL
        const pgSql = this._toPostgres(stmt);
        if (pgSql) await client.query(pgSql);
      }
    } finally { client.release(); }
  }

  prepare(sql) {
    const pgSql = this._toPostgres(sql);
    const pool  = this.pool;
    return {
      run: async (...params) => {
        const { rowCount } = await pool.query(pgSql, params);
        return { changes: rowCount };
      },
      get: async (...params) => {
        const { rows } = await pool.query(pgSql + ' LIMIT 1', params);
        return rows[0] ?? null;
      },
      all: async (...params) => {
        const { rows } = await pool.query(pgSql, params);
        return rows;
      },
    };
  }

  pragma() {} // no-op for pg

  _toPostgres(sql) {
    if (!sql) return null;
    return sql
      .replace(/JSON NOT NULL/g, 'JSONB NOT NULL')
      .replace(/JSON$/g, 'JSONB')
      .replace(/INTEGER DEFAULT \(datetime\('now'\)\)/g, 'TIMESTAMPTZ DEFAULT NOW()')
      .replace(/TEXT DEFAULT \(datetime\('now'\)\)/g, 'TIMESTAMPTZ DEFAULT NOW()')
      .replace(/datetime\('now'\)/g, 'NOW()')
      .replace(/CREATE VIEW IF NOT EXISTS (\w+) AS SELECT \* FROM (\w+)/g,
        'CREATE OR REPLACE VIEW $1 AS SELECT * FROM $2')
      .replace(/ON CONFLICT\((\w+)\) DO UPDATE SET/g, 'ON CONFLICT ($1) DO UPDATE SET')
      .replace(/\?/g, () => { this._paramIdx = (this._paramIdx || 0) + 1; return `$${this._paramIdx}`; });
  }
}
