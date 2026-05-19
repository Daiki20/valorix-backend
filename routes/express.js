const express = require('express')
const https = require('https')
const db = require('../db')
const { authenticate } = require('../middleware/auth')
const { translateTeam } = require('../teamNames')

const router = express.Router()
const EXPRESS_COST_STANDARD = 39
const EXPRESS_COST_HIGH = 49

const TOP_LEAGUE_IDS = [2, 3, 848, 39, 140, 135, 78, 61, 235]

function getTomorrowDate() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

function getTodayDate() {
  return new Date().toISOString().slice(0, 10)
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('JSON parse error')) }
      })
    }).on('error', reject)
  })
}

function openAIRequest(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'gpt-4o', messages, temperature: 0.7, max_tokens: 1500 })
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
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (res.statusCode >= 400) reject(new Error(parsed.error?.message || 'OpenAI error'))
          else resolve(parsed.choices[0].message.content)
        } catch { reject(new Error('OpenAI parse error')) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function fetchRealMatches(targetDate) {
  const key = process.env.SSTATS_API_KEY
  if (!key) return []

  const results = await Promise.all(
    TOP_LEAGUE_IDS.map(id =>
      httpsGet(`https://api.sstats.net/Games/list?upcoming=true&leagueid=${id}&limit=10&apikey=${key}`)
        .catch(() => ({ data: [] }))
    )
  )

  const allGames = results.flatMap(r => Array.isArray(r.data) ? r.data : [])

  return allGames
    .filter(g => g.date && g.homeTeam?.name && g.awayTeam?.name && g.date.slice(0, 10) === targetDate)
    .map(g => ({ id: g.id, home: translateTeam(g.homeTeam.name), away: translateTeam(g.awayTeam.name), league: g.season?.league?.name || 'Unknown' }))
}

async function fetchOddsText(gameId) {
  const key = process.env.SSTATS_API_KEY
  if (!key || !gameId) return null
  try {
    const res = await httpsGet(`https://api.sstats.net/Odds/${gameId}?apikey=${key}`)
    const bookmakers = Array.isArray(res.data) ? res.data : []
    if (!bookmakers.length) return null

    const bk = bookmakers.reduce((best, cur) =>
      (cur.odds?.length || 0) > (best.odds?.length || 0) ? cur : best
    , bookmakers[0])

    const lines = []
    for (const market of (bk.odds || [])) {
      if (!market.odds?.length) continue
      const outcomeParts = market.odds.map(o => `${o.name} = ${o.value}`).join(', ')
      lines.push(`  [${market.marketName || market.marketId}]: ${outcomeParts}`)
    }
    return lines.length ? `${bk.bookmakerName}:\n${lines.join('\n')}` : null
  } catch {
    return null
  }
}

const ODDS_TRANSLATION = `Перевод названий ставок на русский (пиши полное понятное название):
- Home → Победа хозяев (П1)
- Away → Победа гостей (П2)
- Draw → Ничья (X)
- Home/Draw → Двойной шанс (1X)
- Away/Draw → Двойной шанс (X2)
- Over N → Тотал больше N (ТБ N)
- Under N → Тотал меньше N (ТМ N)
- Both Teams Score - Yes → Обе команды забьют
- Both Teams Score - No → Обе команды не забьют
- Asian Handicap Home N → Фора хозяев (N)
- Asian Handicap Away N → Фора гостей (N)`

async function generateExpress(targetDate, type = 'standard') {
  const realMatches = await fetchRealMatches(targetDate)

  if (realMatches.length >= 2) {
    const oddsTexts = await Promise.all(realMatches.map(m => fetchOddsText(m.id)))

    const matchesWithOdds = realMatches.filter((m, i) => oddsTexts[i] !== null)
    const filteredOdds = oddsTexts.filter(o => o !== null)
    const useMatches = matchesWithOdds.length >= 2 ? matchesWithOdds : realMatches
    const useOdds = matchesWithOdds.length >= 2 ? filteredOdds : oddsTexts

    const matchBlocks = useMatches.map((m, i) => {
      const oddsBlock = useOdds[i]
        ? `\n${useOdds[i]}`
        : '\n  (коэффициенты недоступны — пропусти этот матч)'
      return `${i + 1}. ${m.home} — ${m.away} (${m.league})${oddsBlock}`
    }).join('\n\n')

    const isHigh = type === 'high'
    const oddsRequirement = isHigh
      ? `- Итоговый коэффициент экспресса должен быть НЕ МЕНЕЕ 4.00
- Выбирай более смелые исходы: победы андердогов, форы, тоталы с высоким коэфом (≥1.50)
- 3-4 события, каждый коэффициент от 1.40 и выше
- Вероятность прохода каждой ставки >50%`
      : `- Итоговый коэффициент экспресса от 2.00 до 4.00
- Выбирай надёжные исходы с высокой вероятностью прохода >65%
- 2-3 события, минимальный коэффициент 1.33, максимальный 2.20`

    const prompt = `Ты — эксперт по ставкам на спорт. Составь ${isHigh ? 'ВЫСОКОДОХОДНЫЙ' : 'НАДЁЖНЫЙ'} экспресс из РЕАЛЬНОГО расписания на ${targetDate}.

РЕАЛЬНЫЕ МАТЧИ С КОЭФФИЦИЕНТАМИ НА ${targetDate}:
${matchBlocks}

Требования:
- Выбирай ТОЛЬКО из матчей выше
- Для каждого пика ОБЯЗАТЕЛЬНО используй РЕАЛЬНЫЙ коэффициент из списка выше
- В поле "odds" ставь ТОЧНОЕ число из списка коэффициентов
- Поля home/away/league — ТОЧНО как в списке выше
- ВСЕ текстовые поля — СТРОГО на русском языке
${oddsRequirement}

${ODDS_TRANSLATION}

Ответь ТОЛЬКО валидным JSON:
{
  "date": "${targetDate}",
  "picks": [
    {
      "home": "название из списка",
      "away": "название из списка",
      "league": "лига из списка",
      "prediction": "Ставка на русском",
      "odds": 1.55,
      "reasoning": "Обоснование на русском 1-2 предложения"
    }
  ],
  "total_odds": 3.47,
  "summary": "Краткое описание экспресса на русском"
}`

    const content = await openAIRequest([
      { role: 'system', content: 'Ты эксперт по ставкам. Отвечай только валидным JSON на русском языке. Используй только реальные коэффициенты из предоставленного списка.' },
      { role: 'user', content: prompt },
    ])

    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('Invalid JSON from OpenAI')
    const data = JSON.parse(jsonMatch[0])
    if (!data.picks || data.picks.length < 2) throw new Error('Not enough picks')

    const total = data.picks.reduce((acc, p) => acc * (parseFloat(p.odds) || 1), 1)
    data.total_odds = Math.round(total * 100) / 100
    return data
  }

  // Fallback
  const isHigh = type === 'high'
  const prompt = `Ты — эксперт по ставкам на спорт. Составь ${isHigh ? 'ВЫСОКОДОХОДНЫЙ' : 'НАДЁЖНЫЙ'} экспресс из матчей топовых лиг на ${targetDate}.

- 2-3 матча из: Примера, АПЛ, Серия А, Бундеслига, Лига 1, Лига чемпионов, Лига Европы
${isHigh
  ? '- Итоговый коэффициент НЕ МЕНЕЕ 4.00, каждый исход от 1.40'
  : '- Итоговый коэффициент 2.00–4.00, минимальный коэффициент 1.33'}

Ответь ТОЛЬКО валидным JSON:
{
  "date": "${targetDate}",
  "picks": [{"home":"...","away":"...","league":"...","prediction":"...","odds":1.55,"reasoning":"..."}],
  "total_odds": 3.47,
  "summary": "..."
}`

  const content = await openAIRequest([
    { role: 'system', content: 'Ты эксперт по ставкам. Отвечай только валидным JSON.' },
    { role: 'user', content: prompt },
  ])
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Invalid JSON from OpenAI')
  const data = JSON.parse(jsonMatch[0])
  if (!data.picks || data.picks.length < 2) throw new Error('Not enough picks')
  return data
}

// ── GET /express/today ────────────────────────────────────────────────────────
router.get('/today', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1]
    let userId = null
    if (token) {
      try {
        const jwt = require('jsonwebtoken')
        const decoded = jwt.verify(token, process.env.JWT_SECRET)
        userId = decoded.userId || decoded.id
      } catch {}
    }

    const expressDate = getTomorrowDate()

    const getOrGenerate = async (table, purchaseTable) => {
      const type = table === 'daily_express' ? 'standard' : 'high'
      let row = db.prepare(`SELECT * FROM ${table} WHERE date = ?`).get(expressDate)
      if (!row) {
        try {
          const data = await generateExpress(expressDate, type)
          db.prepare(`INSERT OR IGNORE INTO ${table} (date, data) VALUES (?, ?)`).run(expressDate, JSON.stringify(data))
          row = db.prepare(`SELECT * FROM ${table} WHERE date = ?`).get(expressDate)
        } catch { return null }
      }
      const expressData = JSON.parse(row.data)
      const purchased = userId
        ? !!db.prepare(`SELECT 1 FROM ${purchaseTable} WHERE user_id = ? AND express_date = ?`).get(userId, expressDate)
        : false

      if (purchased) return { date: expressDate, purchased: true, ...expressData }
      return {
        date: expressDate,
        purchased: false,
        summary: expressData.summary,
        total_odds: expressData.total_odds,
        picks_count: expressData.picks.length,
        picks: expressData.picks.map(p => ({ home: p.home, away: p.away, league: p.league, prediction: null, odds: null })),
      }
    }

    const [standard, high] = await Promise.all([
      getOrGenerate('daily_express', 'express_purchases'),
      getOrGenerate('daily_express_high', 'express_purchases_high'),
    ])

    res.json({ standard, high })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /express/purchase ────────────────────────────────────────────────────
router.post('/purchase', authenticate, (req, res) => {
  const expressDate = getTomorrowDate()
  const userId = req.user.id
  const type = req.body?.type === 'high' ? 'high' : 'standard'
  const table = type === 'standard' ? 'daily_express' : 'daily_express_high'
  const purchaseTable = type === 'standard' ? 'express_purchases' : 'express_purchases_high'
  const cost = type === 'standard' ? EXPRESS_COST_STANDARD : EXPRESS_COST_HIGH

  const alreadyBought = db.prepare(`SELECT 1 FROM ${purchaseTable} WHERE user_id = ? AND express_date = ?`).get(userId, expressDate)
  if (alreadyBought) {
    const row = db.prepare(`SELECT * FROM ${table} WHERE date = ?`).get(expressDate)
    if (!row) return res.status(404).json({ error: 'Экспресс не найден' })
    return res.json({ purchased: true, ...JSON.parse(row.data) })
  }

  const row = db.prepare(`SELECT * FROM ${table} WHERE date = ?`).get(expressDate)
  if (!row) return res.status(404).json({ error: 'Экспресс ещё не сгенерирован' })

  if (!req.user.is_admin) {
    const user = db.prepare('SELECT coins FROM users WHERE id = ?').get(userId)
    if (user.coins < cost) return res.status(402).json({ error: 'Недостаточно монет', coins: user.coins })
    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(cost, userId)
    db.prepare('INSERT INTO coin_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(userId, -cost, 'spend', `Экспресс дня (${type})`)
  }

  db.prepare(`INSERT OR IGNORE INTO ${purchaseTable} (user_id, express_date) VALUES (?, ?)`).run(userId, expressDate)
  const updated = db.prepare('SELECT coins FROM users WHERE id = ?').get(userId)
  res.json({ purchased: true, coins: updated.coins, ...JSON.parse(row.data) })
})

// ── POST /express/generate (admin) ───────────────────────────────────────────
router.post('/generate', authenticate, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Только для администраторов' })
  const expressDate = getTomorrowDate()
  const type = req.body?.type // 'standard' | 'high' | undefined (both)
  try {
    if (type === 'standard') {
      const data = await generateExpress(expressDate, 'standard')
      db.prepare('INSERT OR REPLACE INTO daily_express (date, data) VALUES (?, ?)').run(expressDate, JSON.stringify(data))
      return res.json({ success: true, date: expressDate, ...data })
    }
    if (type === 'high') {
      const data = await generateExpress(expressDate, 'high')
      db.prepare('INSERT OR REPLACE INTO daily_express_high (date, data) VALUES (?, ?)').run(expressDate, JSON.stringify(data))
      return res.json({ success: true, date: expressDate, ...data })
    }
    // Generate both
    const [standard, high] = await Promise.all([
      generateExpress(expressDate, 'standard'),
      generateExpress(expressDate, 'high'),
    ])
    db.prepare('INSERT OR REPLACE INTO daily_express (date, data) VALUES (?, ?)').run(expressDate, JSON.stringify(standard))
    db.prepare('INSERT OR REPLACE INTO daily_express_high (date, data) VALUES (?, ?)').run(expressDate, JSON.stringify(high))
    res.json({ success: true, date: expressDate, standard, high })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
module.exports.generateExpressForDate = generateExpress
module.exports.getTomorrowDate = getTomorrowDate
