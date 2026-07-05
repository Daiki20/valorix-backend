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
      const code = res.statusCode
      if (code === 429) {
        resolve({ ok: false, detail: `⚠️ Лимит исчерпан (HTTP 429)`, ms })
      } else if (code === 402) {
        resolve({ ok: false, detail: `💳 Закончилась подписка (HTTP 402)`, ms })
      } else if (code === 401) {
        resolve({ ok: false, detail: `HTTP 401 — неверный ключ`, ms })
      } else if (code === 403) {
        resolve({ ok: false, detail: `HTTP 403 — доступ запрещён`, ms })
      } else if (code >= 200 && code < 400) {
        resolve({ ok: true, detail: `HTTP ${code}`, ms })
      } else {
        resolve({ ok: false, detail: `HTTP ${code}`, ms })
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
    'SELECT id, email, username, coins, is_admin, is_blocked, created_at, promo_code FROM users ORDER BY created_at DESC LIMIT 5'
  ).all()

  res.json({ totalUsers, totalAnalyses, totalCoinsSpent, todayUsers, todayAnalyses, revenue, recentUsers })
})

// GET /admin/traffic — статистика по UTM источникам
router.get('/traffic', (req, res) => {
  const PRICES = { pack_test: 50, pack_100: 100, pack_300: 300, pack_600: 540, pack_1000: 800 }

  const regs = db.prepare(`
    SELECT COALESCE(utm_source, 'organic') as source, COUNT(*) as total,
      COUNT(CASE WHEN date(created_at) = date('now') THEN 1 END) as today
    FROM users GROUP BY source ORDER BY total DESC
  `).all()

  const payments = db.prepare(`
    SELECT COALESCE(u.utm_source, 'organic') as source,
      p.package_id, COUNT(*) as cnt
    FROM pending_payments p JOIN users u ON p.user_id = u.id
    WHERE p.status = 'done'
    GROUP BY source, p.package_id
  `).all()

  // Aggregate revenue per source
  const revenueMap = {}
  const countMap = {}
  for (const row of payments) {
    revenueMap[row.source] = (revenueMap[row.source] || 0) + (PRICES[row.package_id] || 0) * row.cnt
    countMap[row.source]   = (countMap[row.source] || 0) + row.cnt
  }

  const result = regs.map(r => ({
    source: r.source,
    registrations: r.total,
    today_regs: r.today,
    payments: countMap[r.source] || 0,
    revenue: revenueMap[r.source] || 0,
  }))

  res.json(result)
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
           u.promo_code, COUNT(a.id) as analyses_count
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

    // AllSports RapidAPI — тот же эндпоинт что используем в продакшне
    check('AllSports (RapidAPI)', '🏒', 'RAPIDAPI_KEY', () =>
      httpProbe({ hostname: 'allsportsapi2.p.rapidapi.com',
        path: '/api/tournament/3/seasons', method: 'GET',
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

    // Sofascore — тот же эндпоинт что используем для матчей ИИХФ ЧМ
    check('Sofascore (free)', '📡', null, () =>
      httpProbe({ hostname: 'api.sofascore.com',
        path: '/api/v1/unique-tournament/3/season/81043/events/next/0', method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json', 'Referer': 'https://www.sofascore.com/', 'Origin': 'https://www.sofascore.com' } })
    ),

    // BallDontLie — проверяем ключ + пробуем несколько путей
    check('BallDontLie API', '🎮', 'BALLDONTLIE_KEY', async () => {
      const key = (process.env.BALLDONTLIE_KEY || '').trim()

      const probe = (hostname, path, authHeader) => new Promise((resolve) => {
        const start = Date.now()
        const req = https.request({
          hostname, path, method: 'GET',
          headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        }, (res) => {
          let body = ''
          res.on('data', c => body += c)
          res.on('end', () => {
            const ms = Date.now() - start
            const code = res.statusCode
            console.log(`[BDL probe] ${hostname}${path} → ${code}`)
            resolve({ ok: code >= 200 && code < 300, code, ms })
          })
        })
        req.on('error', e => resolve({ ok: false, code: 0, ms: Date.now() - start }))
        req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, code: 0, ms: 5000 }) })
        req.end()
      })

      // Correct paths per BallDontLie docs:
      // NBA: /v1/teams  |  Other sports: /{sport}/v1/teams
      const attempts = [
        ['api.balldontlie.io', '/v1/teams?per_page=1', key],
        ['api.balldontlie.io', '/nhl/v1/teams?per_page=1', key],
      ]

      for (const [host, path, auth] of attempts) {
        const r = await probe(host, path, auth)
        if (r.ok)          return { ok: true,  detail: `HTTP ${r.code} (${host}${path})`, ms: r.ms }
        if (r.code === 401) return { ok: false, detail: 'HTTP 401 — неверный ключ', ms: r.ms }
        if (r.code === 429) return { ok: false, detail: '⚠️ Лимит (HTTP 429)', ms: r.ms }
      }

      return { ok: false, detail: 'Ключ не принят — проверь значение BALLDONTLIE_KEY в Railway', ms: 0 }
    }),

    // YuKassa — просто проверяем что ключи настроены (не делаем запрос к платёжке)
    check('ЮКасса (платежи)', '💳', 'YUKASSA_SHOP_ID', async () => {
      const hasSecret = !!process.env.YUKASSA_SECRET_KEY
      return { ok: hasSecret, detail: hasSecret ? 'Shop ID + Secret Key настроены' : 'YUKASSA_SECRET_KEY не задан', ms: 0 }
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

// DELETE /admin/cache — очистить кэш анализов (все или по паттерну)
router.delete('/cache', (req, res) => {
  const { pattern } = req.query
  try {
    if (pattern) {
      const result = db.prepare(`DELETE FROM analysis_cache WHERE cache_key LIKE ?`).run(`%${pattern}%`)
      res.json({ deleted: result.changes, pattern })
    } else {
      const result = db.prepare(`DELETE FROM analysis_cache`).run()
      res.json({ deleted: result.changes, pattern: 'all' })
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /admin/cache — посмотреть что в кэше
router.get('/cache', (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT cache_key, created_at, length(content) as size_bytes FROM analysis_cache ORDER BY created_at DESC LIMIT 100`
    ).all()
    res.json({ count: rows.length, entries: rows.map(r => ({
      key: r.cache_key,
      age_minutes: Math.round((Date.now() - r.created_at) / 60000),
      size_kb: Math.round(r.size_bytes / 1024 * 10) / 10,
    })) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /admin/newsletter — рассылка по всем пользователям ──────────────────
router.post('/newsletter', authenticate, requireAdmin, async (req, res) => {
  const { subject, text } = req.body
  if (!subject || !text) return res.status(400).json({ error: 'Нужны subject и text' })
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY не настроен' })

  // Берём всех незаблокированных верифицированных пользователей
  const users = db.prepare(
    `SELECT email, username FROM users WHERE is_blocked = 0 AND is_verified = 1 AND email NOT LIKE '%@example.com'`
  ).all()

  if (!users.length) return res.json({ sent: 0, failed: 0, total: 0 })

  // HTML-шаблон письма
  const buildHtml = (username) => `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:0 auto;background:#07090f;border-radius:16px;overflow:hidden;border:1px solid rgba(0,180,255,0.15)">
      <div style="background:linear-gradient(135deg,#030b18,#0a1628);padding:28px 32px 20px;border-bottom:1px solid rgba(0,207,255,0.12)">
        <span style="font-size:22px;font-weight:800;color:#d8eeff;letter-spacing:-0.5px">
          Valorix <em style="color:#00cfff;font-style:italic">AI</em>
        </span>
      </div>
      <div style="padding:28px 32px">
        ${username ? `<p style="color:#64748b;font-size:14px;margin:0 0 16px">Привет, ${username} 👋</p>` : ''}
        <div style="color:#d8eeff;font-size:15px;line-height:1.75;white-space:pre-wrap">${text.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
      </div>
      <div style="padding:20px 32px 28px;border-top:1px solid rgba(0,207,255,0.08)">
        <a href="https://valorix.ru/analyze" style="display:inline-block;background:linear-gradient(135deg,#00cfff,#7b5ea7);color:#030b18;font-weight:700;font-size:14px;padding:12px 28px;border-radius:10px;text-decoration:none">
          Открыть Valorix AI →
        </a>
        <p style="color:#1e3a5a;font-size:12px;margin:16px 0 0">
          Valorix AI · Вы получили это письмо как зарегистрированный пользователь
        </p>
      </div>
    </div>
  `

  // Отправка батчами по 50 с паузой 1.5с между батчами
  const BATCH = 50
  let sent = 0, failed = 0

  for (let i = 0; i < users.length; i += BATCH) {
    const batch = users.slice(i, i + BATCH)
    const payload = JSON.stringify(
      batch.map(u => ({
        from: process.env.SMTP_FROM || 'Valorix AI <noreply@valorix.ru>',
        to: [u.email],
        subject,
        html: buildHtml(u.username),
      }))
    )
    try {
      await new Promise((resolve, reject) => {
        const req2 = https.request({
          hostname: 'api.resend.com',
          path: '/emails/batch',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        }, r => {
          let data = ''
          r.on('data', c => data += c)
          r.on('end', () => {
            if (r.statusCode >= 400) { console.error('Resend batch error:', data); reject(new Error(data)) }
            else { resolve() }
          })
        })
        req2.on('error', reject)
        req2.setTimeout(15000, () => { req2.destroy(); reject(new Error('timeout')) })
        req2.write(payload)
        req2.end()
      })
      sent += batch.length
      console.log(`[newsletter] sent batch ${Math.floor(i/BATCH)+1}: ${sent}/${users.length}`)
    } catch (err) {
      console.error(`[newsletter] batch failed:`, err.message)
      failed += batch.length
    }
    // Пауза между батчами чтобы не получить rate-limit
    if (i + BATCH < users.length) await new Promise(r => setTimeout(r, 1500))
  }

  res.json({ sent, failed, total: users.length })
})

// POST /admin/test-bonus — активирует бонус на 1 час для своего аккаунта (только admin)
router.post('/test-bonus', authenticate, requireAdmin, (req, res) => {
  const expires = Date.now() + 60 * 60 * 1000
  db.prepare('UPDATE users SET bonus_expires_at = ? WHERE id = ?').run(expires, req.user.id)
  res.json({ ok: true, bonus_expires_at: expires })
})

module.exports = router
