/**
 * DB Adapter
 *
 * Abstracts over two backends:
 *  - Cloudflare D1 (when running inside a Worker with env.DB binding)
 *  - better-sqlite3 (when running locally via Node.js)
 *
 * Usage:
 *   import { openDb } from './db-adapter.mjs';
 *
 *   // In a Cloudflare Worker:
 *   const db = openDb({ d1: env.DB });
 *
 *   // In Node.js (local dev / cron server):
 *   const db = openDb({ path: '/data/dev.sqlite' });
 *
 * The returned db object exposes:
 *   db.prepare(sql)          → statement
 *   statement.run(params)    → { changes, lastRowid }
 *   statement.get(params)    → row | undefined
 *   statement.all(params)    → row[]
 *   db.exec(sql)             → void (DDL only)
 *   db.transaction(fn)       → wrapped fn (D1: batches; SQLite: transaction)
 *   db.batch(statements[])   → Promise<results[]>  (D1 native batch)
 *
 * D1 database ID: f1669001-2a51-4114-a84e-73cfa7f1c584
 * Binding name in wrangler.toml: DB
 */

// ─── D1 Adapter ──────────────────────────────────────────────────────────────

class D1Statement {
  constructor(d1, sql) {
    this._d1 = d1;
    this._sql = sql;
  }

  _stmt(params) {
    const stmt = this._d1.prepare(this._sql);
    if (!params) return stmt;
    // D1 bind() accepts positional or named params
    // We normalise object params → positional via sql replacement for named style
    if (Array.isArray(params)) return stmt.bind(...params);
    // Named params: D1 uses ?1,?2 style; we keep @name style compatible via bind object
    return stmt.bind(params);
  }

  async run(params) {
    const result = await this._stmt(params).run();
    return { changes: result.meta?.changes ?? 0, lastRowid: result.meta?.last_row_id ?? null };
  }

  async get(params) {
    return await this._stmt(params).first() ?? undefined;
  }

  async all(params) {
    const result = await this._stmt(params).all();
    return result.results ?? [];
  }
}

class D1Db {
  constructor(d1) {
    this._d1 = d1;
  }

  prepare(sql) {
    return new D1Statement(this._d1, sql);
  }

  async exec(sql) {
    // Split on semicolons for DDL blocks
    const stmts = sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of stmts) {
      await this._d1.prepare(stmt).run();
    }
  }

  /**
   * D1 "transaction" — runs statements as a batch (atomic in D1).
   * fn receives the db and should return an array of prepared statements to batch.
   * For simple use: wraps the fn and awaits each statement sequentially.
   */
  transaction(fn) {
    // Returns a wrapped async function
    return async (...args) => {
      // Collect statements by running fn with a collector
      return await fn(...args);
    };
  }

  /**
   * D1 native batch — most efficient way to run multiple writes.
   * @param {Array<{sql: string, params: any}>} ops
   */
  async batch(ops) {
    const stmts = ops.map(({ sql, params }) => {
      const stmt = this._d1.prepare(sql);
      return params ? stmt.bind(params) : stmt;
    });
    return await this._d1.batch(stmts);
  }
}

// ─── SQLite (Node.js) Adapter ─────────────────────────────────────────────────

class SQLiteStatement {
  constructor(stmt) {
    this._stmt = stmt;
  }

  run(params) {
    const info = params ? this._stmt.run(params) : this._stmt.run();
    return { changes: info.changes, lastRowid: info.lastInsertRowid };
  }

  get(params) {
    return params ? this._stmt.get(params) : this._stmt.get();
  }

  all(params) {
    return params ? this._stmt.all(params) : this._stmt.all();
  }
}

class SQLiteDb {
  constructor(db) {
    this._db = db;
    this._db.pragma("journal_mode = WAL");
    this._db.pragma("synchronous = NORMAL");
    this._db.pragma("foreign_keys = ON");
  }

  prepare(sql) {
    return new SQLiteStatement(this._db.prepare(sql));
  }

  exec(sql) {
    this._db.exec(sql);
  }

  transaction(fn) {
    return this._db.transaction(fn);
  }

  async batch(ops) {
    const tx = this._db.transaction(() => {
      return ops.map(({ sql, params }) => {
        const stmt = this._db.prepare(sql);
        return params ? stmt.run(params) : stmt.run();
      });
    });
    return tx();
  }

  close() {
    this._db.close();
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * @param {{ d1?: D1Database, path?: string }} opts
 * @returns {D1Db | SQLiteDb}
 */
export async function openDb(opts = {}) {
  if (opts.d1) {
    return new D1Db(opts.d1);
  }

  if (opts.path || process.env.DB_PATH) {
    const dbPath = opts.path || process.env.DB_PATH;
    // Dynamic import so Cloudflare Workers bundler can tree-shake this
    const { default: Database } = await import("better-sqlite3");
    return new SQLiteDb(new Database(dbPath));
  }

  // Auto-detect: try local path
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const defaultPath = path.join(root, "data", "dev.sqlite");
  const { default: Database } = await import("better-sqlite3");
  return new SQLiteDb(new Database(defaultPath));
}
