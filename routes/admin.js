const express = require('express')
const https = require('https')
const db = require('../db')
const { authenticate } = require('../middleware/auth')
const { requireAdmin } = require('../middleware/admin')

const router = express.Router()

// ── API Status check helpers ──────────────────────────────────────────────────
function httpProbe(options, timeout = 6000) {
  return new Promise((resolve) => {
    const start = Date.now()
    const req = https.request(options, (res) => {
      res.resume() // drain response
      const ms = Date.now() - start
      if (res.statusCode === 401 || res.statusCode === 403) {
        resolve({ ok: false, detail: `HTTP ${res.statusCode} — неверный ключ`, ms })
      } else if (res.statusCode >= 200 && res.statusCode < 500) {
        resolve({ ok: true, detail: `HTTP ${res.statusCode}`, ms })
      } else {
        resolve({ ok: false, detail: `HTTP ${res.statusCode}`, ms })
      }
    })
    req.on('error', (e) => resolve({ ok: false, detail: e.message, ms: Date.now() - start }))
    req.setTimeout(timeout, () => { req.destroy(); resolve({ ok: false, detail: 'Таймаут', ms: timeout }) })
    req.end()
  })
}

router.use(authenticate, requireAdmin)

// GET /admin/stats — дашборд
router.get('/stats', (req, res) => {
  const totalUsers     = db.prepare('SELECT COUNT(*) as c FROM users').get().c
  const totalAnalyses  = db.prepare('SELECT COUNT(*) as c FROM analyses').get().c
  const totalCoinsSpent = db.prepare("SELECT COALESCE(SUM(coins_spent),0) as c FROM analyses").get().c

  const todayUsers = db.prepare(
    "SELECT COUNT(*) as c FROM users WHERE date(created_at) = date('now')"
  ).get().c
  const todayAnalyses = db.prepare(
    "SELECT COUNT(*) as c FROM analyses WHERE date(created_at) = date('now')"
  ).get().c

  const revenue = db.prepare(
    "SELECT COALESCE(SUM(amount),0) as c FROM coin_transactions WHERE type = 'purchase'"
  ).get().c

  const recentUsers = db.prepare(
    'SELECT id, email, username, coins, is_admin, is_blocked, created_at FROM users ORDER BY created_at DESC LIMIT 5'
  ).all()

  res.json({ totalUsers, totalAnalyses, totalCoinsSpent, todayUsers, todayAnalyses, revenue, recentUsers })
})

// GET /admin/users — все пользователи
router.get('/users', (req, res) => {
  const { search = '' } = req.query
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1)
  const limit = 20
  const offset = (page - 1) * limit
  const pattern = `%${search}%`

  const users = db.prepare(`
    SELECT u.id, u.email, u.username, u.coins, u.is_admin, u.is_blocked, u.created_at,
           COUNT(a.id) as analyses_count
    FROM users u
    LEFT JOIN analyses a ON a.user_id = u.id
    WHERE u.email LIKE ? OR u.username LIKE ?
    GROUP BY u.id
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `).all(pattern, pattern, limit, offset)

  const total = db.prepare(
    'SELECT COUNT(*) as c FROM users WHERE email LIKE ? OR username LIKE ?'
  ).get(pattern, pattern).c

  res.json({ users, total, page: Number(page), pages: Math.ceil(total / limit) })
})

// POST /admin/add-coins
router.post('/add-coins', (req, res) => {
  const { email, amount, reason } = req.body
  if (!email || !amount) return res.status(400).json({ error: 'Нужны email и amount' })

  const user = db.prepare('SELECT id, coins FROM users WHERE email = ?').get(email.toLowerCase())
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' })

  const coins = parseInt(amount)
  db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(coins, user.id)
  db.prepare('INSERT INTO coin_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(
    user.id, coins, coins > 0 ? 'admin_add' : 'admin_remove',
    reason || (coins > 0 ? `Начислено администратором` : `Снято администратором`)
  )

  const updated = db.prepare('SELECT coins FROM users WHERE id = ?').get(user.id)
  res.json({ success: true, coins: updated.coins })
})

// POST /admin/set-admin
router.post('/set-admin', (req, res) => {
  const { email, value } = req.body
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email?.toLowerCase())
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' })

  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(value ? 1 : 0, user.id)
  res.json({ success: true })
})

