const express = require('express')
const router = express.Router()
const db = require('../db')

// GET /share/:token — public, no auth required
router.get('/:token', (req, res) => {
  const row = db.prepare('SELECT match_home, match_away, league, result, created_at FROM analyses WHERE share_token = ?').get(req.params.token)
  if (!row) return res.status(404).json({ error: 'Анализ не найден или ссылка недействительна' })
  let result = {}
  try { result = JSON.parse(row.result || '{}') } catch {}
  res.json({ match_home: row.match_home, match_away: row.match_away, league: row.league, created_at: row.created_at, result })
})

module.exports = router
