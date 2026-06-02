const express = require('express')
const https   = require('https')
const router  = express.Router()
const db      = require('../db')
const { authenticate } = require('../middleware/auth')

// ── Helpers for article generation ───────────────────────────────────────────

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

// GET /blog/:slug — single article (increments views)
router.get('/:slug', (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE slug = ? AND published = 1').get(req.params.slug)
  if (!article) return res.status(404).json({ error: 'Статья не найдена' })

  db.prepare('UPDATE articles SET views = views + 1 WHERE id = ?').run(article.id)
  res.json({ ...article, views: article.views + 1 })
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
    // Получаем статистику из sstats
    let homeForm = null, awayForm = null, h2h = [], odds = null, verdict = null, totalGoals = null, corners = null

    if (matchId) {
      const [statsRes, oddsRes, h2hRes] = await Promise.allSettled([
        sstatsGet('/Games/last-games-stats', { gameId: matchId }),
        sstatsGet(`/Odds/${matchId}`),
        (homeId && awayId)
          ? sstatsGet('/Games/list', { ended: true, bothTeams: `${homeId},${awayId}`, limit: 10 })
          : Promise.resolve({ data: [] }),
      ])

      if (statsRes.status === 'fulfilled' && statsRes.value?.home) {
        homeForm = statsRes.value.home
        awayForm = statsRes.value.away
      }
      if (h2hRes.status === 'fulfilled') h2h = h2hRes.value?.data || []

      // Определяем фаворита и тоталы из реальных данных
      if (homeForm && awayForm) {
        const homeWinRate = homeForm.wins / (homeForm.gamesCount || 1)
        const awayWinRate = awayForm.wins / (awayForm.gamesCount || 1)
        verdict = homeWinRate >= awayWinRate ? `Победа ${home} (П1)` : `Победа ${away} (П2)`
        const avgGoals = ((homeForm.avgScore || 0) + (awayForm.avgConceded || 0) +
                          (awayForm.avgScore || 0) + (homeForm.avgConceded || 0)) / 2
        totalGoals = avgGoals < 2.5 ? 'ТМ 2.5' : 'ТБ 2.5'
        const avgCorners = ((homeForm.avgCorners || 0) + (awayForm.avgCorners || 0))
        corners = avgCorners > 0 ? (avgCorners < 9.5 ? 'ТМ 9.5' : 'ТБ 9.5') : null
      }
    }

    // Строим контекст для промпта
    const dateStr = formatMatchDate(date)
    const formBlock = homeForm ? `
Форма за последние ${homeForm.gamesCount} матчей:
- ${home}: ${homeForm.wins}П/${homeForm.draws}Н/${homeForm.loses}П, забивает ${homeForm.avgScore?.toFixed(2)} гола за матч
- ${away}: ${awayForm.wins}П/${awayForm.draws}Н/${awayForm.loses}П, забивает ${awayForm.avgScore?.toFixed(2)} гола за матч` : ''

    const h2hBlock = h2h.length > 0 ? `
Последние очные встречи:
${h2h.slice(0, 5).map(g => {
  const hs = g.homeFTResult ?? g.homeScore ?? '?'
  const as = g.awayFTResult ?? g.awayScore ?? '?'
  return `- ${g.homeTeam?.name} ${hs}:${as} ${g.awayTeam?.name}`
}).join('\n')}` : ''

    const predictionBlock = verdict
      ? `Прогноз Valorix AI:
- Исход: ${verdict}
- Тотал голов: ${totalGoals || 'данных недостаточно'}${corners ? `\n- Угловые: ${corners}` : ''}`
      : ''

    // Генерируем статью через OpenAI
    const prompt = `Ты опытный спортивный журналист. Напиши SEO-статью на русском языке о предстоящем матче.

МАТЧ: ${home} — ${away}
ЛИГА: ${league}
ДАТА: ${dateStr || date || 'ближайшее время'}
${formBlock}
${h2hBlock}
${predictionBlock}

ТРЕБОВАНИЯ К СТАТЬЕ:
1. Заголовок: "[${home}] — [${away}]: прогноз на матч [дата]" — точно такой формат
2. Структура (используй ## для заголовков, СТРОГО в этом порядке):
   ## О матче (2-3 предложения — важность, контекст)
   ## Прогноз Valorix AI (СТРОГО по шаблону ниже — сразу после О матче!)
   ## Форма команд (опирайся на данные выше, без выдумок)
   ## История встреч (если есть данные выше)
   ## Итог (1-2 предложения)
3. В разделе "Прогноз Valorix AI" используй СТРОГО этот формат:
   🤖 **Valorix AI прогнозирует:**
   ✅ Исход: ${verdict || '[определи сам по контексту]'}
   🔒 Тотал голов: Меньше/Больше *** *(узнать полный анализ на Valorix)*
   🔒 Угловые: Меньше/Больше *** *(узнать полный анализ на Valorix)*
4. В конце добавь CTA:
   > 🔍 Хочешь узнать полный разбор с коэффициентами и дополнительными ставками? [Анализируй матч на Valorix →](https://valorix.ru/analyze)
5. Длина: 400-600 слов
6. Каждая статья должна быть уникальной по стилю и структуре подачи
7. НЕ выдумывай статистику которой нет в данных выше

Ответь ТОЛЬКО текстом статьи в Markdown, без json и без пояснений.`

    const content = await openAIChat([
      { role: 'system', content: 'Ты спортивный журналист. Пиши живо, по-русски, уникально каждый раз.' },
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
