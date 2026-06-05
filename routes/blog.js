const express = require('express')
const https   = require('https')
const router  = express.Router()
const db      = require('../db')
const { authenticate } = require('../middleware/auth')

// ── IndexNow — instant ping to Bing/Yandex/Google on article publish ─────────
const INDEXNOW_KEY  = '4997fa57db99748cb057e61f8b467535'
const SITE_HOST     = 'valorix.ru'

function pingIndexNow(slug) {
  const url = `https://${SITE_HOST}/blog/${slug}`
  const body = JSON.stringify({
    host: SITE_HOST,
    key: INDEXNOW_KEY,
    keyLocation: `https://${SITE_HOST}/${INDEXNOW_KEY}.txt`,
    urlList: [url],
  })
  const req = https.request({
    hostname: 'api.indexnow.org',
    path: '/indexnow',
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) },
    timeout: 8000,
  }, res => {
    console.log(`[indexnow] ${url} → HTTP ${res.statusCode}`)
  })
  req.on('error', e => console.warn('[indexnow] ping error:', e.message))
  req.on('timeout', () => req.destroy())
  req.write(body)
  req.end()
}

// ── Helpers for article generation ───────────────────────────────────────────

const SEARCH_CACHE_TTL = 12 * 60 * 60 * 1000 // 12 hours

function normalize(s) { return (s || '').toLowerCase().replace(/[^a-zа-яё0-9]/gi, '') }

function blogCacheGet(key, ttl = SEARCH_CACHE_TTL) {
  try {
    const row = db.prepare('SELECT content, created_at FROM analysis_cache WHERE cache_key = ?').get(key)
    if (!row) return null
    if (Date.now() - row.created_at > ttl) { db.prepare('DELETE FROM analysis_cache WHERE cache_key = ?').run(key); return null }
    return row.content
  } catch { return null }
}

function blogCacheSet(key, val) {
  try {
    db.prepare('INSERT OR REPLACE INTO analysis_cache (cache_key, content, created_at) VALUES (?, ?, ?)').run(key, val, Date.now())
  } catch {}
}

function callOpenAIWithWebSearch(messages, max_tokens = 2000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'gpt-4o-search-preview',
      messages,
      max_tokens,
      web_search_options: { search_context_size: 'medium' },
    })
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      timeout: 45000,
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`OpenAI ${res.statusCode}`)); return }
        try {
          const p = JSON.parse(data)
          resolve(p?.choices?.[0]?.message?.content || '')
        } catch { reject(new Error('parse error')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.write(payload)
    req.end()
  })
}

function sstatsGet(path, params = {}) {
  const key = process.env.SSTATS_API_KEY
  if (!key) return Promise.resolve({ data: [] })
  const qs = new URLSearchParams({ ...params, apikey: key }).toString()
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.sstats.net',
      path: `${path}?${qs}`,
      method: 'GET',
      timeout: 8000,
      headers: { 'Accept': 'application/json' },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch { resolve({ data: [] }) } })
    })
    req.on('error', () => resolve({ data: [] }))
    req.on('timeout', () => { req.destroy(); resolve({ data: [] }) })
    req.end()
  })
}

function openAIChat(messages, max_tokens = 2000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'gpt-4o', messages, max_tokens, temperature: 0.7 })
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try {
          const p = JSON.parse(data)
          if (res.statusCode >= 400) return reject(new Error(p.error?.message || 'OpenAI error'))
          resolve(p.choices[0].message.content)
        } catch { reject(new Error('OpenAI parse error')) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function formatMatchDate(dateStr) {
  if (!dateStr) return ''
  try {
    return new Date(dateStr).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' })
  } catch { return dateStr }
}

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

// GET /blog/:slug — single article (increments views, unless X-No-Track header set)
router.get('/:slug', (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE slug = ? AND published = 1').get(req.params.slug)
  if (!article) return res.status(404).json({ error: 'Статья не найдена' })

  const noTrack = req.headers['x-no-track'] === '1' || req.query.notrack === '1'
  if (!noTrack) {
    db.prepare('UPDATE articles SET views = views + 1 WHERE id = ?').run(article.id)
  }
  res.json({ ...article, views: noTrack ? article.views : article.views + 1 })
})

// ── Admin routes ──────────────────────────────────────────────────────────────

// GET /blog/admin/list — all articles including drafts, filterable by sport
router.get('/admin/list', authenticate, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Нет доступа' })
  const { sport } = req.query
  const items = sport
    ? db.prepare(`SELECT id, slug, title, excerpt, published, sport, match_key, views, created_at, updated_at FROM articles WHERE sport = ? ORDER BY created_at DESC`).all(sport)
    : db.prepare(`SELECT id, slug, title, excerpt, published, sport, match_key, views, created_at, updated_at FROM articles ORDER BY created_at DESC`).all()
  res.json({ items })
})

