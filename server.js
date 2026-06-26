require('dotenv').config()

// ── Sentry (должен быть инициализирован раньше всего) ────────────────────────
const Sentry = require('@sentry/node')
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.2,
  })
  console.log('✅ Sentry initialized')
}

const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const cron = require('node-cron')

const authRoutes = require('./routes/auth')
const coinsRoutes = require('./routes/coins')
const adminRoutes = require('./routes/admin')
const analyzeRoutes = require('./routes/analyze')
const shareRoutes = require('./routes/share')
const expressRoutes = require('./routes/express')
const matchesRoutes = require('./routes/matches')
const blogRoutes = require('./routes/blog')
const uploadRoutes = require('./routes/upload')

const app = express()
const PORT = process.env.PORT || 3001

// ── Trust proxy (Railway, Vercel и др. используют reverse proxy) ──
app.set('trust proxy', 1)

// ── CORS — должен быть до helmet и rate limiters ─────────
const ALLOWED_ORIGINS = [
  'https://valorix.ru',
  'https://www.valorix.ru',
  'http://localhost:5173',
  'http://localhost:3000',
]
const corsOptions = {
  origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin) ? true : false),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Valorix-Token'],
}
app.use(cors(corsOptions))

// ── Security headers ──────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}))

app.use('/analyze', express.json({ limit: '20mb' }))
app.use('/upload',  express.json({ limit: '10mb' }))
app.use(express.json({ limit: '10kb' }))

// ── Rate limiters ─────────────────────────────────────────

// Жёсткий лимит для auth (регистрация, логин, сброс пароля)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 20,
  message: { error: 'Слишком много запросов. Попробуйте через 15 минут.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// Лимит для анализа (чтобы не сжечь AI-бюджет)
const analysisLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 минута
  max: 5,
  message: { error: 'Слишком много запросов на анализ. Подождите минуту.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// Общий лимит на все API
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: 'Слишком много запросов.' },
  standardHeaders: true,
  legacyHeaders: false,
})

app.use(globalLimiter)

// ── Routes ────────────────────────────────────────────────
app.use('/auth', authLimiter, authRoutes)
app.use('/coins', coinsRoutes)
app.use('/coins/spend', analysisLimiter)
app.use('/admin', adminRoutes)
app.use('/analyze', analyzeRoutes)
app.use('/share', shareRoutes)
app.use('/express', expressRoutes)
app.use('/matches', matchesRoutes)
app.use('/blog', blogRoutes)
app.use('/upload', uploadRoutes)

// ── GET /images/:id/:filename — serve uploaded images from SQLite ─────────
app.get('/images/:id/:filename', (req, res) => {
  const db = require('./db')
  const row = db.prepare('SELECT data, mimetype FROM uploaded_images WHERE id = ?').get(parseInt(req.params.id))
  if (!row) return res.status(404).json({ error: 'Изображение не найдено' })
  res.set('Content-Type', row.mimetype)
  res.set('Cache-Control', 'public, max-age=31536000, immutable')
  res.send(row.data)
})

// Sitemap.xml — помогает Google находить все статьи
app.get('/sitemap.xml', (req, res) => {
  const db = require('./db')
  const articles = db.prepare("SELECT slug, updated_at FROM articles WHERE published = 1 ORDER BY created_at DESC").all()
  const base = 'https://valorix.ru'
  const staticPages = ['', '/blog']
  const urls = [
    ...staticPages.map(p => `<url><loc>${base}${p}</loc><changefreq>weekly</changefreq><priority>${p === '' ? '1.0' : '0.8'}</priority></url>`),
    ...articles.map(a => `<url><loc>${base}/blog/${a.slug}</loc><lastmod>${(a.updated_at || '').slice(0,10)}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>`),
  ]
  res.set('Content-Type', 'application/xml')
  res.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`)
})

// RSS / Yandex Turbo — ускоренные страницы в мобильном поиске Яндекса
app.get('/rss.xml', (req, res) => {
  const db = require('./db')
  const articles = db.prepare("SELECT slug, title, excerpt, content, cover_url, created_at, updated_at FROM articles WHERE published = 1 ORDER BY created_at DESC LIMIT 50").all()
  const base = 'https://valorix.ru'
  const esc = s => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')

  // Convert basic Markdown to HTML for Turbo content
  const mdToHtml = md => (md || '')
    .replace(/^#{1}\s+(.+)$/gm,  '<h1>$1</h1>')
    .replace(/^#{2}\s+(.+)$/gm,  '<h2>$1</h2>')
    .replace(/^#{3}\s+(.+)$/gm,  '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g,   '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,       '<em>$1</em>')
    .replace(/^[-*]\s+(.+)$/gm,  '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, s => `<ul>${s}</ul>`)
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(?!<[h|u|l])(.+)$/gm, '$1')
    .replace(/^<\/p><p>/, '')
    .trim()

  const items = articles.map(a => {
    const html = mdToHtml(a.content)
    const cover = a.cover_url ? `<figure><img src="${esc(a.cover_url)}" /></figure>` : ''
    return `
    <item turbo="true">
      <link>${base}/blog/${a.slug}</link>
      <turbo:topic>${esc(a.title)}</turbo:topic>
      <pubDate>${new Date(a.created_at).toUTCString()}</pubDate>
      <turbo:content><![CDATA[
        ${cover}
        <header><h1>${esc(a.title)}</h1></header>
        <p>${esc(a.excerpt || '')}</p>
        ${html}
        <p><a href="${base}/analyze">Попробовать AI-анализ матча бесплатно →</a></p>
      ]]></turbo:content>
    </item>`
  }).join('\n')

  res.set('Content-Type', 'application/rss+xml; charset=utf-8')
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:turbo="http://turbo.yandex.ru" version="2.0">
  <channel>
    <title>Valorix AI — Аналитика ставок</title>
    <link>${base}/blog</link>
    <description>Статьи об анализе спортивных матчей, стратегиях ставок и разборы лиг</description>
    <language>ru</language>
    ${items}
  </channel>
</rss>`)
})

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }))

