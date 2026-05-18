const express = require('express')
const router = express.Router()
const db = require('../db')
const { authenticate } = require('../middleware/auth')
const { requireAdmin } = require('../middleware/admin')

// GET /predictions/stats — публичная статистика точности AI
router.get('/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM analyses WHERE predicted_side IS NOT NULL').get()
  const verified = db.prepare('SELECT COUNT(*) as cnt FROM analyses WHERE is_correct IS NOT NULL').get()
  const correct = db.prepare('SELECT COUNT(*) as cnt FROM analyses WHERE is_correct = 1').get()

  const winRate = verified.cnt > 0 ? Math.round((correct.cnt / verified.cnt) * 100) : null
  const totalAnalyses = db.prepare('SELECT COUNT(*) as cnt FROM analyses').get()

  // Last 10 verified predictions for display
  const recent = db.prepare(`
    SELECT match_home, match_away, league, verdict, predicted_side, actual_side, is_correct, created_at
    FROM analyses
    WHERE is_correct IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 10
  `).all()

  res.json({
    totalAnalyses: totalAnalyses.cnt,
    totalPredictions: total.cnt,
    verifiedCount: verified.cnt,
    correctCount: correct.cnt,
    winRate,
    recent,
  })
})

// GET /predictions/my — прогнозы текущего пользователя
router.get('/my', authenticate, (req, res) => {
  const rows = db.prepare(`
    SELECT id, match_home, match_away, league, verdict, predicted_side, actual_side, is_correct, sport, created_at
    FROM analyses
    WHERE user_id = ? AND predicted_side IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 30
  `).all(req.user.id)

  const verified = rows.filter(r => r.is_correct !== null)
  const correct = verified.filter(r => r.is_correct === 1)
  const winRate = verified.length > 0 ? Math.round((correct.length / verified.length) * 100) : null

  res.json({ predictions: rows, winRate, verifiedCount: verified.length, correctCount: correct.length })
})

// PUT /predictions/:id/result — админ вносит реальный результат
router.put('/:id/result', authenticate, requireAdmin, (req, res) => {
  const { actual_side } = req.body  // '1', 'X' или '2'
  const { id } = req.params

  if (!['1', 'X', '2'].includes(actual_side)) {
    return res.status(400).json({ error: 'actual_side должен быть 1, X или 2' })
  }

  const row = db.prepare('SELECT predicted_side FROM analyses WHERE id = ?').get(id)
  if (!row) return res.status(404).json({ error: 'Прогноз не найден' })

  const is_correct = row.predicted_side === actual_side ? 1 : 0
  db.prepare('UPDATE analyses SET actual_side = ?, is_correct = ? WHERE id = ?')
    .run(actual_side, is_correct, id)

  res.json({ success: true, is_correct: !!is_correct })
})

// GET /predictions/pending — список непроверенных прогнозов (для админа)
router.get('/pending', authenticate, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT id, match_home, match_away, league, verdict, predicted_side, sport, created_at
    FROM analyses
    WHERE predicted_side IS NOT NULL AND actual_side IS NULL
    ORDER BY created_at DESC
    LIMIT 50
  `).all()
  res.json({ predictions: rows })
})

module.exports = router
