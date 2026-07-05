const jwt = require('jsonwebtoken')
const db = require('../db')

function authenticate(req, res, next) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Требуется авторизация' })
  }

  const token = header.slice(7)
  const secret = process.env.JWT_SECRET
  if (!secret) return res.status(500).json({ error: 'Ошибка конфигурации сервера' })
  try {
    const payload = jwt.verify(token, secret)
    if (!payload?.userId) return res.status(401).json({ error: 'Недействительный токен' })
    const user = db.prepare('SELECT id, email, username, coins, is_admin, is_blocked, bonus_expires_at FROM users WHERE id = ?').get(payload.userId)
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' })
    if (user.is_blocked) return res.status(403).json({ error: 'Аккаунт заблокирован' })
    req.user = user
    next()
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError || err instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: 'Недействительный токен' })
    }
    console.error('[auth]', err.message)
    res.status(500).json({ error: 'Ошибка сервера' })
  }
}

module.exports = { authenticate }