// GET /blog/admin/match-keys — check which matches already have articles
router.get('/admin/match-keys', authenticate, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Нет доступа' })
  const rows = db.prepare('SELECT match_key FROM articles WHERE match_key IS NOT NULL').all()
  res.json({ keys: rows.map(r => r.match_key) })
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
  const { title, content, excerpt, meta_title, meta_desc, cover_url, published, slug: customSlug, sport, match_key } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'Нужен заголовок' })
  if (!content?.trim()) return res.status(400).json({ error: 'Нужен контент' })

  const baseSlug = customSlug?.trim() ? slugify(customSlug) : slugify(title)
  const slug = ensureUniqueSlug(baseSlug)

  const result = db.prepare(`
    INSERT INTO articles (slug, title, excerpt, content, meta_title, meta_desc, cover_url, published, sport, match_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(slug, title.trim(), excerpt || '', content.trim(), meta_title || title.trim(), meta_desc || excerpt || '', cover_url || '', published ? 1 : 0, sport || 'other', match_key || null)

  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(result.lastInsertRowid)
  // Пингуем IndexNow если статья опубликована
  if (article.published) pingIndexNow(article.slug)
  res.json(article)
})

// POST /blog/generate-from-match — AI генерирует статью по матчу
router.post('/generate-from-match', authenticate, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Нет доступа' })

  const { home, away, league, date, matchId, homeId, awayId, sport = 'football' } = req.body
  if (!home || !away) return res.status(400).json({ error: 'Нужны home и away' })

  const matchKey = `${sport}_${home}_${away}_${(date || '').slice(0, 10)}`

  // Не генерируем повторно если статья уже есть
  const existing = db.prepare('SELECT id, slug, title FROM articles WHERE match_key = ?').get(matchKey)
  if (existing) return res.json({ already: true, article: existing })

  try {
    const dateStr = formatMatchDate(date)
    const year = new Date().getFullYear()

    // ── Шаг 1: берём анализ из кеша или делаем web search ────────────────────
    const analysisCacheKey = `wsearch_${(sport||'f')[0]}_${normalize(home)}_${normalize(away)}`
    let analysis = null

    const cachedAnalysis = blogCacheGet(analysisCacheKey)
    if (cachedAnalysis) {
      try { analysis = JSON.parse(cachedAnalysis); console.log(`[blog] Using cached analysis for ${home} vs ${away}`) }
      catch {}
    }

    if (!analysis) {
      console.log(`[blog] Running web search analysis for ${home} vs ${away}`)
      const searchPrompt = `Ты профессиональный спортивный аналитик. Проанализируй предстоящий матч.

МАТЧ: ${home} vs ${away}
ТУРНИР: ${league || 'не указан'}
${date ? `Дата: ${date}` : ''}

ЗАДАЧА: найди в интернете актуальную информацию за ${year} год:
1. Последние 5-7 матчей ${home} — результаты, форма
2. Последние 5-7 матчей ${away} — результаты, форма
3. История очных встреч (3-5 матчей)
4. Травмы и дисквалификации ключевых игроков
5. Актуальные новости перед матчем

Ответь СТРОГО в JSON (без markdown):
{
  "verdict": "чёткий вердикт — победитель",
  "summary": "3-4 предложения с фактами из интернета",
  "confidence": число 50-90,
  "reasons": ["факт 1", "факт 2", "факт 3"],
  "extraBets": [
    {"type": "название ставки", "confidence": число},
    {"type": "название ставки", "confidence": число},
    {"type": "название ставки", "confidence": число}
  ]
}`
      try {
        const raw = await callOpenAIWithWebSearch([
          { role: 'system', content: 'Ты спортивный аналитик. Ищи реальные данные в интернете. Отвечай только JSON.' },
          { role: 'user', content: searchPrompt },
        ])
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
        let parsed
        try { parsed = JSON.parse(cleaned) }
        catch { const m = raw.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null }
        if (parsed?.verdict) {
          analysis = parsed
          blogCacheSet(analysisCacheKey, JSON.stringify(parsed))
        }
      } catch (e) { console.warn('[blog] web search failed:', e.message) }
    }

    const aiVerdict = analysis?.verdict || null
    const aiSummary = analysis?.summary || null
    const aiReasons = Array.isArray(analysis?.reasons) ? analysis.reasons : []
    const aiExtraBets = Array.isArray(analysis?.extraBets) ? analysis.extraBets.slice(0, 3) : []

    // ── Шаг 2: генерируем статью с реальным вердиктом ────────────────────────
    const verdictLine = aiVerdict || '[определи по контексту]'
    const maskBet = (text) => {
      const words = (text || '').split(' ')
      const first = words[0] || 'Ставка'
      return `${first}${'*'.repeat(Math.max(10, 20 - first.length))}`
    }
    const lockedBets = aiExtraBets.length > 0
      ? aiExtraBets.map(b => `   🔒 ${maskBet(b.type)}`).join('\n')
      : `   🔒 Тотал********************\n   🔒 Ставка*******************`

    const reasonsBlock = aiReasons.length > 0
      ? `\nКлючевые факты из анализа:\n${aiReasons.map(r => `- ${r}`).join('\n')}` : ''

    const prompt = `Ты опытный спортивный журналист. Напиши SEO-статью на русском языке о предстоящем матче.

МАТЧ: ${home} — ${away}
ЛИГА: ${league || 'не указана'}
ДАТА: ${dateStr || date || 'ближайшее время'}
ВИД СПОРТА: ${sport}
ВЕРДИКТ AI: ${verdictLine}
${aiSummary ? `АНАЛИЗ: ${aiSummary}` : ''}
${reasonsBlock}

ТРЕБОВАНИЯ:
1. Заголовок: "${home} — ${away}: прогноз на матч ${dateStr || ''}" — точно такой формат
2. Структура (## для заголовков):
   ## О матче (2-3 предложения — важность, контекст)
   ## Прогноз Valorix AI (СТРОГО по шаблону ниже!)
   ## Форма команд (используй факты из анализа выше)
   ## История встреч
   ## Итог (1-2 предложения)
3. В разделе "Прогноз Valorix AI" СТРОГО этот формат:
   🤖 **Valorix AI прогнозирует:**
   ✅ Исход: ${verdictLine}
${lockedBets}
4. CTA в конце:
   > 🔍 Полный разбор с коэффициентами → [Анализируй на Valorix](https://valorix.ru/analyze)
5. Длина: 400-600 слов. Стиль живой, уникальный.

Ответь ТОЛЬКО текстом статьи в Markdown.`

    const content = await openAIChat([
      { role: 'system', content: 'Ты спортивный журналист. Пиши живо, по-русски, уникально.' },
      { role: 'user', content: prompt },
    ])

    // Извлекаем заголовок из первой строки
    const lines = content.trim().split('\n')
    const titleLine = lines[0].replace(/^#+\s*/, '').trim()
    const articleContent = lines.slice(1).join('\n').trim()
    const excerpt = `Анализ и прогноз матча ${home} — ${away}${dateStr ? ` ${dateStr}` : ''}. Прогноз Valorix AI.`

    const slug = ensureUniqueSlug(slugify(titleLine))
    const result = db.prepare(`
      INSERT INTO articles (slug, title, excerpt, content, meta_title, meta_desc, published, sport, match_key)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(slug, titleLine, excerpt, articleContent, titleLine, excerpt, sport, matchKey)

    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(result.lastInsertRowid)
    console.log(`[blog] Generated article for ${home} vs ${away} (${sport}): "${titleLine}"`)
    res.json({ article })

  } catch (err) {
    console.error('[blog/generate]', err.message)
    res.status(500).json({ error: err.message })
  }
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

  const updated = db.prepare('SELECT * FROM articles WHERE id = ?').get(id)
  // Пингуем IndexNow если статья опубликована
  if (updated.published) pingIndexNow(updated.slug)
  res.json(updated)
})

// DELETE /blog/:id
router.delete('/:id', authenticate, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Нет доступа' })
  const result = db.prepare('DELETE FROM articles WHERE id = ?').run(parseInt(req.params.id))
  if (!result.changes) return res.status(404).json({ error: 'Не найдено' })
  res.json({ success: true })
})

module.exports = router
