const express = require('express')
const router  = express.Router()
const db      = require('../db')
const { authenticate } = require('../middleware/auth')

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(text) {
  const map = {
    а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'j',
    к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',
    х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
  }
  return (text || '')
    .toLowerCase()
    .split('')
    .map(c => map[c] !== undefined ? map[c] : c)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function ensureUniqueSlug(base, excludeId = null) {
  let slug = base, n = 1
  while (true) {
    const row = db.prepare('SELECT id FROM articles WHERE slug = ?').get(slug)
    if (!row || row.id === excludeId) return slug
    slug = `${base}-${n++}`
  }
}

// ── Public routes ─────────────────────────────────────────────────────────────

// GET /blog — list published articles (newest first)
router.get('/', (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page) || 1)
  const limit = Math.min(20, parseInt(req.query.limit) || 10)
  const offset = (page - 1) * limit

  const total = db.prepare('SELECT COUNT(*) as n FROM articles WHERE published = 1').get().n
  const items = db.prepare(`
    SELECT id, slug, title, excerpt, cover_url, views, created_at
    FROM articles WHERE published = 1
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset)

  res.json({ total, page, limit, items })
})

// GET /blog/:slug — single article (increments views)
router.get('/:slug', (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE slug = ? AND published = 1').get(req.params.slug)
  if (!article) return res.status(404).json({ error: 'Статья не найдена' })

  db.prepare('UPDATE articles SET views = views + 1 WHERE id = ?').run(article.id)
  res.json({ ...article, views: article.views + 1 })
})

// ── Admin routes ──────────────────────────────────────────────────────────────

// GET /blog/admin/list — all articles including drafts
router.get('/admin/list', authenticate, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Нет доступа' })
  const items = db.prepare(`
    SELECT id, slug, title, excerpt, published, views, created_at, updated_at
    FROM articles ORDER BY created_at DESC
  `).all()
  res.json({ items })
})

// GET /blog/admin/:id — get article by id (for editing)
router.get('/admin/:id', authenticate, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Нет доступа' })
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id)
  if (!article) return res.status(404).json({ error: 'Не найдено' })
  res.json(article)
})

// POST /blog — create article
router.post('/', authenticate, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Нет доступа' })
  const { title, content, excerpt, meta_title, meta_desc, cover_url, published, slug: customSlug } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'Нужен заголовок' })
  if (!content?.trim()) return res.status(400).json({ error: 'Нужен контент' })

  const baseSlug = customSlug?.trim() ? slugify(customSlug) : slugify(title)
  const slug = ensureUniqueSlug(baseSlug)

  const result = db.prepare(`
    INSERT INTO articles (slug, title, excerpt, content, meta_title, meta_desc, cover_url, published)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(slug, title.trim(), excerpt || '', content.trim(), meta_title || title.trim(), meta_desc || excerpt || '', cover_url || '', published ? 1 : 0)

  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(result.lastInsertRowid)
  res.json(article)
})

// PUT /blog/:id — update article
router.put('/:id', authenticate, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Нет доступа' })
  const { title, content, excerpt, meta_title, meta_desc, cover_url, published, slug: customSlug } = req.body
  const id = parseInt(req.params.id)

  const existing = db.prepare('SELECT * FROM articles WHERE id = ?').get(id)
  if (!existing) return res.status(404).json({ error: 'Не найдено' })

  const newSlug = customSlug?.trim()
    ? ensureUniqueSlug(slugify(customSlug), id)
    : existing.slug

  db.prepare(`
    UPDATE articles SET
      slug = ?, title = ?, excerpt = ?, content = ?,
      meta_title = ?, meta_desc = ?, cover_url = ?,
      published = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    newSlug,
    title?.trim() || existing.title,
    excerpt ?? existing.excerpt,
    content?.trim() || existing.content,
    meta_title || title?.trim() || existing.meta_title,
    meta_desc || excerpt || existing.meta_desc,
    cover_url ?? existing.cover_url,
    published !== undefined ? (published ? 1 : 0) : existing.published,
    id
  )

  res.json(db.prepare('SELECT * FROM articles WHERE id = ?').get(id))
})

// DELETE /blog/:id
router.delete('/:id', authenticate, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Нет доступа' })
  const result = db.prepare('DELETE FROM articles WHERE id = ?').run(parseInt(req.params.id))
  if (!result.changes) return res.status(404).json({ error: 'Не найдено' })
  res.json({ success: true })
})

module.exports = router
