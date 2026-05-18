const Database = require('better-sqlite3')
const path = require('path')

const db = new Database(path.join(process.env.DB_PATH || __dirname, 'valorix.db'))

db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    username TEXT,
    coins INTEGER NOT NULL DEFAULT 10,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_blocked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS coin_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount INTEGER NOT NULL,
    type TEXT NOT NULL,
    description TEXT,
    payment_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pending_payments (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    coins INTEGER NOT NULL,
    package_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    match_home TEXT NOT NULL,
    match_away TEXT NOT NULL,
    league TEXT,
    result TEXT,
    coins_spent INTEGER NOT NULL DEFAULT 4,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

// Add new columns to existing tables if they don't exist yet
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name)
if (!userCols.includes('is_admin'))          db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
if (!userCols.includes('is_blocked'))        db.exec("ALTER TABLE users ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0")
if (!userCols.includes('reset_token'))       db.exec("ALTER TABLE users ADD COLUMN reset_token TEXT")
if (!userCols.includes('reset_token_exp'))   db.exec("ALTER TABLE users ADD COLUMN reset_token_exp INTEGER")

const analysisCols2 = db.prepare("PRAGMA table_info(analyses)").all().map(c => c.name)
if (!analysisCols2.includes('share_token')) {
  db.exec("ALTER TABLE analyses ADD COLUMN share_token TEXT")
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_analyses_share_token ON analyses(share_token)")
}

// Seed super-admin
db.prepare(`
  UPDATE users SET is_admin = 1 WHERE email = 'andrey.pishev2021@yandex.ru'
`).run()

module.exports = db
