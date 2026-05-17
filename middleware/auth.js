const jwt = require('jsonwebtoken')
const db = require('../db')

function authenticate(req, res, next) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Требуется авторизация' })
  }

  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    const user = db.prepare('SELECT id, email, username, coins, is_admin, is_blocked FROM users WHERE id = ?').get(payload.userId)
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' })
    if (user.is_blocked) return res.status(403).json({ error: 'Аккаунт заблокирован' })
    req.user = user
    next()
  } catch {
    res.status(401).json({ error: 'Недействительный токен' })
  }
}

module.exports = { authenticate }
