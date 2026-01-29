const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const logger = require('./logger');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'dagmarcom.db');
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    logger.error({ err }, 'Chyba otevreni databaze');
  } else {
    logger.info({ dbPath }, 'Databaze inicializovana');
  }
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      phone TEXT PRIMARY KEY,
      last_response_id TEXT,
      last_response_at INTEGER,
      response_count INTEGER DEFAULT 0,
      processing INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS message_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      body TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      processed INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      direction TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS reset_tokens (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
});

module.exports = db;
