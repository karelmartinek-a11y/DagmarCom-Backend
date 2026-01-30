const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const initSqlJs = require('sql.js');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'dagmarcom.db');
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const wasmFile = require.resolve('sql.js/dist/sql-wasm.wasm');

let SQL;
let instance;
const ready = initSqlJs({
  locateFile: () => wasmFile,
})
  .then((SQLLib) => {
    SQL = SQLLib;
    instance = initializeDatabase();
    logger.info({ dbPath }, 'SQL.js databáze inicializována');
    return instance;
  })
  .catch((err) => {
    logger.error({ err }, 'SQL.js inicializace selhala');
    throw err;
  });

function initializeDatabase() {
  const existing = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
  const db = existing ? new SQL.Database(new Uint8Array(existing)) : new SQL.Database();
  ensureSchema(db);
  persist(db);
  return db;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      phone TEXT PRIMARY KEY,
      last_response_id TEXT,
      last_response_at INTEGER,
      response_count INTEGER DEFAULT 0,
      processing INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS message_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      body TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      processed INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      direction TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reset_tokens (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

function persist(db) {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function withDb(action) {
  return ready.then(() => action(instance));
}

function scheduleCallback(callback, err, result) {
  if (typeof callback !== 'function') return result;
  setImmediate(() => callback(err, result));
  return result;
}

function normalizeArgs(params, callback) {
  if (typeof params === 'function') {
    callback = params;
    params = [];
  }
  return { params: Array.isArray(params) ? params : [], callback };
}

function run(sql, params, callback) {
  const { params: normalized, callback: cb } = normalizeArgs(params, callback);
  return withDb((db) => {
    const stmt = db.prepare(sql);
    const info = stmt.run(normalized);
    stmt.free();
    persist(db);
    const result = {
      lastID: info.lastInsertRowid ?? 0,
      changes: info.changes,
    };
    return scheduleCallback(cb, null, result);
  }).catch((err) => {
    scheduleCallback(cb, err);
    throw err;
  });
}

function all(sql, params, callback) {
  const { params: normalized, callback: cb } = normalizeArgs(params, callback);
  return withDb((db) => {
    const stmt = db.prepare(sql);
    const rows = stmt.all(normalized);
    stmt.free();
    return scheduleCallback(cb, null, rows);
  }).catch((err) => {
    scheduleCallback(cb, err);
    throw err;
  });
}

function get(sql, params, callback) {
  const { params: normalized, callback: cb } = normalizeArgs(params, callback);
  return withDb((db) => {
    const stmt = db.prepare(sql);
    const row = stmt.get(normalized);
    stmt.free();
    return scheduleCallback(cb, null, row);
  }).catch((err) => {
    scheduleCallback(cb, err);
    throw err;
  });
}

function serialize(callback) {
  return withDb(() => {
    if (typeof callback === 'function') {
      callback();
    }
  });
}

module.exports = {
  run,
  all,
  get,
  serialize,
};
