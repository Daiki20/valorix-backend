const express = require('express')
const router  = express.Router()
const db      = require('../db')
const { authenticate } = require('../middleware/auth')

// Ensure table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS uploaded_images (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    filename   TEXT NOT NULL,
    mimetype   TEXT NOT NULL,
    data       BLOB NOT NULL,
    size       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

// ── POST /upload/image — save base64 image, return URL ──────────────────────
router.post('/image', authenticate, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Нет доступа' })

  const { data, filename } = req.body
  if (!data || !filename) return res.status(400).json({ error: 'Нужны data и filename' })

  // Validate base64 data URI
  const match = data.match(/^data:(image\/(?:png|jpe?g|gif|webp|svg\+xml));base64,(.+)$/)
  if (!match) return res.status(400).json({ error: 'Неверный формат изображения' })

  const mimetype = match[1]
  const buffer   = Buffer.from(match[2], 'base64')
  const maxSize  = 5 * 1024 * 1024 // 5 MB

  if (buffer.length > maxSize) return res.status(400).json({ error: 'Файл слишком большой (макс. 5 МБ)' })

  // Sanitize filename
  const safeName = filename
    .toLowerCase()
    .replace(/[^a-zа-яё0-9._-]/gi, '_')
    .slice(0, 120)

  const result = db.prepare(`
    INSERT INTO uploaded_images (filename, mimetype, data, size)
    VALUES (?, ?, ?, ?)
  `).run(safeName, mimetype, buffer, buffer.length)

  const id  = result.lastInsertRowid
  const url = `/images/${id}/${safeName}`

  res.json({ url, id, filename: safeName, size: buffer.length })
})

// ── GET /upload/list — list uploaded images (admin only) ───────────────────
router.get('/list', authenticate, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Нет доступа' })
  const images = db.prepare(`
    SELECT id, filename, mimetype, size, created_at FROM uploaded_images
    ORDER BY created_at DESC LIMIT 50
  `).all()
  res.json({ images })
})

// ── DELETE /upload/image/:id ────────────────────────────────────────────────
router.delete('/image/:id', authenticate, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Нет доступа' })
  db.prepare('DELETE FROM uploaded_images WHERE id = ?').run(parseInt(req.params.id))
  res.json({ success: true })
})

module.exports = router
