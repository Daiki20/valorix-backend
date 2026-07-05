const Database = require('better-sqlite3')
const path = require('path')
const fs   = require('fs')

// ── Persistent storage path ───────────────────────────────────────────────────
// Если DB_PATH задан (Railway Volume) — используем его
// Иначе fallback на папку приложения
const DB_DIR  = process.env.DB_PATH || __dirname
const DB_FILE = path.join(DB_DIR, 'valorix.db')
const OLD_FILE = path.join(__dirname, 'valorix.db')

// Автомиграция: если переехали на Volume и там ещё нет БД — копируем старую
if (process.env.DB_PATH && !fs.existsSync(DB_FILE)) {
  fs.mkdirSync(DB_DIR, { recursive: true })
  if (fs.existsSync(OLD_FILE)) {
    fs.copyFileSync(OLD_FILE, DB_FILE)
    console.log(`[db] Migrated database from ${OLD_FILE} to ${DB_FILE}`)
  } else {
    console.log(`[db] Creating new database at ${DB_FILE}`)
  }
}

const db = new Database(DB_FILE)

db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    username TEXT,
    coins INTEGER NOT NULL DEFAULT 28,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_blocked INTEGER NOT NULL DEFAULT 0,
    is_verified INTEGER NOT NULL DEFAULT 1,
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
if (!userCols.includes('is_admin'))               db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
if (!userCols.includes('is_blocked'))             db.exec("ALTER TABLE users ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0")
if (!userCols.includes('reset_token'))            db.exec("ALTER TABLE users ADD COLUMN reset_token TEXT")
if (!userCols.includes('reset_token_exp'))        db.exec("ALTER TABLE users ADD COLUMN reset_token_exp INTEGER")
// Existing users get is_verified=1 automatically via DEFAULT 1
if (!userCols.includes('is_verified'))            db.exec("ALTER TABLE users ADD COLUMN is_verified INTEGER NOT NULL DEFAULT 1")
if (!userCols.includes('verification_code'))      db.exec("ALTER TABLE users ADD COLUMN verification_code TEXT")
if (!userCols.includes('verification_code_exp'))  db.exec("ALTER TABLE users ADD COLUMN verification_code_exp INTEGER")

// IP защита от мультиаккаунтов
if (!userCols.includes('reg_ip')) db.exec("ALTER TABLE users ADD COLUMN reg_ip TEXT")

// Промокод при регистрации
if (!userCols.includes('promo_code'))    db.exec("ALTER TABLE users ADD COLUMN promo_code TEXT")

// UTM-источник трафика (первое касание)
if (!userCols.includes('utm_source'))   db.exec("ALTER TABLE users ADD COLUMN utm_source TEXT")
if (!userCols.includes('utm_campaign')) db.exec("ALTER TABLE users ADD COLUMN utm_campaign TEXT")

const analysisCols2 = db.prepare("PRAGMA table_info(analyses)").all().map(c => c.name)
if (!analysisCols2.includes('share_token')) {
  db.exec("ALTER TABLE analyses ADD COLUMN share_token TEXT")
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_analyses_share_token ON analyses(share_token)")
}

// Express tables
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_express (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS express_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    express_date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, express_date)
  );
  CREATE TABLE IF NOT EXISTS daily_express_high (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS express_purchases_high (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    express_date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, express_date)
  );
`)

// Sport-specific expresses (hockey, cs2, dota2, valorant, lol)
db.exec(`
  CREATE TABLE IF NOT EXISTS express_sports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    sport TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(date, sport, type)
  );
  CREATE TABLE IF NOT EXISTS express_sports_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    express_date TEXT NOT NULL,
    sport TEXT NOT NULL,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, express_date, sport, type)
  );
`)

// Analysis cache (persists across deploys, TTL enforced in app)
db.exec(`
  CREATE TABLE IF NOT EXISTS analysis_cache (
    cache_key TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_analysis_cache_created ON analysis_cache(created_at);
`)

// Team logo cache (persists across Railway restarts)
db.exec(`
  CREATE TABLE IF NOT EXISTS team_logos (
    name_key  TEXT PRIMARY KEY,
    url       TEXT,
    ok        INTEGER NOT NULL DEFAULT 0,
    ts        INTEGER NOT NULL
  );
`)

// Blog articles
db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT UNIQUE NOT NULL,
    title       TEXT NOT NULL,
    excerpt     TEXT,
    content     TEXT NOT NULL,
    meta_title  TEXT,
    meta_desc   TEXT,
    cover_url   TEXT,
    sport       TEXT NOT NULL DEFAULT 'other',
    match_key   TEXT,
    published   INTEGER NOT NULL DEFAULT 0,
    views       INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_articles_slug      ON articles(slug);
  CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published, created_at);
`)

// Add sport/match_key columns to existing installs (must run BEFORE index on sport)
const artCols = db.prepare("PRAGMA table_info(articles)").all().map(c => c.name)
if (!artCols.includes('sport'))     db.exec("ALTER TABLE articles ADD COLUMN sport TEXT NOT NULL DEFAULT 'other'")
if (!artCols.includes('match_key')) db.exec("ALTER TABLE articles ADD COLUMN match_key TEXT")

// Create sport index AFTER migration so column is guaranteed to exist
db.exec("CREATE INDEX IF NOT EXISTS idx_articles_sport ON articles(sport)")

// Seed super-admin
db.prepare(`
  UPDATE users SET is_admin = 1 WHERE email = 'andrey.pishev2021@yandex.ru'
`).run()

module.exports = db
