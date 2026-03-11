const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'history.db');

let db;

function getDB() {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

function initDB() {
  const db = getDB();

  db.exec(`
    CREATE TABLE IF NOT EXISTS download_history (
      id          TEXT PRIMARY KEY,
      url         TEXT NOT NULL,
      title       TEXT,
      platform    TEXT,
      format_id   TEXT,
      format_type TEXT,  -- 'mp4' | 'mp3' | 'mkv' | etc
      quality     TEXT,
      file_size   INTEGER,
      duration    INTEGER,
      thumbnail   TEXT,
      status      TEXT DEFAULT 'pending',  -- pending | completed | failed
      error       TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS cookies (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      platform    TEXT NOT NULL UNIQUE,
      cookie_data TEXT NOT NULL,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log('✅ Database initialized');
}

module.exports = { getDB, initDB };
