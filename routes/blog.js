const express = require('express')
const https   = require('https')
const router  = express.Router()
const db      = require('../db')
const { authenticate } = require('../middleware/auth')

// ── IndexNow — instant ping to Bing/Yandex/Google on article publish ─────────
const INDEXNOW_KEY  = '4997fa57db99748cb057e61f8b467535'
const SITE_HOST     = 'valorix.ru'
const GITHUB_REPO   = process.env.GITHUB_REPO || 'Daiki20/valorix-frontend'

// ── Generate static HTML for an article ──────────────────────────────────────
function generateStaticHtml(article) {
  const e = (s) => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
  const title    = e(article.title || '')
  const desc     = e(article.excerpt || article.meta_desc || '')
  const canonical = `https://valorix.ru/blog/${e(article.slug)}`
  const cover    = article.cover_url ? e(article.cover_url) : ''
  const dateStr  = new Date(article.created_at).toLocaleDateString('ru-RU', {day:'numeric',month:'long',year:'numeric'})
  const sportBadge = article.sport && article.sport !== 'other'
    ? `<span class="badge">${{football:'⚽ Футбол',hockey:'🏒 Хоккей',cs2:'🔫 CS2',dota2:'🎮 Dota 2'}[article.sport] || article.sport}</span>`
    : ''
  const bodyHtml = (article.content || '')
    .replace(/!\[([^\]]*)\]\([^\)]+\)/g, '')
    .replace(/\[([^\]]+)\]\(([^\)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^#{1,6}\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, s => `<ul>${s}</ul>`)
    .replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(?!<[hublp])(.+)$/gm, '$1')
  const schema = JSON.stringify({
    '@context':'https://schema.org','@type':'Article',
    headline: article.title, description: article.excerpt || '',
    image: article.cover_url || undefined,
    datePublished: article.created_at, dateModified: article.updated_at,
    author:{'@type':'Organization',name:'Valorix AI'},
    publisher:{'@type':'Organization',name:'Valorix AI',url:'https://valorix.ru'},
    mainEntityOfPage:{'@type':'WebPage','@id':canonical}
  })
  const preloaded = JSON.stringify({id:article.id,slug:article.slug,title:article.title,sport:article.sport})
    .replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026')

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Valorix AI</title>
  <meta name="description" content="${desc}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${desc}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${canonical}">
  <meta property="og:site_name" content="Valorix AI">
  ${cover ? `<meta property="og:image" content="${cover}">` : ''}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${desc}">
  ${cover ? `<meta name="twitter:image" content="${cover}">` : ''}
  <link rel="canonical" href="${canonical}">
  <script type="application/ld+json">${schema}</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#030b18;color:#d8eeff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;padding:2rem 1rem}
    .wrap{max-width:760px;margin:0 auto}
    a{color:#00cfff;text-decoration:none}
    h1{font-size:clamp(1.6rem,4vw,2.2rem);font-weight:900;margin:1rem 0 1.5rem;line-height:1.2;color:#fff}
    h2{font-size:1.3rem;font-weight:800;color:#fff;margin:2rem 0 0.8rem;border-bottom:1px solid rgba(0,207,255,0.15);padding-bottom:.4rem}
    p{color:#94a3b8;margin-bottom:1rem;font-size:.98rem}
    strong{color:#00cfff;font-weight:700}
    ul{color:#94a3b8;padding-left:1.5rem;margin-bottom:1rem}
    li{margin-bottom:.3rem}
    blockquote{border-left:3px solid #00cfff;padding:.5rem 1rem;background:rgba(0,207,255,0.05);margin:1rem 0;color:#94a3b8;border-radius:0 8px 8px 0}
    .meta{color:#475569;font-size:.85rem;margin-bottom:2rem;display:flex;gap:1rem;flex-wrap:wrap}
    .badge{background:rgba(34,197,94,.1);color:#4ade80;padding:3px 12px;border-radius:20px;font-size:.75rem;font-weight:700;border:1px solid rgba(34,197,94,.2)}
    .cta{margin-top:3rem;padding:1.5rem;background:rgba(0,207,255,.06);border:1px solid rgba(0,207,255,.2);border-radius:16px;text-align:center}
    .cta a{display:inline-block;background:linear-gradient(135deg,#00cfff,#6366f1);color:#000;font-weight:800;padding:.8rem 2rem;border-radius:12px;font-size:.95rem;margin-top:.8rem}
    nav{margin-bottom:2rem}
    ${cover ? 'img.cover{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:16px;margin-bottom:1.5rem;border:1px solid rgba(0,207,255,.15)}' : ''}
  </style>
</head>
<body>
  <div class="wrap">
    <nav><a href="https://valorix.ru">← Valorix AI</a> / <a href="https://valorix.ru/blog">Блог</a></nav>
    ${cover ? `<img class="cover" src="${cover}" alt="${title}" loading="eager">` : ''}
    <h1>${title}</h1>
    <div class="meta"><span>${dateStr}</span>${sportBadge}</div>
    ${desc ? `<p><em>${desc}</em></p>` : ''}
    <div>${bodyHtml}</div>
    <div class="cta">
      <p>Хочешь AI-анализ любого матча?</p>
      <a href="https://valorix.ru/analyze">Попробовать бесплатно →</a>
    </div>
  </div>
  <script>
    fetch('https://web-production-fefcd.up.railway.app/blog/${article.slug}').catch(()=>{});
    window.__PRELOADED_ARTICLE__ = ${preloaded};
  </script>
</body>
</html>`
}

// ── Commit static HTML to GitHub repo (triggers gh-pages rebuild) ─────────────
function commitStaticToGithub(article) {
  const token = process.env.GITHUB_TOKEN
  if (!token) { console.warn('[github] GITHUB_TOKEN not set'); return Promise.resolve({ skipped: true }) }
  const path = `public/blog/${article.slug}/index.html`
  const htmlContent = generateStaticHtml(article)
  const contentB64 = Buffer.from(htmlContent, 'utf8').toString('base64')

  return new Promise((resolve) => {
    // Get existing SHA if file already exists
    const getOpts = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${path}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'valorix-backend', 'Accept': 'application/vnd.github.v3+json' },
      timeout: 10000,
    }
    const getReq = https.request(getOpts, getRes => {
      let d = ''
      getRes.on('data', c => d += c)
      getRes.on('end', () => {
        let sha = null
        if (getRes.statusCode === 200) { try { sha = JSON.parse(d).sha } catch {} }
        const body = JSON.stringify({
          message: `blog: static HTML for "${article.title}"`,
          content: contentB64,
          ...(sha ? { sha } : {}),
        })
        const putOpts = {
          hostname: 'api.github.com',
          path: `/repos/${GITHUB_REPO}/contents/${path}`,
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`, 'User-Agent': 'valorix-backend',
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
          },
          timeout: 20000,
        }
        const putReq = https.request(putOpts, putRes => {
          let pd = ''
          putRes.on('data', c => pd += c)
          putRes.on('end', () => {
            console.log(`[github] static HTML for ${article.slug} → HTTP ${putRes.statusCode}`)
            resolve({ status: putRes.statusCode })
          })
        })
        putReq.on('error', e => { console.warn('[github] put error:', e.message); resolve({ error: e.message }) })
        putReq.on('timeout', () => { putReq.destroy(); resolve({ error: 'timeout' }) })
        putReq.write(body)
        putReq.end()
      })
    })
    getReq.on('error', () => resolve({ error: 'get failed' }))
    getReq.on('timeout', () => { getReq.destroy(); resolve({ error: 'get timeout' }) })
    getReq.end()
  })
}

// ── Generate and commit sitemap.xml to GitHub ────────────────────────────────
function commitSitemapToGithub() {
  const token = process.env.GITHUB_TOKEN
  if (!token) return Promise.resolve({ skipped: true })

  let articles
  try {
    articles = db.prepare(`
      SELECT slug, updated_at, created_at FROM articles
      WHERE published = 1 ORDER BY created_at DESC
    `).all()
  } catch (e) {
    return Promise.resolve({ error: e.message })
  }

  const now = new Date().toISOString().slice(0, 10)
  const staticPages = [
    { loc: 'https://valorix.ru/', priority: '1.0', changefreq: 'daily' },
    { loc: 'https://valorix.ru/blog/', priority: '0.9', changefreq: 'daily' },
    { loc: 'https://valorix.ru/analyze/', priority: '0.9', changefreq: 'weekly' },
  ]

  const urlEntries = [
    ...staticPages.map(p => `  <url>
    <loc>${p.loc}</loc>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
    <lastmod>${now}</lastmod>
  </url>`),
    ...articles.map(a => {
      const lastmod = (a.updated_at || a.created_at || now).slice(0, 10)
      return `  <url>
    <loc>https://valorix.ru/blog/${a.slug}/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
    <lastmod>${lastmod}</lastmod>
  </url>`
    }),
  ]

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries.join('\n')}
</urlset>`

  const contentB64 = Buffer.from(xml, 'utf8').toString('base64')
  const path = 'public/sitemap.xml'

  return new Promise((resolve) => {
    const getOpts = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${path}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'valorix-backend', 'Accept': 'application/vnd.github.v3+json' },
      timeout: 10000,
    }
    const getReq = https.request(getOpts, getRes => {
      let d = ''
      getRes.on('data', c => d += c)
      getRes.on('end', () => {
        let sha = null
        if (getRes.statusCode === 200) { try { sha = JSON.parse(d).sha } catch {} }
        const body = JSON.stringify({
          message: `seo: update sitemap.xml (${articles.length} articles)`,
          content: contentB64,
          ...(sha ? { sha } : {}),
        })
        const putOpts = {
          hostname: 'api.github.com',
          path: `/repos/${GITHUB_REPO}/contents/${path}`,
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`, 'User-Agent': 'valorix-backend',
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
          },
          timeout: 20000,
        }
        const putReq = https.request(putOpts, putRes => {
          let pd = ''
          putRes.on('data', c => pd += c)
          putRes.on('end', () => {
            console.log(`[sitemap] committed ${articles.length} URLs → HTTP ${putRes.statusCode}`)
            resolve({ status: putRes.statusCode, count: articles.length })
          })
        })
        putReq.on('error', e => { console.warn('[sitemap] put error:', e.message); resolve({ error: e.message }) })
        putReq.on('timeout', () => { putReq.destroy(); resolve({ error: 'timeout' }) })
        putReq.write(body)
        putReq.end()
      })
    })
    getReq.on('error', () => resolve({ error: 'get failed' }))
    getReq.on('timeout', () => { getReq.destroy(); resolve({ error: 'get timeout' }) })
    getReq.end()
  })
}

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

  // Пингуем Google sitemap (просит перечитать весь sitemap)
  const googleReq = https.request({
    hostname: 'www.google.com',
    path: `/ping?sitemap=https://${SITE_HOST}/sitemap.xml`,
    method: 'GET',
    timeout: 8000,
  }, res => {
    console.log(`[google-ping] sitemap ping → HTTP ${res.statusCode}`)
  })
  googleReq.on('error', e => console.warn('[google-ping] error:', e.message))
  googleReq.on('timeout', () => googleReq.destroy())
  googleReq.end()
}

