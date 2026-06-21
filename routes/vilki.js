const express = require('express')
const https = require('https')

const router = express.Router()

const ODDS_API_KEY = process.env.ODDS_API_KEY
const CACHE_TTL = 2 * 60 * 60 * 1000 // 2 часа

let cache = { data: null, updatedAt: null, requestsRemaining: null }

const SPORTS = [
  // Футбол
  'soccer_epl', 'soccer_spain_la_liga', 'soccer_germany_bundesliga',
  'soccer_italy_serie_a', 'soccer_france_ligue_one', 'soccer_uefa_champs_league',
  'soccer_uefa_europa_league', 'soccer_netherlands_eredivisie',
  'soccer_turkey_super_league', 'soccer_portugal_primeira_liga',
  // Баскетбол
  'basketball_nba', 'basketball_euroleague',
  // Хоккей
  'icehockey_nhl',
  // Теннис
  'tennis_atp_french_open', 'tennis_wta_french_open',
  // MMA / Бокс
  'mma_mixed_martial_arts',
  // Американский футбол
  'americanfootball_nfl',
  // Бейсбол
  'baseball_mlb',
]

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let raw = ''
      res.on('data', c => raw += c)
      res.on('end', () => {
        try {
          resolve({ data: JSON.parse(raw), headers: res.headers })
        } catch (e) {
          reject(e)
        }
      })
    }).on('error', reject)
  })
}

function findArbitrage(events) {
  const arbs = []

  for (const event of events) {
    if (!event.bookmakers || event.bookmakers.length < 2) continue

    // Собираем лучшие коэффициенты по каждому исходу
    const best = {}
    for (const bm of event.bookmakers) {
      const market = bm.markets?.find(m => m.key === 'h2h')
      if (!market) continue
      for (const outcome of market.outcomes) {
        if (!best[outcome.name] || outcome.price > best[outcome.name].price) {
          best[outcome.name] = { price: outcome.price, bookmaker: bm.title }
        }
      }
    }

    const outcomes = Object.entries(best)
    if (outcomes.length < 2) continue

    // Считаем сумму 1/коэф
    const impliedSum = outcomes.reduce((sum, [, o]) => sum + 1 / o.price, 0)

    // Если сумма < 1 — вилка!
    if (impliedSum < 1) {
      const profit = ((1 / impliedSum) - 1) * 100
      const stakes = outcomes.map(([name, o]) => ({
        name,
        price: o.price,
        bookmaker: o.bookmaker,
        stake: Math.round((1 / o.price / impliedSum) * 10000) / 100, // % от банка
      }))

      arbs.push({
        id: event.id,
        sport: event.sport_key,
        home: event.home_team,
        away: event.away_team,
        commenceTime: event.commence_time,
        profit: Math.round(profit * 100) / 100,
        stakes,
      })
    }
  }

  return arbs.sort((a, b) => b.profit - a.profit)
}

// GET /vilki — возвращает вилки (из кэша или свежие)
router.get('/', async (req, res) => {
  const now = Date.now()

  // Отдаём кэш если свежий
  if (cache.data && cache.updatedAt && (now - cache.updatedAt) < CACHE_TTL) {
    const ageMin = Math.round((now - cache.updatedAt) / 60000)
    return res.json({
      arbs: cache.data,
      updatedAt: cache.updatedAt,
      ageMin,
      nextUpdateIn: Math.round((CACHE_TTL - (now - cache.updatedAt)) / 60000),
      requestsRemaining: cache.requestsRemaining,
      fromCache: true,
    })
  }

  // Фетчим свежие данные
  try {
    const allEvents = []
    let remaining = null

    for (const sport of SPORTS) {
      try {
        const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_API_KEY}&regions=eu,uk&markets=h2h&oddsFormat=decimal`
        const { data, headers } = await fetchJson(url)
        remaining = headers['x-requests-remaining']
        if (Array.isArray(data)) {
          data.forEach(e => { e.sport_key = sport })
          allEvents.push(...data)
        }
      } catch (e) {
        console.log(`[vilki] skip ${sport}: ${e.message}`)
      }
    }

    const arbs = findArbitrage(allEvents)

    cache = { data: arbs, updatedAt: now, requestsRemaining: remaining }

    res.json({
      arbs,
      updatedAt: now,
      ageMin: 0,
      nextUpdateIn: 120,
      requestsRemaining: remaining,
      fromCache: false,
    })
  } catch (e) {
    console.error('[vilki] error:', e.message)
    if (cache.data) {
      return res.json({ arbs: cache.data, updatedAt: cache.updatedAt, fromCache: true, error: 'Ошибка обновления, показываем кэш' })
    }
    res.status(500).json({ error: 'Не удалось получить данные' })
  }
})

// GET /vilki/status — сколько запросов осталось
router.get('/status', async (req, res) => {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}`
    const { headers } = await fetchJson(url)
    res.json({
      requestsRemaining: headers['x-requests-remaining'],
      requestsUsed: headers['x-requests-used'],
      cacheAge: cache.updatedAt ? Math.round((Date.now() - cache.updatedAt) / 60000) : null,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
