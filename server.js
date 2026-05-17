require('dotenv').config()
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')

const authRoutes = require('./routes/auth')
const coinsRoutes = require('./routes/coins')
const adminRoutes = require('./routes/admin')
const analyzeRoutes = require('./routes/analyze')

const app = express()
const PORT = process.env.PORT || 3001

// ── Trust proxy (Railway, Vercel и др. используют reverse proxy) ──
app.set('trust proxy', 1)

// ── Security headers ──────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}))

// ── CORS ──────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }))

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

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }))

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
