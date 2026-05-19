const express = require('express')
const https = require('https')
const db = require('../db')
const { authenticate } = require('../middleware/auth')

const router = express.Router()
const EXPRESS_COST = 28

// Top league IDs (sstats)
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
    const body = JSON.stringify({ model: 'gpt-4o', messages, temperature: 0.7, max_tokens: 1200 })
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
    .filter(g => {
      if (!g.date || !g.homeTeam?.name || !g.awayTeam?.name) return false
      return g.date.slice(0, 10) === targetDate
    })
    .map(g => {
      const market = g.odds?.find(o => o.marketId === 1)
      const odds1 = market?.odds?.find(o => o.name === 'Home')?.value
      const oddsX = market?.odds?.find(o => o.name === 'Draw')?.value
      const odds2 = market?.odds?.find(o => o.name === 'Away')?.value
      return {
        home: g.homeTeam.name,
        away: g.awayTeam.name,
        league: g.season?.league?.name || 'Unknown',
        odds1: odds1 || null,
        oddsX: oddsX || null,
        odds2: odds2 || null,
      }
    })
}

async function generateExpress(targetDate) {
  const realMatches = await fetchRealMatches(targetDate)

  let prompt
  if (realMatches.length >= 2) {
    const matchList = realMatches.map((m, i) => {
      const oddsStr = m.odds1
        ? ` | коэфы: П1=${m.odds1}, X=${m.oddsX ?? '—'}, П2=${m.odds2}`
        : ''
      return `${i + 1}. ${m.home} — ${m.away} (${m.league})${oddsStr}`
    }).join('\n')

    prompt = `Ты — эксперт по ставкам на спорт. Выбери 2-3 матча для экспресса из РЕАЛЬНОГО расписания на ${targetDate}.

РЕАЛЬНЫЕ МАТЧИ НА ${targetDate}:
${matchList}

Требования:
- Выбирай ТОЛЬКО из матчей выше — не придумывай других матчей
- Минимальный коэффициент на каждую ставку: 1.33
- Только ставки с вероятностью прохода >65%
- Типы ставок: победа (П1/П2), обе забьют, тотал, фора
- Поля home/away/league должны быть ТОЧНО как в списке выше

Ответь ТОЛЬКО валидным JSON:
{
  "date": "${targetDate}",
  "picks": [
    {
      "home": "название из списка",
      "away": "название из списка",
      "league": "лига из списка",
      "prediction": "Ставка (П1 / П2 / Обе забьют - Да / ТБ 2.5 / Фора)",
      "odds": 1.55,
      "reasoning": "Обоснование 1-2 предложения"
    }
  ],
  "total_odds": 3.47,
  "summary": "Краткое описание экспресса"
}`
  } else {
    // Fallback: no real data — let GPT pick from known top leagues
    prompt = `Ты — эксперт по ставкам на спорт. Сегодня ${getTodayDate()}, составь экспресс из матчей топовых лиг на ${targetDate}.

Требования:
- 2-3 матча ТОЛЬКО из: Примера, АПЛ, Серия А, Бундеслига, Лига 1, Лига чемпионов, Лига Европы, РПЛ
- Минимальный коэффициент на каждую ставку: 1.33
- Только ставки с вероятностью прохода >65%
- Типы ставок: победа (П1/П2), обе забьют, тотал, фора

Ответь ТОЛЬКО валидным JSON:
{
  "date": "${targetDate}",
  "picks": [
    {
      "home": "Домашняя команда",
      "away": "Гостевая команда",
      "league": "Лига",
      "prediction": "Ставка",
      "odds": 1.55,
      "reasoning": "Обоснование"
    }
  ],
  "total_odds": 3.47,
  "summary": "Краткое описание экспресса"
}`
  }

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
    let row = db.prepare('SELECT * FROM daily_express WHERE date = ?').get(expressDate)

    if (!row) {
      try {
        const data = await generateExpress(expressDate)
        db.prepare('INSERT OR IGNORE INTO daily_express (date, data) VALUES (?, ?)').run(expressDate, JSON.stringify(data))
        row = db.prepare('SELECT * FROM daily_express WHERE date = ?').get(expressDate)
      } catch (err) {
        return res.status(503).json({ error: 'Экспресс дня ещё не готов: ' + err.message })
      }
    }

    const expressData = JSON.parse(row.data)
    const purchased = userId
      ? !!db.prepare('SELECT 1 FROM express_purchases WHERE user_id = ? AND express_date = ?').get(userId, expressDate)
      : false

    if (purchased) return res.json({ date: expressDate, purchased: true, ...expressData })

    res.json({
      date: expressDate,
      purchased: false,
      summary: expressData.summary,
      total_odds: expressData.total_odds,
      picks_count: expressData.picks.length,
      picks: expressData.picks.map(p => ({ home: p.home, away: p.away, league: p.league, prediction: null, odds: null })),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/purchase', authenticate, (req, res) => {
  const expressDate = getTomorrowDate()
  const userId = req.user.id

  const alreadyBought = db.prepare('SELECT 1 FROM express_purchases WHERE user_id = ? AND express_date = ?').get(userId, expressDate)
  if (alreadyBought) {
    const row = db.prepare('SELECT * FROM daily_express WHERE date = ?').get(expressDate)
    if (!row) return res.status(404).json({ error: 'Экспресс не найден' })
    return res.json({ purchased: true, ...JSON.parse(row.data) })
  }

  const row = db.prepare('SELECT * FROM daily_express WHERE date = ?').get(expressDate)
  if (!row) return res.status(404).json({ error: 'Экспресс ещё не сгенерирован' })

  if (!req.user.is_admin) {
    const user = db.prepare('SELECT coins FROM users WHERE id = ?').get(userId)
    if (user.coins < EXPRESS_COST) return res.status(402).json({ error: 'Недостаточно монет', coins: user.coins })
    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(EXPRESS_COST, userId)
    db.prepare('INSERT INTO coin_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(userId, -EXPRESS_COST, 'spend', 'Экспресс дня')
  }

  db.prepare('INSERT OR IGNORE INTO express_purchases (user_id, express_date) VALUES (?, ?)').run(userId, expressDate)
  const updated = db.prepare('SELECT coins FROM users WHERE id = ?').get(userId)
  res.json({ purchased: true, coins: updated.coins, ...JSON.parse(row.data) })
})

router.post('/generate', authenticate, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Только для администраторов' })
  const expressDate = getTomorrowDate()
  try {
    const data = await generateExpress(expressDate)
    db.prepare('INSERT OR REPLACE INTO daily_express (date, data) VALUES (?, ?)').run(expressDate, JSON.stringify(data))
    res.json({ success: true, date: expressDate, ...data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
module.exports.generateExpressForDate = generateExpress
module.exports.getTomorrowDate = getTomorrowDate