// POST /admin/set-blocked
router.post('/set-blocked', (req, res) => {
  const { email, value } = req.body
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email?.toLowerCase())
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' })

  db.prepare('UPDATE users SET is_blocked = ? WHERE id = ?').run(value ? 1 : 0, user.id)
  res.json({ success: true })
})

// GET /admin/api-status — проверка всех подключённых API (ключи не возвращаются)
router.get('/api-status', async (req, res) => {
  const results = []

  const check = async (name, icon, keyEnv, probeFn) => {
    const hasKey = keyEnv ? !!process.env[keyEnv] : true // free APIs don't need key check
    if (keyEnv && !hasKey) {
      results.push({ name, icon, status: 'no_key', detail: 'Ключ не настроен (env не задан)', ms: 0 })
      return
    }
    try {
      const { ok, detail, ms } = await probeFn()
      results.push({ name, icon, status: ok ? 'ok' : 'error', detail, ms })
    } catch (e) {
      results.push({ name, icon, status: 'error', detail: e.message, ms: 0 })
    }
  }

  await Promise.all([
    // OpenAI — GET /v1/models (бесплатный эндпоинт, просто листинг моделей)
    check('OpenAI (GPT-4o)', '🤖', 'OPENAI_API_KEY', () =>
      httpProbe({ hostname: 'api.openai.com', path: '/v1/models', method: 'GET',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } })
    ),

    // AllSports RapidAPI — лёгкий запрос списка стран
    check('AllSports (RapidAPI)', '🏒', 'RAPIDAPI_KEY', () =>
      httpProbe({ hostname: 'allsportsapi2.p.rapidapi.com', path: '/api/country/list', method: 'GET',
        headers: { 'X-RapidAPI-Key': process.env.RAPIDAPI_KEY, 'X-RapidAPI-Host': 'allsportsapi2.p.rapidapi.com' } })
    ),

    // The Odds API — список видов спорта (не тратит квоту)
    check('The Odds API', '📊', 'ODDS_API_KEY', () =>
      httpProbe({ hostname: 'api.the-odds-api.com',
        path: `/v4/sports?apiKey=${process.env.ODDS_API_KEY}`, method: 'GET' })
    ),

    // SStats — бесплатный лёгкий запрос
    check('SStats (Football)', '⚽', 'SSTATS_API_KEY', () =>
      httpProbe({ hostname: 'api.sstats.net',
        path: `/Games/list?upcoming=true&leagueid=39&limit=1&apikey=${process.env.SSTATS_API_KEY}`,
        method: 'GET' })
    ),

    // NHL Free API — бесплатно, без ключа
    check('NHL API (free)', '🏒', null, () =>
      httpProbe({ hostname: 'api-web.nhle.com', path: '/v1/standings/now', method: 'GET' })
    ),

    // Sofascore — бесплатно, без ключа
    check('Sofascore (free)', '📡', null, () =>
      httpProbe({ hostname: 'api.sofascore.com', path: '/api/v1/sport/ice-hockey/events/live', method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.sofascore.com/' } })
    ),

    // YooKassa — просто проверяем что ключи настроены (не делаем запрос к платёжке)
    check('ЮКасса (платежи)', '💳', 'YOOKASSA_SHOP_ID', async () => {
      const hasSecret = !!process.env.YOOKASSA_SECRET_KEY
      return { ok: hasSecret, detail: hasSecret ? 'Shop ID + Secret Key настроены' : 'YOOKASSA_SECRET_KEY не задан', ms: 0 }
    }),
  ])

  res.json(results)
})

// GET /admin/transactions — все транзакции
router.get('/transactions', (req, res) => {
  const { page = 1 } = req.query
  const limit = 30
  const offset = (page - 1) * limit

  const txs = db.prepare(`
    SELECT ct.*, u.email, u.username
    FROM coin_transactions ct
    JOIN users u ON u.id = ct.user_id
    ORDER BY ct.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset)

  const total = db.prepare('SELECT COUNT(*) as c FROM coin_transactions').get().c
  res.json({ transactions: txs, total, pages: Math.ceil(total / limit) })
})

module.exports = router
