// A D1-shaped adapter over node:sqlite, so the Worker's queries can be tested
// locally against real SQLite instead of being mocked. D1 is SQLite-compatible,
// so the SQL exercised here is the SQL that runs in production.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args.map((a) => (a === undefined ? null : a)); return this; }

  #prepared() { return this.db.prepare(this.sql); }

  async first(column) {
    const row = this.#prepared().get(...this.args) ?? null;
    if (!row) return null;
    return column ? row[column] : row;
  }
  async all() {
    return { results: this.#prepared().all(...this.args), success: true, meta: {} };
  }
  async run() {
    const info = this.#prepared().run(...this.args);
    return { success: true, meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) } };
  }
}

export function makeD1(schemaPath = 'worker/schema.sql') {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  return {
    prepare: (sql) => new Stmt(db, sql),
    batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
    _raw: db,
  };
}

/** Seed an allowlisted user and return their row id. */
export function addUser(d1, email, { role = 'member', status = 'allowed', name = null } = {}) {
  const info = d1._raw.prepare(
    'INSERT INTO user (email, name, role, status) VALUES (?, ?, ?, ?)',
  ).run(email, name, role, status);
  return Number(info.lastInsertRowid);
}