// Debug: test Yandex Direct + send report now (only from localhost or with secret)
app.get('/debug/report', async (req, res) => {
  if (req.query.secret !== process.env.TG_BOT_TOKEN?.slice(-8)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  try {
    const { buildReport } = require('./tgReport')
    const text = await buildReport('now')
    res.json({ ok: true, report: text })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Cron: ⚽ Football Lite at 21:05 MSK (18:05 UTC) ──────────────────────
cron.schedule('5 18 * * *', async () => {
  const { generateExpressForDate, getTomorrowDate } = require('./routes/express')
  const db = require('./db')
  const targetDate = getTomorrowDate()
  console.log(`[cron] ⚽ Football Lite generating for ${targetDate}...`)
  try {
    const data = await generateExpressForDate(targetDate, 'standard')
    db.prepare('INSERT OR REPLACE INTO daily_express (date, data) VALUES (?, ?)').run(targetDate, JSON.stringify(data))
    console.log(`[cron] ⚽ Football Lite done`)
  } catch (err) {
    console.error('[cron] ⚽ Football Lite failed:', err.message)
  }
}, { timezone: 'UTC' })

// ── Cron: ⚽ Football Hard at 21:10 MSK (18:10 UTC) ──────────────────────
cron.schedule('10 18 * * *', async () => {
  const { generateExpressForDate, getTomorrowDate } = require('./routes/express')
  const db = require('./db')
  const targetDate = getTomorrowDate()
  console.log(`[cron] ⚽ Football Hard generating for ${targetDate}...`)
  try {
    const data = await generateExpressForDate(targetDate, 'high')
    db.prepare('INSERT OR REPLACE INTO daily_express_high (date, data) VALUES (?, ?)').run(targetDate, JSON.stringify(data))
    console.log(`[cron] ⚽ Football Hard done`)
  } catch (err) {
    console.error('[cron] ⚽ Football Hard failed:', err.message)
  }
}, { timezone: 'UTC' })

// ── Cron: 🏒 Hockey Lite at 21:15 MSK (18:15 UTC) ────────────────────────
cron.schedule('15 18 * * *', async () => {
  const { generateSportExpressForCron, getTomorrowDate } = require('./routes/express')
  const db = require('./db')
  const targetDate = getTomorrowDate()
  console.log(`[cron] 🏒 Hockey Lite generating for ${targetDate}...`)
  try {
    const data = await generateSportExpressForCron('hockey', 'standard', targetDate)
    db.prepare('INSERT OR REPLACE INTO express_sports (date, sport, type, data) VALUES (?, ?, ?, ?)').run(targetDate, 'hockey', 'standard', JSON.stringify(data))
    console.log(`[cron] 🏒 Hockey Lite done`)
  } catch (err) {
    console.error('[cron] 🏒 Hockey Lite failed:', err.message)
  }
}, { timezone: 'UTC' })

// ── Cron: 🔫 CS2 Lite at 21:25 MSK (18:25 UTC) ───────────────────────────────
cron.schedule('25 18 * * *', async () => {
  const { generateEsportsExpress, getTomorrowDate } = require('./routes/express')
  const db = require('./db')
  const targetDate = getTomorrowDate()
  console.log(`[cron] 🔫 CS2 Lite generating for ${targetDate}...`)
  try {
    const data = await generateEsportsExpress('cs2', 'standard', targetDate)
    db.prepare('INSERT OR REPLACE INTO express_sports (date, sport, type, data) VALUES (?, ?, ?, ?)').run(targetDate, 'cs2', 'standard', JSON.stringify(data))
    console.log(`[cron] 🔫 CS2 Lite done`)
  } catch (err) { console.error('[cron] 🔫 CS2 Lite failed:', err.message) }
}, { timezone: 'UTC' })

// ── Cron: 🔫 CS2 Hard at 21:30 MSK (18:30 UTC) ───────────────────────────────
cron.schedule('30 18 * * *', async () => {
  const { generateEsportsExpress, getTomorrowDate } = require('./routes/express')
  const db = require('./db')
  const targetDate = getTomorrowDate()
  console.log(`[cron] 🔫 CS2 Hard generating for ${targetDate}...`)
  try {
    const data = await generateEsportsExpress('cs2', 'high', targetDate)
    db.prepare('INSERT OR REPLACE INTO express_sports (date, sport, type, data) VALUES (?, ?, ?, ?)').run(targetDate, 'cs2', 'high', JSON.stringify(data))
    console.log(`[cron] 🔫 CS2 Hard done`)
  } catch (err) { console.error('[cron] 🔫 CS2 Hard failed:', err.message) }
}, { timezone: 'UTC' })

// ── Cron: 🎮 Dota2 Lite at 21:35 MSK (18:35 UTC) ─────────────────────────────
cron.schedule('35 18 * * *', async () => {
  const { generateEsportsExpress, getTomorrowDate } = require('./routes/express')
  const db = require('./db')
  const targetDate = getTomorrowDate()
  console.log(`[cron] 🎮 Dota2 Lite generating for ${targetDate}...`)
  try {
    const data = await generateEsportsExpress('dota2', 'standard', targetDate)
    db.prepare('INSERT OR REPLACE INTO express_sports (date, sport, type, data) VALUES (?, ?, ?, ?)').run(targetDate, 'dota2', 'standard', JSON.stringify(data))
    console.log(`[cron] 🎮 Dota2 Lite done`)
  } catch (err) { console.error('[cron] 🎮 Dota2 Lite failed:', err.message) }
}, { timezone: 'UTC' })

// ── Cron: 🎮 Dota2 Hard at 21:40 MSK (18:40 UTC) ─────────────────────────────
cron.schedule('40 18 * * *', async () => {
  const { generateEsportsExpress, getTomorrowDate } = require('./routes/express')
  const db = require('./db')
  const targetDate = getTomorrowDate()
  console.log(`[cron] 🎮 Dota2 Hard generating for ${targetDate}...`)
  try {
    const data = await generateEsportsExpress('dota2', 'high', targetDate)
    db.prepare('INSERT OR REPLACE INTO express_sports (date, sport, type, data) VALUES (?, ?, ?, ?)').run(targetDate, 'dota2', 'high', JSON.stringify(data))
    console.log(`[cron] 🎮 Dota2 Hard done`)
  } catch (err) { console.error('[cron] 🎮 Dota2 Hard failed:', err.message) }
}, { timezone: 'UTC' })

// ── Telegram webhook endpoint ─────────────────────────────────────────────────
app.post('/tg-webhook', express.json({ limit: '1mb' }), (req, res) => {
  res.sendStatus(200)  // answer Telegram immediately
  const { handleUpdate } = require('./tgReport')
  handleUpdate(req.body).catch(err => console.error('[tg-webhook] error:', err.message))
})

// ── Cron: 📊 Telegram report 08:00 MSK (05:00 UTC) — утро ────────────────────
cron.schedule('0 5 * * *', () => {
  const { sendMorningReport } = require('./tgReport')
  sendMorningReport()
}, { timezone: 'UTC' })

// ── Cron: 📊 Telegram report 23:59 MSK (20:59 UTC) — итог дня ────────────────
cron.schedule('59 20 * * *', () => {
  const { sendEveningReport } = require('./tgReport')
  sendEveningReport()
}, { timezone: 'UTC' })

// ── 404 ───────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Маршрут не найден' })
})

// ── Global error handler ──────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: 'Внутренняя ошибка сервера' })
})

app.listen(PORT, () => {
  console.log(`✅ Valorix backend running on http://localhost:${PORT}`)
  const { registerWebhook } = require('./tgReport')
  registerWebhook()
})
