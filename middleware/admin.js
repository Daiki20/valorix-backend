function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Доступ запрещён' })
  }
  next()
}

module.exports = { requireAdmin }
