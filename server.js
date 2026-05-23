require('dotenv').config()
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
  allowedHeaders: ['Content-Type', 'Authorization'],
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
  max: 120,
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

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }))

// ── Cron: auto-generate express at 00:05 MSK (21:05 UTC) ─────────────────
// Generates all 4 variants: football standard+high, hockey standard+high
cron.schedule('5 21 * * *', async () => {
  console.log('[cron] Generating daily express for all sports...')
  const { generateExpressForDate, getTomorrowDate } = require('./routes/express')
  const db = require('./db')
  const targetDate = getTomorrowDate()

  // Football standard
  try {
    const data = await generateExpressForDate(targetDate, 'standard')
    db.prepare('INSERT OR REPLACE INTO daily_express (date, data) VALUES (?, ?)').run(targetDate, JSON.stringify(data))
    console.log(`[cron] ⚽ Football standard done for ${targetDate}`)
  } catch (err) {
    console.error('[cron] ⚽ Football standard failed:', err.message)
  }

  // Football high (pause to avoid OpenAI TPM limit)
  await new Promise(r => setTimeout(r, 5000))
  try {
    const data = await generateExpressForDate(targetDate, 'high')
    db.prepare('INSERT OR REPLACE INTO daily_express_high (date, data) VALUES (?, ?)').run(targetDate, JSON.stringify(data))
    console.log(`[cron] ⚽ Football high done for ${targetDate}`)
  } catch (err) {
    console.error('[cron] ⚽ Football high failed:', err.message)
  }

  // Hockey standard
  await new Promise(r => setTimeout(r, 5000))
  try {
    const { generateSportExpressForCron } = require('./routes/express')
    const data = await generateSportExpressForCron('hockey', 'standard', targetDate)
    db.prepare('INSERT OR REPLACE INTO express_sports (date, sport, type, data) VALUES (?, ?, ?, ?)').run(targetDate, 'hockey', 'standard', JSON.stringify(data))
    console.log(`[cron] 🏒 Hockey standard done for ${targetDate}`)
  } catch (err) {
    console.error('[cron] 🏒 Hockey standard failed:', err.message)
  }

  // Hockey high
  await new Promise(r => setTimeout(r, 5000))
  try {
    const { generateSportExpressForCron } = require('./routes/express')
    const data = await generateSportExpressForCron('hockey', 'high', targetDate)
    db.prepare('INSERT OR REPLACE INTO express_sports (date, sport, type, data) VALUES (?, ?, ?, ?)').run(targetDate, 'hockey', 'high', JSON.stringify(data))
    console.log(`[cron] 🏒 Hockey high done for ${targetDate}`)
  } catch (err) {
    console.error('[cron] 🏒 Hockey high failed:', err.message)
  }

  console.log(`[cron] All express generation complete for ${targetDate}`)
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