// ── Sanitize AI-generated article content ────────────────────────────────────
function sanitizeArticleContent(content) {
  if (!content) return content
  return content
    // Убираем emoji из заголовков (строки начинающиеся с #)
    .replace(/^(#{1,6}\s*)([^\n]*)/gm, (_, hashes, text) => {
      const cleaned = text.replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/gu, '').trim()
      return hashes + cleaned
    })
    // Схлопываем пустые строки внутри блока прогноза (между 🤖/✅/🔒 строками)
    .replace(/((?:^[🤖✅🔒][^\n]*\n?)(?:\n+[🤖✅🔒][^\n]*\n?)+)/gm, match =>
      match.replace(/\n{2,}/g, '\n')
    )
    // Убираем emoji из середины обычных слов (оставляем только в начале строки)
    .replace(/([а-яёА-ЯЁa-zA-Z])[\u{1F300}-\u{1FAFF}]([а-яёА-ЯЁa-zA-Z])/gu, '$1$2')
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

// GET /blog/related/:slug — 3 related articles (same sport, excluding current)
router.get('/related/:slug', (req, res) => {
  const article = db.prepare('SELECT id, sport FROM articles WHERE slug = ? AND published = 1').get(req.params.slug)
  if (!article) return res.json({ items: [] })

  // Сначала ищем по тому же виду спорта, потом добираем любые
  const sameSport = db.prepare(`
    SELECT id, slug, title, excerpt, cover_url, sport, created_at
    FROM articles WHERE published = 1 AND id != ? AND sport = ?
    ORDER BY created_at DESC LIMIT 3
  `).all(article.id, article.sport)

  const items = sameSport.length >= 3 ? sameSport :
    db.prepare(`
      SELECT id, slug, title, excerpt, cover_url, sport, created_at
      FROM articles WHERE published = 1 AND id != ?
      ORDER BY created_at DESC LIMIT 3
    `).all(article.id)

  res.json({ items })
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
  if (article.published) {
    pingIndexNow(article.slug)
    commitStaticToGithub(article).catch(e => console.warn('[github]', e.message))
    commitSitemapToGithub().catch(e => console.warn('[sitemap]', e.message))
  }
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
2. Структура (## для заголовков, БЕЗ emoji в заголовках):
   ## О матче (2-3 предложения — важность, контекст)
   ## Прогноз Valorix AI (СТРОГО по шаблону ниже!)
   ## Форма команд (используй факты из анализа выше)
   ## История встреч
   ## Итог (1-2 предложения)
3. В разделе "Прогноз Valorix AI" СТРОГО этот формат (все строки подряд БЕЗ пустых строк между ними):
   🤖 **Valorix AI прогнозирует:**
   ✅ Исход: ${verdictLine}
${lockedBets}
4. CTA в конце:
   > 🔍 Полный разбор с коэффициентами → [Анализируй на Valorix](https://valorix.ru/analyze)
5. Длина: 400-600 слов. Стиль живой, уникальный.
6. ВАЖНО: НЕ используй emoji внутри слов и в заголовках (##). Emoji только в блоке прогноза (🤖 ✅ 🔒) и CTA (🔍).

Ответь ТОЛЬКО текстом статьи в Markdown.`

    const rawContent = await openAIChat([
      { role: 'system', content: 'Ты спортивный журналист. Пиши живо, по-русски, уникально. Не вставляй emoji в заголовки и середину слов.' },
      { role: 'user', content: prompt },
    ])

    // Пост-обработка: убираем emoji из заголовков и схлопываем блок прогноза
    const content = sanitizeArticleContent(rawContent)

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
    if (article.published) commitStaticToGithub(article).catch(e => console.warn('[github]', e.message))
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
  if (updated.published) {
    pingIndexNow(updated.slug)
    commitStaticToGithub(updated).catch(e => console.warn('[github]', e.message))
    commitSitemapToGithub().catch(e => console.warn('[sitemap]', e.message))
  }
  res.json(updated)
})

// POST /blog/push-static/:id — вручную запушить статический HTML для любой статьи
router.post('/push-static/:id', authenticate, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Нет доступа' })
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(parseInt(req.params.id))
  if (!article) return res.status(404).json({ error: 'Статья не найдена' })
  if (!article.published) return res.status(400).json({ error: 'Статья не опубликована' })
  const result = await commitStaticToGithub(article)
  commitSitemapToGithub().catch(e => console.warn('[sitemap]', e.message))
  res.json({ success: true, slug: article.slug, github: result })
})

// POST /blog/generate-sitemap — вручную перегенерировать sitemap.xml
router.post('/generate-sitemap', authenticate, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Нет доступа' })
  const result = await commitSitemapToGithub()
  res.json({ success: !result.error, ...result })
})

// DELETE /blog/:id
router.delete('/:id', authenticate, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Нет доступа' })
  const result = db.prepare('DELETE FROM articles WHERE id = ?').run(parseInt(req.params.id))
  if (!result.changes) return res.status(404).json({ error: 'Не найдено' })
  res.json({ success: true })
})

// POST /blog/generate-custom — AI генерирует статью на произвольную тему
router.post('/generate-custom', authenticate, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Нет доступа' })

  const { topic, sport = 'other' } = req.body
  if (!topic?.trim()) return res.status(400).json({ error: 'Нужна тема статьи (topic)' })

  try {
    // Шаг 1: web-search для сбора актуальных фактов по теме
    const year = new Date().getFullYear()
    let facts = null
    const factsCacheKey = `custom_facts_${normalize(topic)}`
    const cached = blogCacheGet(factsCacheKey)
    if (cached) { try { facts = cached } catch {} }

    if (!facts) {
      try {
        facts = await callOpenAIWithWebSearch([
          { role: 'system', content: 'Ты спортивный аналитик. Ищи реальные данные в интернете. Отвечай на русском.' },
          { role: 'user', content: `Найди актуальную информацию за ${year} год по теме: "${topic}". Собери ключевые факты, статистику, мнения экспертов, последние новости. Дай структурированный ответ с конкретными данными.` },
        ], 1500)
        blogCacheSet(factsCacheKey, facts)
      } catch (e) {
        console.warn('[blog/generate-custom] web search failed:', e.message)
        facts = ''
      }
    }

    // Шаг 2: генерируем статью в стиле Valorix
    const prompt = `Ты опытный спортивный журналист сайта Valorix.ru — сервиса AI-анализа матчей. Напиши SEO-статью на русском языке.

ТЕМА: ${topic}
ВИД СПОРТА: ${sport}
${facts ? `\nАКТУАЛЬНЫЕ ДАННЫЕ ИЗ ИНТЕРНЕТА:\n${facts}` : ''}

ТРЕБОВАНИЯ:
1. Заголовок — цепляющий, SEO-оптимизированный, отражает тему
2. Структура (## для заголовков, БЕЗ emoji в заголовках):
   ## Текущее положение дел (2-3 предложения — контекст, актуальность)
   ## Главные претенденты (разбор фаворитов с фактами)
   ## Тёмные лошадки (кто может удивить)
   ## Прогноз Valorix AI (СТРОГО по шаблону ниже!)
   ## Итог (1-2 предложения с выводом)
3. В разделе "Прогноз Valorix AI" СТРОГО этот формат (строки подряд, БЕЗ пустых строк):
   🤖 **Valorix AI прогнозирует:**
   ✅ Фаворит: [назови главного фаворита на основе фактов]
   🔒 Ставка на победителя**************
   🔒 Тотал карт/фрагов*****************
4. CTA в конце:
   > 🔍 Хочешь AI-анализ конкретного матча? → [Анализируй на Valorix](https://valorix.ru/analyze)
5. Длина: 500-700 слов. Стиль живой, уникальный, экспертный.
6. НЕ используй emoji в заголовках (##) и внутри слов. Emoji только в блоке прогноза и CTA.

Ответь ТОЛЬКО текстом статьи в Markdown.`

    const rawContent = await openAIChat([
      { role: 'system', content: 'Ты спортивный журналист Valorix.ru. Пиши живо, по-русски, уникально. Не вставляй emoji в заголовки.' },
      { role: 'user', content: prompt },
    ])

    const content = sanitizeArticleContent(rawContent)
    const lines = content.trim().split('\n')
    const titleLine = lines[0].replace(/^#+\s*/, '').trim()
    const articleContent = lines.slice(1).join('\n').trim()
    const excerpt = `${topic}. Анализ и прогноз от Valorix AI.`

    const slug = ensureUniqueSlug(slugify(titleLine))
    const result = db.prepare(`
      INSERT INTO articles (slug, title, excerpt, content, meta_title, meta_desc, published, sport)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(slug, titleLine, excerpt, articleContent, titleLine, excerpt, sport)

    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(result.lastInsertRowid)
    console.log(`[blog] Generated custom article "${titleLine}" (sport: ${sport})`)
    if (article.published) commitStaticToGithub(article).catch(e => console.warn('[github]', e.message))
    res.json({ article })

  } catch (err) {
    console.error('[blog/generate-custom]', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
