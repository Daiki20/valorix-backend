const express = require('express')
const db = require('../db')
const { authenticate } = require('../middleware/auth')
const { requireAdmin } = require('../middleware/admin')

const router = express.Router()

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
