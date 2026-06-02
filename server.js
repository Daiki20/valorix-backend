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

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }))

// ── Cron: ⚽ Football Lite at 00:05 MSK (21:05 UTC) ──────────────────────
cron.schedule('5 21 * * *', async () => {
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

// ── Cron: ⚽ Football Hard at 00:10 MSK (21:10 UTC) ──────────────────────
cron.schedule('10 21 * * *', async () => {
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

// ── Cron: 🏒 Hockey Lite at 00:15 MSK (21:15 UTC) ────────────────────────
cron.schedule('15 21 * * *', async () => {
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
})
