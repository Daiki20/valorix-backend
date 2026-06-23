const express = require('express')
const https = require('https')
const db = require('../db')
const { authenticate } = require('../middleware/auth')
const { translateTeam } = require('../teamNames')

const router = express.Router()
const EXPRESS_COST_STANDARD = 99
const EXPRESS_COST_HIGH = 140

// Топ-лиги — ищем в первую очередь
const TOP_LEAGUE_IDS = [
  2,   // Champions League
  3,   // Europa League
  39,  // Premier League
  140, // La Liga
  135, // Serie A
  78,  // Bundesliga 1
  61,  // Ligue 1
  235, // Russian Premier League
]

// Расширенный список — используется когда топ-лиги не играют (международные перерывы, паузы)
const EXTENDED_LEAGUE_IDS = [
  5,   // UEFA Nations League (сборные Европы)
  4,   // UEFA Euro Championship
  1,   // FIFA World Cup
  218, // FIFA World Cup Qualifiers Europe
  848, // UEFA Conference League
  94,  // Primeira Liga (Португалия)
  88,  // Eredivisie (Нидерланды)
  144, // Belgian Pro League (Бельгия)
  203, // Süper Lig (Турция)
  197, // Super League (Греция)
  210, // Ukrainian Premier League (Украина)
  179, // Scottish Premiership (Шотландия)
  207, // Swiss Super League (Швейцария)
  71,  // Brasileirao Serie A (Бразилия)
  128, // Liga Profesional (Аргентина)
  253, // MLS (США)
  262, // Liga MX (Мексика)
  40,  // EFL Championship (Англия 2)
  79,  // Bundesliga 2 (Германия 2)
  62,  // Ligue 2 (Франция 2)
  236, // ФНЛ (Россия 2)
]

// Приоритет лиг для сортировки при расширенном поиске
const LEAGUE_PRIORITY_EXPRESS = {
  1: 1100, 4: 1100,                        // WC / Euro
  5: 1050, 218: 1000,                      // Nations League / WC Qualifiers
  2: 950, 3: 950, 848: 900,               // UCL / UEL / UECL
  39: 900, 140: 900, 135: 900,             // PL / La Liga / Serie A
  78: 900, 61: 900, 235: 850,              // Bundesliga / Ligue 1 / РПЛ
  94: 800, 88: 800, 144: 800,              // Portugal / Netherlands / Belgium
  203: 800, 197: 750, 210: 750,            // Turkey / Greece / Ukraine
  179: 750, 207: 750,                      // Scotland / Switzerland
  71: 700, 128: 700,                       // Brazil / Argentina
  253: 650, 262: 650,                      // MLS / Liga MX
  40: 600, 79: 600, 62: 600, 236: 600,    // England 2 / Germany 2 / France 2 / ФНЛ
}

// Cache "no matches" results to avoid repeated API scans (2h TTL)
const noMatchCache = new Map()
const NO_MATCH_TTL = 2 * 60 * 60 * 1000
function isNoMatchCached(key) {
  const exp = noMatchCache.get(key)
  if (!exp) return false
  if (Date.now() > exp) { noMatchCache.delete(key); return false }
  return true
}
function setNoMatchCache(key) {
  noMatchCache.set(key, Date.now() + NO_MATCH_TTL)
}

// Mutex — предотвращает параллельные генерации одного экспресса
const generating = {}
async function withMutex(key, fn) {
  if (generating[key]) {
    // Ждём пока другой запрос закончит (до 30 сек)
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500))
      if (!generating[key]) break
    }
    return null // другой запрос уже сохранил в БД
  }
  generating[key] = true
  try { return await fn() }
  finally { generating[key] = false }
}

function getTomorrowDate() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

function getTodayDate() {
  return new Date().toISOString().slice(0, 10)
}

function getDateOffset(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function httpsGet(url, maxRedirects = 4) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      // Follow HTTP redirects (Node.js doesn't do this automatically)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) { reject(new Error('Too many redirects')); return }
        resolve(httpsGet(res.headers.location, maxRedirects - 1))
        return
      }
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('JSON parse error')) }
      })
    })
    req.on('error', reject)
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('sstats timeout')) })
  })
}

function openAIRequest(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'gpt-4o-search-preview',
      messages,
      max_tokens: 1200,
      web_search_options: { search_context_size: 'medium' },
    })
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      timeout: 60000,
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
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenAI timeout')) })
    req.write(body)
    req.end()
  })
}

// ── NHL team abbrev → Russian name ───────────────────────────────────────────
const NHL_TEAMS_RU = {
  'ANA':'Анахайм Дакс','BOS':'Бостон Брюинс','BUF':'Баффало Сэйбрс',
  'CGY':'Калгари Флэймс','CAR':'Каролина Харрикейнс','CHI':'Чикаго Блэкхокс',
  'COL':'Колорадо Эвэланш','CBJ':'Коламбус Блю Джекетс','DAL':'Даллас Старс',
  'DET':'Детройт Ред Уингс','EDM':'Эдмонтон Ойлерс','FLA':'Флорида Пантерс',
  'LAK':'Лос-Анджелес Кингс','MIN':'Миннесота Уайлд','MTL':'Монреаль Канадьенс',
  'NSH':'Нэшвилл Предаторс','NJD':'Нью-Джерси Девилс','NYI':'Нью-Йорк Айлендерс',
  'NYR':'Нью-Йорк Рейнджерс','OTT':'Оттава Сенаторс','PHI':'Филадельфия Флайерс',
  'PIT':'Питтсбург Пингвинс','SJS':'Сан-Хосе Шаркс','SEA':'Сиэтл Кракен',
  'STL':'Сент-Луис Блюз','TBL':'Тампа-Бэй Лайтнинг','TOR':'Торонто Мэйпл Лифс',
  'VAN':'Ванкувер Кэнакс','VGK':'Вегас Голден Найтс','WSH':'Вашингтон Кэпиталс',
  'WPG':'Виннипег Джетс','UTH':'Юта Хоккей Клаб',
}

// AllSportsApi helper (same as matches.js)
function allSportsGetPathExpress(path) {
  const key = process.env.RAPIDAPI_KEY
  if (!key) return Promise.reject(new Error('No RAPIDAPI_KEY'))
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'allsportsapi2.p.rapidapi.com',
      path,
      method: 'GET',
      timeout: 8000,
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': 'allsportsapi2.p.rapidapi.com',
        'Accept': 'application/json',
      },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch { reject(new Error('parse error')) } })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

// Important hockey leagues filter (same keywords as matches.js)
const HOCKEY_LEAGUE_KEYWORDS = [
  'khl', 'кхл', 'kontinental',
  'nhl', 'нхл', 'national hockey',
  'vhl', 'вхл',
  'mhl', 'юхл', 'молодёж',
  'world championship', 'чемпионат мира', 'iihf',
  'shl', 'liiga', 'del ', 'nla', 'ahl',
  'playoffs', 'плей-офф', 'финал',
]
function isImportantHockeyLeagueExpress(name) {
  if (!name) return false
  const l = name.toLowerCase()
  return HOCKEY_LEAGUE_KEYWORDS.some(k => l.includes(k))
}

function toExpressDate(isoDate) {
  const [y, m, d] = isoDate.split('-')
  return `${d}/${m}/${y}`
}

// ── Sofascore direct (free, no quota) ──────────────────────────────────────────
function sofascoreGetExpress(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.sofascore.com',
      path,
      method: 'GET',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.sofascore.com/',
        'Origin': 'https://www.sofascore.com',
      },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        if (res.statusCode === 403 || res.statusCode === 429) {
          reject(new Error(`Sofascore HTTP ${res.statusCode}`)); return
        }
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('JSON parse error')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

// ── Hockey tournaments with hardcoded fallback season IDs (same as matches.js) ─
const HOCKEY_TOURNAMENTS_EXPRESS = [
  { id: 3,    league: 'ИИХФ · Чемпионат мира', fallbackSeasonId: 81043 },
  { id: 268,  league: 'КХЛ',                    fallbackSeasonId: 77998 },
  { id: 1159, league: 'МХЛ',                    fallbackSeasonId: 79945 },
  { id: 1141, league: 'ВХЛ',                    fallbackSeasonId: 78633 },
]

const seasonIdCacheEx = new Map()
const SEASON_TTL_EX = 24 * 60 * 60 * 1000

async function fetchSeasonIdForExpress(tournamentId, fallbackSeasonId) {
  const cached = seasonIdCacheEx.get(tournamentId)
  if (cached && Date.now() - cached.ts < SEASON_TTL_EX) return cached.seasonId

  for (const fetchFn of [
    () => allSportsGetPathExpress(`/api/tournament/${tournamentId}/seasons`),
    () => sofascoreGetExpress(`/api/v1/unique-tournament/${tournamentId}/seasons`),
  ]) {
    try {
      const data = await fetchFn()
      const seasons = data?.seasons || data?.uniqueTournamentSeasons || []
      if (!seasons.length) continue
      const seasonId = seasons.sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0))[0]?.id
      if (seasonId) {
        seasonIdCacheEx.set(tournamentId, { seasonId, ts: Date.now() })
        return seasonId
      }
    } catch {}
  }
  // Hardcoded fallback — always works
  if (fallbackSeasonId) {
    console.warn(`[express/hockey] T=${tournamentId} using hardcoded season ${fallbackSeasonId}`)
    return fallbackSeasonId
  }
  return null
}

// IIHF national teams translation
const IIHF_TEAMS_EXPRESS = {
  'Canada': 'Канада', 'Russia': 'Россия', 'Finland': 'Финляндия',
  'Sweden': 'Швеция', 'USA': 'США', 'United States': 'США',
  'Czech Republic': 'Чехия', 'Czechia': 'Чехия', 'Slovakia': 'Словакия',
  'Switzerland': 'Швейцария', 'Germany': 'Германия', 'Latvia': 'Латвия',
  'Denmark': 'Дания', 'Norway': 'Норвегия', 'France': 'Франция',
  'Austria': 'Австрия', 'Hungary': 'Венгрия', 'Slovenia': 'Словения',
  'Great Britain': 'Великобритания', 'Kazakhstan': 'Казахстан',
  'Belarus': 'Беларусь', 'Poland': 'Польша', 'Italy': 'Италия',
}
function translateHockeyTeamExpress(name) {
  return IIHF_TEAMS_EXPRESS[name] || name
}

// Fetch matches for one tournament: AllSportsApi2 → Sofascore direct (free)
async function fetchTournamentMatchesForExpress(t, targetDate) {
  const legacyPath = `/api/tournament/${t.id}/season/${t.seasonId}/matches/next/0`
  const sofaPath   = `/api/v1/unique-tournament/${t.id}/season/${t.seasonId}/events/next/0`

  // Fetch both in parallel: AllSports for match list, Sofascore for event IDs (h2h needs Sofascore IDs)
  let events = []
  const [allSportsResult, sofaResult] = await Promise.allSettled([
    allSportsGetPathExpress(legacyPath),
    sofascoreGetExpress(sofaPath),
  ])

  // Prefer AllSports for match list (paid, more reliable), but grab Sofascore IDs separately
  const allSportsEvents = allSportsResult.status === 'fulfilled' ? (allSportsResult.value?.events || []) : []
  const sofaEvents      = sofaResult.status      === 'fulfilled' ? (sofaResult.value?.events      || []) : []

  // Use whichever source has data; prefer AllSports
  events = allSportsEvents.length > 0 ? allSportsEvents : sofaEvents

  // Build a lookup: team name → Sofascore event/team IDs (for h2h)
  const sofaLookup = {}
  for (const ev of sofaEvents) {
    const hN = (ev.homeTeam?.name || '').toLowerCase()
    const aN = (ev.awayTeam?.name || '').toLowerCase()
    sofaLookup[`${hN}|${aN}`] = { eventId: ev.id, homeTeamId: ev.homeTeam?.id, awayTeamId: ev.awayTeam?.id }
    sofaLookup[`${aN}|${hN}`] = { eventId: ev.id, homeTeamId: ev.awayTeam?.id, awayTeamId: ev.homeTeam?.id }
  }

  const matches = []
  for (const ev of events) {
    const statusType = (ev.status?.type || '').toLowerCase()
    if (statusType === 'finished' || statusType === 'inprogress') continue
    if (ev.startTimestamp) {
      const evDate = new Date(ev.startTimestamp * 1000).toISOString().slice(0, 10)
      if (evDate !== targetDate) continue
    }
    const home = translateHockeyTeamExpress(ev.homeTeam?.name || '')
    const away = translateHockeyTeamExpress(ev.awayTeam?.name || '')
    if (!home || !away) continue

    // Look up Sofascore IDs (works even if main events came from AllSports)
    const hN = (ev.homeTeam?.name || '').toLowerCase()
    const aN = (ev.awayTeam?.name || '').toLowerCase()
    const sofaIds = sofaLookup[`${hN}|${aN}`] || {}

    matches.push({
      home, away, league: t.league,
      eventId:    sofaIds.eventId    || (sofaEvents === events ? ev.id            : null),
      homeTeamId: sofaIds.homeTeamId || (sofaEvents === events ? ev.homeTeam?.id  : null),
      awayTeamId: sofaIds.awayTeamId || (sofaEvents === events ? ev.awayTeam?.id  : null),
    })
  }
  return matches
}

// Fetch all matches from AllSports/Sofascore for the target date
// (IIHF World Championship, KHL, МХЛ, ВХЛ)
async function fetchAllSportsHockeyForDate(targetDate) {
  const tournamentsWithSeasons = await Promise.all(
    HOCKEY_TOURNAMENTS_EXPRESS.map(async t => {
      const seasonId = await fetchSeasonIdForExpress(t.id, t.fallbackSeasonId)
      return { ...t, seasonId }
    })
  )
  const valid = tournamentsWithSeasons.filter(t => t.seasonId)

  const results = await Promise.allSettled(
    valid.map(t => fetchTournamentMatchesForExpress(t, targetDate))
  )

  const matches = []
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    for (const m of r.value) {
      if (!matches.some(g => g.home === m.home && g.away === m.away)) {
        matches.push(m)
      }
    }
  }
  console.log(`[express/allsports] ${targetDate}: ${matches.length} matches (IIHF/KHL/МХЛ/ВХЛ)`)
  return matches
}

// Fetch hockey games for a specific date — NHL free API + AllSportsApi/Sofascore
async function fetchHockeyMatchesForExpress(targetDate) {
  const matches = []

  // NHL API uses Eastern Time (UTC-4/5). A game at 02:00 Moscow = 23:00 UTC the
  // *previous* UTC day, so the NHL dates it as targetDate-1. Include both days.
  const prevDate = new Date(targetDate)
  prevDate.setDate(prevDate.getDate() - 1)
  const prevDateStr = prevDate.toISOString().slice(0, 10)
  const nhlAllowedDates = new Set([prevDateStr, targetDate])

  try {
    const data = await httpsGet(`https://api-web.nhle.com/v1/schedule/${targetDate}`)
    for (const day of (data.gameWeek || [])) {
      if (!nhlAllowedDates.has(day.date)) continue
      for (const game of (day.games || [])) {
        const state = game.gameState
        if (state === 'OFF' || state === 'FINAL') continue
        const ha = game.homeTeam?.abbrev || ''
        const aa = game.awayTeam?.abbrev || ''
        const home = NHL_TEAMS_RU[ha] || `${game.homeTeam?.placeName?.default || ''} ${game.homeTeam?.commonName?.default || ''}`.trim()
        const away = NHL_TEAMS_RU[aa] || `${game.awayTeam?.placeName?.default || ''} ${game.awayTeam?.commonName?.default || ''}`.trim()
        if (home && away) matches.push({ home, away, league: 'НХЛ · Плей-офф' })
      }
    }
    console.log(`[express/nhl] ${targetDate}: ${matches.length} NHL matches`)
  } catch {}

  // AllSportsApi2 + Sofascore (free) — IIHF ЧМ, КХЛ, МХЛ, ВХЛ, filtered to targetDate
  try {
    const extraMatches = await fetchAllSportsHockeyForDate(targetDate)
    for (const m of extraMatches) {
      if (!matches.some(g => g.home === m.home && g.away === m.away)) {
        matches.push(m)
      }
    }
  } catch {}

  console.log(`[express/hockey] ${targetDate}: ${matches.length} total matches found`)
  return matches
}

// ── The Odds API — hockey coefficients for express ───────────────────────────
function oddsApiGetHockey(sport) {
  const apiKey = process.env.ODDS_API_KEY
  if (!apiKey) return Promise.reject(new Error('No ODDS_API_KEY'))
  const qs = new URLSearchParams({ apiKey, regions: 'eu', markets: 'h2h', oddsFormat: 'decimal' }).toString()
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.the-odds-api.com',
      path: `/v4/sports/${sport}/odds/?${qs}`,
      method: 'GET', timeout: 10000,
      headers: { 'Accept': 'application/json' },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`odds-api HTTP ${res.statusCode}`)); return }
        try { resolve(JSON.parse(data)) } catch { reject(new Error('JSON parse error')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

// Build odds lookup map from The Odds API events
function buildHockeyOddsLookup(events) {
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const map = {}
  for (const ev of events) {
    if (!ev.bookmakers?.length) continue
    const buckets = {}
    for (const bm of ev.bookmakers) {
      const market = bm.markets?.find(m => m.key === 'h2h')
      if (!market) continue
      for (const o of (market.outcomes || [])) {
        if (!buckets[o.name]) buckets[o.name] = []
        buckets[o.name].push(o.price)
      }
    }
    const names = Object.keys(buckets)
    if (names.length < 2) continue
    const avg = arr => parseFloat((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2))
    const hN = norm(ev.home_team)
    const aN = norm(ev.away_team)
    const hOdds = avg(buckets[ev.home_team] || [1])
    const aOdds = avg(buckets[ev.away_team] || [1])
    if (!hOdds || !aOdds) continue
    const entry = { homeOdds: hOdds, awayOdds: aOdds, homeNorm: hN, awayNorm: aN }
    map[hN] = entry
    map[aN] = entry
  }
  return map
}

function lookupHockeyOdds(home, away, oddsMap) {
  if (!oddsMap || !Object.keys(oddsMap).length) return null
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const hN = norm(home), aN = norm(away)
  let entry = oddsMap[hN] || oddsMap[aN]
  if (!entry) {
    const key = Object.keys(oddsMap).find(k =>
      k.includes(hN) || hN.includes(k) || k.includes(aN) || aN.includes(k)
    )
    if (key) entry = oddsMap[key]
  }
  if (!entry) return null
  const isHomeSide = entry.homeNorm.includes(hN) || hN.includes(entry.homeNorm)
  return {
    home: isHomeSide ? entry.homeOdds : entry.awayOdds,
    away: isHomeSide ? entry.awayOdds : entry.homeOdds,
  }
}

// Cache hockey odds 6h — saves monthly quota (500 req/month)
let hockeyOddsExpressCache = { data: null, ts: 0 }
const HOCKEY_EXPRESS_ODDS_TTL = 6 * 60 * 60 * 1000
const HOCKEY_ODDS_SPORTS_EX = ['icehockey_nhl', 'icehockey_khl', 'icehockey_shl']

async function fetchHockeyOddsForExpress() {
  if (hockeyOddsExpressCache.data && Date.now() - hockeyOddsExpressCache.ts < HOCKEY_EXPRESS_ODDS_TTL) {
    return hockeyOddsExpressCache.data
  }
  if (!process.env.ODDS_API_KEY) return {}
  const allEvents = []
  for (const sport of HOCKEY_ODDS_SPORTS_EX) {
    try {
      const events = await oddsApiGetHockey(sport)
      if (Array.isArray(events)) allEvents.push(...events)
      console.log(`[express/odds] ${sport}: ${Array.isArray(events) ? events.length : 0} events`)
    } catch (err) {
      console.warn(`[express/odds] ${sport} failed: ${err.message}`)
    }
  }
  const lookup = buildHockeyOddsLookup(allEvents)
  hockeyOddsExpressCache = { data: lookup, ts: Date.now() }
  console.log(`[express/odds] cached hockey odds for ${Math.floor(Object.keys(lookup).length / 2)} matches`)
  return lookup
}

// Parse and validate GPT JSON response into express data
function parseExpressJson(content, date, sport = 'football', type = 'standard') {
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Invalid JSON from OpenAI')
  let data
  try { data = JSON.parse(jsonMatch[0]) } catch { throw new Error('JSON parse failed') }
  if (!data.picks || !Array.isArray(data.picks) || data.picks.length < 1) throw new Error('No picks in response')
  data.date = data.date || date

  // Clamp individual odds to prevent GPT from exceeding limits
  const maxPickOdds = 1.60
  data.picks = data.picks.map(p => ({
    ...p,
    odds: Math.min(parseFloat(p.odds) || 1.5, maxPickOdds),
  }))

  data.total_odds = Math.round(data.picks.reduce((acc, p) => acc * (parseFloat(p.odds) || 1), 1) * 100) / 100
  return data
}

function buildSportExpressPrompt(sport, type, matches, date) {
  const isHigh = type === 'high'
  const isHockey = sport === 'hockey'
  const sportLabel = { hockey: 'хоккей' }[sport] || sport

  // Build match blocks — h2h, odds, season records
  const matchBlocks = matches.map((m, i) => {
    let block = `${i + 1}. ${m.home} — ${m.away} (${m.league})`
    if (isHockey && m.odds) {
      block += `\n  Коэф П1: ${m.odds.home} | П2: ${m.odds.away}`
    }
    if (m.homeRecord || m.awayRecord) {
      block += `\n  Сезон: ${m.home}: ${m.homeRecord || 'н/д'} | ${m.away}: ${m.awayRecord || 'н/д'}`
    }
    if (m.homeForm || m.awayForm) {
      block += `\n  Форма: ${m.home} — ${m.homeForm || 'н/д'} | ${m.away} — ${m.awayForm || 'н/д'}`
    }
    if (m.h2h) {
      block += `\n  Последние личные встречи:\n${m.h2h}`
    }
    return block
  }).join('\n\n')

  const hasAnyStats = matches.some(m => m.h2h || m.homeForm || m.awayForm || m.homeRecord)

  if (isHockey) {
    const picksCount  = isHigh ? 3 : 2
    const totalTarget = isHigh ? '3.00–5.00' : '2.00–3.00'
    const maxOdds     = isHigh ? 1.80 : 1.60
    const minConf     = 70

    const oddsNote = `КОЭФФИЦИЕНТЫ:
- Где указаны П1/П2 — используй эти точные числа если выбираешь победу команды
- Для тоталов (ТБ/ТМ), фор и других рынков — оцени реалистично как у топ-букмекеров`

    const betTypes = isHigh
      ? `  * Двойной шанс "1X" / "X2" (коэф ~1.20–1.80) — надёжный вариант
  * Тотал "ТБ 5.5" / "ТМ 5.5" (коэф ~1.45–1.90) — если статистика голов очевидна
  * Победа "П1" / "П2" — только если коэф ≤ 2.00 и явное превосходство
  ЗАПРЕЩЕНО: коэф > 2.00`
      : `  * Двойной шанс "1X" / "X2" (коэф ~1.20–1.55) — самый надёжный вариант
  * Тотал "ТБ 5.5" / "ТМ 5.5" (коэф ~1.45–1.60) — если статистика голов очевидна
  * Победа "П1" / "П2" — только если коэф ≤ 1.60 и явное превосходство
  ЗАПРЕЩЕНО: коэф > 1.60`

    const statsInstruction = hasAnyStats
      ? `- В "reasoning" ОБЯЗАТЕЛЬНО используй реальную статистику из блока выше
- Ссылайся на конкретные цифры: "в последних 4 встречах ...", "команда выиграла X из 5 матчей"`
      : `- В "reasoning" объясни ПОЧЕМУ выбрал именно эту ставку на основе силы команд`

    return `Ты эксперт по ставкам на хоккей. Твоя задача — составить ${isHigh ? 'ВЫСОКОДОХОДНЫЙ' : 'МАКСИМАЛЬНО НАДЁЖНЫЙ'} экспресс из ${picksCount} событий.

МАТЧИ НА ${date}:
${matchBlocks}

${oddsNote}

ШАГ 1 — ОЦЕНКА КАЖДОГО МАТЧА.
Для каждого матча из списка выше определи:
- Наиболее вероятный исход (тип ставки + направление)
- Уверенность от 0 до 100 на основе: формы, H2H, разницы в классе, статистики тоталов
- Матч подходит если уверенность ≥ ${minConf}

ШАГ 2 — ОТБОР ЛУЧШИХ ${picksCount}.
Возьми ровно ${picksCount} матча с НАИБОЛЬШЕЙ уверенностью (≥ ${minConf}).
Если подходящих меньше ${picksCount} — бери лучшие из доступных (не ниже ${minConf - 10}).
НИКОГДА не включай матч с уверенностью < ${minConf - 10}.

ШАГ 3 — СТАВКИ.
Для каждого отобранного матча выбери ставку:
${betTypes}

Итоговый коэф экспресса: строго ${totalTarget}.
Все текстовые поля СТРОГО на русском языке.
${statsInstruction}

Ответь ТОЛЬКО валидным JSON без markdown:
{"date":"${date}","picks":[{"home":"...","away":"...","league":"...","prediction":"1X","odds":1.40,"confidence":78,"reasoning":"Конкретное обоснование с цифрами из статистики"}],"total_odds":2.74,"summary":"Краткое описание почему этот экспресс надёжный"}`
  }

  // ── Football prompt ───────────────────────────────────────────────────────
  const picksCount  = isHigh ? 3 : 2
  const totalTarget = isHigh ? '3.00–5.00' : '2.00–3.00'
  const pickMaxOdds = isHigh ? 1.80 : 1.60
  const minConf     = 70

  const statsInstruction = hasAnyStats
    ? `- В "reasoning" ОБЯЗАТЕЛЬНО используй реальную статистику из блока выше
- Ссылайся на конкретные цифры: "в последних X встречах ...", "забивает X.XX голов/игру"`
    : `- В "reasoning" объясни ПОЧЕМУ выбрал эту ставку на основе силы команд`

  const betTypes = isHigh
    ? `  * Двойной шанс "1X" / "X2" (коэф ~1.20–1.80) — надёжный вариант
  * Тотал "ТБ 2.5" / "ТМ 2.5" (коэф ~1.45–1.90) — если голевая статистика очевидна
  * Победа фаворита "П1" / "П2" — только если коэф ≤ 2.00
  ЗАПРЕЩЕНО: коэф > 2.00`
    : `  * Двойной шанс "1X" / "X2" (коэф ~1.20–1.55) — самый надёжный вариант
  * Тотал "ТБ 2.5" / "ТМ 2.5" (коэф ~1.45–1.60) — если голевая статистика очевидна
  * Победа явного фаворита "П1" / "П2" — только если коэф ≤ 1.60
  ЗАПРЕЩЕНО: коэф > 1.60`

  return `Ты эксперт по ставкам на футбол. Твоя задача — составить ${isHigh ? 'ВЫСОКОДОХОДНЫЙ' : 'МАКСИМАЛЬНО НАДЁЖНЫЙ'} экспресс из ${picksCount} событий.

МАТЧИ НА ${date} (со статистикой):
${matchBlocks}

Коэффициенты оцени реалистично на основе силы команд, как у топ-букмекеров.

ШАГ 1 — ОЦЕНКА КАЖДОГО МАТЧА.
Для каждого матча определи:
- Наиболее вероятный исход (тип ставки + направление)
- Уверенность 0–100 на основе: формы команд, H2H, голевой статистики, разницы в классе
- Матч подходит для экспресса если уверенность ≥ ${minConf}

ШАГ 2 — ОТБОР ЛУЧШИХ ${picksCount}.
Возьми ровно ${picksCount} матча с НАИБОЛЬШЕЙ уверенностью (≥ ${minConf}).
Если подходящих матчей меньше ${picksCount} — бери лучшие из доступных (не ниже ${minConf - 10}).
НИКОГДА не включай матч с уверенностью < ${minConf - 10}.

ШАГ 3 — СТАВКИ.
Для каждого отобранного матча выбери ставку:
${betTypes}

Итоговый коэф экспресса: строго ${totalTarget}.
Выбирай ТОЛЬКО из матчей выше.
Все текстовые поля СТРОГО на русском языке.
${statsInstruction}

Ответь ТОЛЬКО валидным JSON без markdown:
{"date":"${date}","picks":[{"home":"...","away":"...","league":"...","prediction":"1X","odds":1.45,"confidence":74,"reasoning":"Конкретное обоснование с цифрами из статистики"}],"total_odds":2.55,"summary":"Краткое описание почему этот экспресс надёжный"}`
}

// ── Real stats fetchers for express context ──────────────────────────────────

// IIHF WC group standings from Sofascore (free, no quota)
async function fetchIIHFGroupStandings(seasonId) {
  try {
    const sid = seasonId || 81043
    const data = await sofascoreGetExpress(`/api/v1/unique-tournament/3/season/${sid}/standings/total`)
    const lines = ['ТЕКУЩЕЕ ПОЛОЖЕНИЕ В ГРУППАХ ИИХФ ЧМ 2026:']
    for (const group of (data?.standings || [])) {
      const gname = group.name || group.descriptions?.[0] || 'Группа'
      lines.push(`${gname}:`)
      for (const row of (group.rows || []).slice(0, 8)) {
        const team = translateHockeyTeamExpress(row.team?.name || '?')
        const pts  = row.points ?? 0
        const gp   = row.matches ?? row.played ?? 0
        const w    = row.wins ?? 0
        const l    = row.losses ?? 0
        const gf   = row.scoresFor ?? row.goalsFor ?? 0
        const ga   = row.scoresAgainst ?? row.goalsAgainst ?? 0
        lines.push(`  ${team}: ${pts}оч (${gp}игр, ${w}П/${l}П, Г ${gf}:${ga})`)
      }
    }
    if (lines.length < 2) return null
    console.log(`[express/iihf-standings] fetched ${lines.length - 1} rows`)
    return lines.join('\n')
  } catch (err) {
    console.warn('[express/iihf-standings] failed:', err.message)
    return null
  }
}

// NHL current season standings — one free API call, all team records
async function fetchNHLStandingsMap() {
  try {
    const data = await httpsGet('https://api-web.nhle.com/v1/standings/now')
    const map = {}
    for (const team of (data?.standings || [])) {
      const abbrev = team.teamAbbrev?.default || ''
      if (!abbrev) continue
      const w  = team.wins || 0
      const l  = team.losses || 0
      const ot = team.otLosses || 0
      const gf = team.goalFor || team.goalsFor || 0
      const ga = team.goalAgainst || team.goalsAgainst || 0
      const pts = team.points || 0
      map[abbrev] = `${w}П-${l}П-${ot}ОТ, ${pts}оч, ГЗ/ГП ${gf}/${ga}`
    }
    console.log(`[express/nhl-standings] ${Object.keys(map).length} teams`)
    return Object.keys(map).length > 0 ? map : null
  } catch (err) {
    console.warn('[express/nhl-standings] failed:', err.message)
    return null
  }
}

// Fetch last N head-to-head results from Sofascore (same API as match analysis)
async function fetchH2HForExpress(eventId) {
  if (!eventId) return null
  try {
    const data = await sofascoreGetExpress(`/api/v1/event/${eventId}/h2h`)
    const finished = (data?.events || []).filter(e => e.status?.type === 'finished').slice(0, 5)
    if (!finished.length) return null
    const lines = finished.map(ev => {
      const hs = ev.homeScore?.current ?? '?'
      const as_ = ev.awayScore?.current ?? '?'
      const h = translateHockeyTeamExpress(ev.homeTeam?.name || '?')
      const a = translateHockeyTeamExpress(ev.awayTeam?.name || '?')
      return `  ${h} ${hs}:${as_} ${a}`
    })
    return lines.join('\n')
  } catch { return null }
}

// Fetch last 5 matches for a team (for form context)
async function fetchTeamFormForExpress(teamId) {
  if (!teamId) return null
  try {
    const data = await sofascoreGetExpress(`/api/v1/team/${teamId}/events/previous/0`)
    const events = (data?.events || []).filter(e => e.status?.type === 'finished').slice(0, 5)
    if (!events.length) return null
    const results = events.map(ev => {
      const isHome = ev.homeTeam?.id === teamId
      const tf = isHome ? ev.homeScore?.current : ev.awayScore?.current
      const ta = isHome ? ev.awayScore?.current : ev.homeScore?.current
      if (tf == null || ta == null) return 'Н'
      return tf > ta ? 'В' : tf < ta ? 'П' : 'Н'  // В=win, П=loss, Н=draw
    })
    const wins   = results.filter(r => r === 'В').length
    const losses = results.filter(r => r === 'П').length
    const draws  = results.filter(r => r === 'Н').length
    const n = results.length
    return `${wins}П/${losses}П/${draws}Н из ${n} матчей`
  } catch { return null }
}

// Main sport-specific express generator
async function generateSportExpress(sport, type, targetDate) {
  let matches = []

  // Берём матчи ТОЛЬКО на targetDate — никаких других дней
  matches = await fetchHockeyMatchesForExpress(targetDate)
  if (matches.length < 2) throw new Error(`Нет хоккейных матчей на ${targetDate}`)

  // Overlay real bookmaker odds from The Odds API
  const oddsMap = await fetchHockeyOddsForExpress().catch(() => ({}))
  matches = matches.map(m => ({ ...m, odds: lookupHockeyOdds(m.home, m.away, oddsMap) }))
  const withOdds = matches.filter(m => m.odds).length
  console.log(`[express/hockey] ${matches.length} matches, ${withOdds} with real odds`)

  // ── Fetch h2h + team form for each match in parallel (same as match analysis) ─
  const top6 = matches.slice(0, 6)
  const matchesWithStats = await Promise.all(top6.map(async m => {
    const [h2h, homeForm, awayForm] = await Promise.all([
      fetchH2HForExpress(m.eventId),
      fetchTeamFormForExpress(m.homeTeamId),
      fetchTeamFormForExpress(m.awayTeamId),
    ])
    return { ...m, h2h, homeForm, awayForm }
  }))
  const h2hCount = matchesWithStats.filter(m => m.h2h).length
  console.log(`[express/h2h] fetched h2h for ${h2hCount}/${top6.length} matches`)

  // ── Also try NHL standings (may work if redirect is now fixed) ────────────
  const hasNHL = matches.some(m => m.league?.includes('НХЛ'))
  const nhlStandingsMap = hasNHL ? await fetchNHLStandingsMap().catch(() => null) : null
  if (nhlStandingsMap) {
    const findAbbrev = (ruName) =>
      Object.entries(NHL_TEAMS_RU).find(([, ru]) => ru === ruName)?.[0]
    matchesWithStats.forEach((m, i) => {
      if (!m.league?.includes('НХЛ')) return
      const homeAbbr = findAbbrev(m.home)
      const awayAbbr = findAbbrev(m.away)
      matchesWithStats[i] = {
        ...m,
        homeRecord: homeAbbr ? nhlStandingsMap[homeAbbr] : null,
        awayRecord: awayAbbr ? nhlStandingsMap[awayAbbr] : null,
      }
    })
  }

  const prompt = buildSportExpressPrompt(sport, type, matchesWithStats, targetDate)
  const content = await openAIRequest([
    { role: 'system', content: `Ты эксперт по ставкам на спорт. Отвечай только валидным JSON на русском языке.` },
    { role: 'user', content: prompt },
  ])
  return parseExpressJson(content, targetDate, sport, type)
}

async function fetchRealMatches(targetDate) {
  const key = process.env.SSTATS_API_KEY
  if (!key) return { matches: [], date: targetDate }

  // Шаг 1: ищем в топ-лигах
  const topResults = await Promise.all(
    TOP_LEAGUE_IDS.map(id =>
      httpsGet(`https://api.sstats.net/Games/list?upcoming=true&leagueid=${id}&limit=5&apikey=${key}`)
        .catch(() => ({ data: [] }))
    )
  )

  const normalizeGame = g => ({
    id: g.id,
    home: translateTeam(g.homeTeam.name),
    away: translateTeam(g.awayTeam.name),
    league: g.season?.league?.name || 'Unknown',
    leagueId: g.season?.league?.id || null,
  })

  const topGames = topResults.flatMap(r => Array.isArray(r.data) ? r.data : [])
  let matches = topGames
    .filter(g => g.date && g.homeTeam?.name && g.awayTeam?.name && g.date.slice(0, 10) === targetDate)
    .map(normalizeGame)

  console.log(`[express] fetchRealMatches TOP: date=${targetDate}, found=${matches.length} matches`)

  // Шаг 2: если меньше 2 матчей — расширяем поиск (международные перерывы, другие лиги)
  if (matches.length < 2) {
    console.log(`[express] Expanding to extended leagues (national teams, secondary leagues)...`)
    const extResults = await Promise.all(
      EXTENDED_LEAGUE_IDS.map(id =>
        httpsGet(`https://api.sstats.net/Games/list?upcoming=true&leagueid=${id}&limit=5&apikey=${key}`)
          .catch(() => ({ data: [] }))
      )
    )
    const extGames = extResults.flatMap(r => Array.isArray(r.data) ? r.data : [])
    const extMatches = extGames
      .filter(g => g.date && g.homeTeam?.name && g.awayTeam?.name && g.date.slice(0, 10) === targetDate)
      .map(normalizeGame)

    // Объединяем без дублей
    for (const m of extMatches) {
      if (!matches.some(g => g.home === m.home && g.away === m.away)) {
        matches.push(m)
      }
    }

    // Сортируем по приоритету лиги
    matches.sort((a, b) => {
      const pa = LEAGUE_PRIORITY_EXPRESS[a.leagueId] || 0
      const pb = LEAGUE_PRIORITY_EXPRESS[b.leagueId] || 0
      return pb - pa
    })

    console.log(`[express] fetchRealMatches EXTENDED: total=${matches.length} matches (leagues: ${[...new Set(matches.map(m => m.league))].join(', ')})`)
  }

  console.log(`[express] fetchRealMatches: date=${targetDate}, found=${matches.length} matches`)
  return { matches, date: targetDate }
}

// Только ключевые рынки чтобы не раздувать промпт
const KEY_MARKETS = ['1x2', 'match winner', 'home/draw/away', 'full time result',
  'over/under', 'total goals', 'both teams to score', 'double chance',
  'asian handicap', 'handicap']

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
      const name = (market.marketName || '').toLowerCase()
      // Только ключевые рынки
      if (!KEY_MARKETS.some(k => name.includes(k))) continue
      const outcomeParts = market.odds.map(o => `${o.name}=${o.value}`).join(', ')
      lines.push(`  [${market.marketName}]: ${outcomeParts}`)
      if (lines.length >= 6) break // максимум 6 рынков на матч
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
  // Берём матчи из Fonbet (тот же список что на странице анализа)
  const { getFonbetFootballMatches } = require('./matches')
  const matches = await getFonbetFootballMatches(targetDate)

  if (matches.length < 2) {
    throw new Error(`Нет матчей Fonbet на ${targetDate}. Попробуйте перегенерировать позже.`)
  }

  // Максимум 10 матчей в промпте
  const useMatches = matches.slice(0, 12)

  const matchBlocks = useMatches.map((m, i) => {
    const o = m.markets || {}
    const lines = [`П1=${o.home}  X=${o.draw}  П2=${o.away}`]
    if (o.dc1x) lines.push(`1X(ДШ)=${o.dc1x}`)
    if (o.dcx2) lines.push(`X2(ДШ)=${o.dcx2}`)
    if (o.tb25) lines.push(`ТБ2.5=${o.tb25}`)
    if (o.tm25) lines.push(`ТМ2.5=${o.tm25}`)
    if (o.tb35) lines.push(`ТБ3.5=${o.tb35}`)
    if (o.tm35) lines.push(`ТМ3.5=${o.tm35}`)
    return `${i + 1}. ${m.home} — ${m.away} (${m.league})\n   ${lines.join('  ')}`
  }).join('\n\n')

  const isHigh = type === 'high'
  const oddsRequirement = isHigh
    ? `- Выбери РОВНО 3 события
- Итоговый коэффициент экспресса НЕ МЕНЕЕ 3.00
- Каждый коэффициент от 1.40 до 2.00 — ЗАПРЕЩЕНО брать коэф > 2.00
- ОБЯЗАТЕЛЬНО используй разные типы ставок — не только П1/П2. Ищи ценность в тоталах (ТБ/ТМ), двойном шансе, неочевидных исходах
- Вероятность прохода каждой ставки >70%`
    : `- Выбери РОВНО 2 события
- Итоговый коэффициент экспресса от 2.00 до 3.00
- Выбирай исходы с вероятностью прохода >70%
- Предпочитай тоталы (ТБ/ТМ 2.5) или Двойной шанс — они надёжнее чистого П1/П2
- Каждый коэффициент от 1.40 до 1.60 — ЗАПРЕЩЕНО брать коэф > 1.60`

  const teamList = useMatches.map(m => `${m.home} — ${m.away}`).join(', ')

  const prompt = `Ты — эксперт по ставкам на футбол. Составь ${isHigh ? 'ВЫСОКОДОХОДНЫЙ' : 'НАДЁЖНЫЙ'} экспресс на ${targetDate}.
ВАЖНО: ЗАПРЕЩЕНО добавлять один и тот же матч дважды, даже с разными типами ставок. Каждый матч — максимум 1 раз.

ШАГ 1 — ПОИСК ДАННЫХ.
Найди на flashscore.com или sports.ru текущую форму и статистику для этих матчей: ${teamList}
Для каждой пары команд выясни:
- Последние 4-5 результатов каждой команды (победы/поражения, голы)
- Есть ли явный фаворит и насколько велик разрыв в классе
- Средний тотал голов (забивают много или мало)
- Ключевые травмы или дисквалификации

ШАГ 2 — ОЦЕНКА МАТЧЕЙ.
На основе найденных данных оцени каждый матч ниже и выбери ${isHigh ? '3' : '2'} с наибольшей уверенностью (>70%).

МАТЧИ С КОЭФФИЦИЕНТАМИ FONBET НА ${targetDate}:
${matchBlocks}

ШАГ 3 — СОСТАВЬ ЭКСПРЕСС.
Требования:
- Выбирай ТОЛЬКО из матчей выше
- В "odds" ставь ТОЧНОЕ число из коэффициентов выше
- В "prediction": "Победа хозяев (П1)", "Победа гостей (П2)", "Ничья (X)", "Двойной шанс (1X)", "Двойной шанс (X2)", "Тотал больше 2.5 (ТБ 2.5)", "Тотал меньше 2.5 (ТМ 2.5)", "Тотал больше 3.5 (ТБ 3.5)", "Тотал меньше 3.5 (ТМ 3.5)"
- home/away/league — ТОЧНО как в списке выше
- В "reasoning" — конкретные факты из поиска (результаты, голы, форма)
- Не придумывай статистику — только то, что нашёл
- ВСЕ поля — на русском языке
${oddsRequirement}

Ответь ТОЛЬКО валидным JSON:
{
  "date": "${targetDate}",
  "picks": [
    {
      "home": "название из списка",
      "away": "название из списка",
      "league": "лига из списка",
      "prediction": "Тотал больше 2.5 (ТБ 2.5)",
      "odds": 1.75,
      "reasoning": "Факты из поиска: форма, голы, почему исход надёжный."
    }
  ],
  "total_odds": 2.85,
  "summary": "Краткое описание экспресса на русском"
}`

  const content = await openAIRequest([
    { role: 'system', content: 'Ты профессиональный беттинг-аналитик. Сначала ищи актуальные данные в интернете, потом выбирай ставки. Не придумывай статистику. Отвечай только валидным JSON на русском языке. Используй только коэффициенты из предоставленного списка.' },
    { role: 'user', content: prompt },
  ])

  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Invalid JSON from OpenAI')
  let data
  try { data = JSON.parse(jsonMatch[0]) } catch { throw new Error('JSON parse failed') }

  const expectedPicks = isHigh ? 3 : 2
  if (!data.picks || data.picks.length < expectedPicks) throw new Error('Not enough picks')
  data.picks = data.picks.slice(0, expectedPicks)

  // Deduplicate: one match can only appear once in an express
  const seenMatches = new Set()
  data.picks = data.picks.filter(p => {
    const key = `${p.home}|${p.away}`
    if (seenMatches.has(key)) return false
    seenMatches.add(key)
    return true
  })
  if (data.picks.length < expectedPicks) throw new Error('Duplicate matches in express, regenerating')

  const total = data.picks.reduce((acc, p) => acc * (parseFloat(p.odds) || 1), 1)
  data.total_odds = Math.round(total * 100) / 100
  return data
}

// ── GET /express/today ────────────────────────────────────────────────────────
router.get('/today', async (req, res) => {
  const sport = req.query.sport || 'football'

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

    // expressDate нужен для хоккея и других видов спорта (стандартная логика)
    const expressDate = getTomorrowDate()

    // ── Football: ищем только завтра, послезавтра, +3 (НЕ сегодня — матчи должны быть завтрашними)
    if (sport === 'football') {
      const CANDIDATE_DATES = [
        getTomorrowDate(),
        getDateOffset(2),
        getDateOffset(3),
      ]

      const formatRow = (row, date, purchaseTable) => {
        let expressData
        try { expressData = JSON.parse(row.data) } catch { return null }
        const purchased = userId
          ? !!db.prepare(`SELECT 1 FROM ${purchaseTable} WHERE user_id = ? AND express_date = ?`).get(userId, date)
          : false
        if (purchased) return { date, purchased: true, ...expressData }
        return {
          date, purchased: false,
          summary: expressData.summary, total_odds: expressData.total_odds,
          picks_count: expressData.picks.length,
          picks: expressData.picks.map(p => ({ home: p.home, away: p.away, league: p.league, prediction: null, odds: null })),
        }
      }

      const getOrGenerate = async (table, purchaseTable) => {
        const type = table === 'daily_express' ? 'standard' : 'high'

        // 1. Ищем уже готовый экспресс в любой из кандидатных дат
        for (const date of CANDIDATE_DATES) {
          const row = db.prepare(`SELECT * FROM ${table} WHERE date = ?`).get(date)
          if (row) return formatRow(row, date, purchaseTable)
        }

        // 2. Не нашли — пробуем генерировать, начиная с завтра
        const noMatchKey = `football_${type}`
        if (isNoMatchCached(noMatchKey)) return null

        for (const date of CANDIDATE_DATES) {
          let row = null
          await withMutex(`${table}_${date}`, async () => {
            const existing = db.prepare(`SELECT * FROM ${table} WHERE date = ?`).get(date)
            if (existing) { row = existing; return }
            try {
              const data = await generateExpress(date, type)
              db.prepare(`INSERT OR IGNORE INTO ${table} (date, data) VALUES (?, ?)`).run(date, JSON.stringify(data))
              row = db.prepare(`SELECT * FROM ${table} WHERE date = ?`).get(date)
              console.log(`[express/football] Generated ${type} for ${date}`)
            } catch (e) {
              console.warn(`[express/football] No matches for ${date}: ${e.message}`)
            }
          })
          if (!row) row = db.prepare(`SELECT * FROM ${table} WHERE date = ?`).get(date)
          if (row) return formatRow(row, date, purchaseTable)
        }

        // Кэшируем "нет матчей" на 2 часа — не сканируем повторно
        setNoMatchCache(noMatchKey)
        console.log(`[express/football] No matches found for any candidate date, caching miss for 2h`)
        return null
      }

      const standard = await getOrGenerate('daily_express', 'express_purchases')
      await new Promise(r => setTimeout(r, 3000))
      const high = await getOrGenerate('daily_express_high', 'express_purchases_high')
      return res.json({ standard, high })
    }

    // ── Other sports: express_sports table ───────────────────────────────────
    // Candidate dates: tomorrow, +2, +3 — всегда показываем завтрашний экспресс
    const isEsport = sport === 'cs2' || sport === 'dota2'
    const SPORT_CANDIDATE_DATES = [getTomorrowDate(), getDateOffset(2), getDateOffset(3)]

    const formatSportRow = (row, date, type) => {
      let expressData
      try { expressData = JSON.parse(row.data) } catch { return null }
      const purchased = userId
        ? !!db.prepare('SELECT 1 FROM express_sports_purchases WHERE user_id = ? AND express_date = ? AND sport = ? AND type = ?').get(userId, date, sport, type)
        : false
      if (purchased) return { date, purchased: true, generated_at: row.created_at, ...expressData }
      return {
        date, purchased: false,
        generated_at: row.created_at,
        summary: expressData.summary, total_odds: expressData.total_odds,
        picks_count: expressData.picks.length,
        picks: expressData.picks.map(p => ({ home: p.home, away: p.away, league: p.league, prediction: null, odds: null })),
      }
    }

    const getOrGenerateSport = async (type) => {
      // 1. Ищем уже готовый экспресс в любой кандидатной дате
      for (const date of SPORT_CANDIDATE_DATES) {
        const row = db.prepare('SELECT * FROM express_sports WHERE date = ? AND sport = ? AND type = ?').get(date, sport, type)
        if (row) return formatSportRow(row, date, type)
      }

      // 2. Не нашли — пробуем генерировать начиная с завтра
      const genDates = [getTomorrowDate(), getDateOffset(2)]

      for (const date of genDates) {
        const noMatchKey = `${sport}_${type}_${date}`
        if (isNoMatchCached(noMatchKey)) continue
        let row = null
        await withMutex(`sport_${sport}_${type}_${date}`, async () => {
          const existing = db.prepare('SELECT * FROM express_sports WHERE date = ? AND sport = ? AND type = ?').get(date, sport, type)
          if (existing) { row = existing; return }
          try {
            const generator = isEsport ? generateEsportsExpress : generateSportExpress
            const data = await generator(sport, type, date)
            db.prepare('INSERT OR IGNORE INTO express_sports (date, sport, type, data) VALUES (?, ?, ?, ?)').run(date, sport, type, JSON.stringify(data))
            row = db.prepare('SELECT * FROM express_sports WHERE date = ? AND sport = ? AND type = ?').get(date, sport, type)
            console.log(`[express/${sport}] Generated ${type} for ${date}`)
          } catch (e) {
            console.warn(`[express/${sport}] No matches for ${date}: ${e.message}`)
            setNoMatchCache(noMatchKey)
          }
        })
        if (!row) row = db.prepare('SELECT * FROM express_sports WHERE date = ? AND sport = ? AND type = ?').get(date, sport, type)
        if (row) return formatSportRow(row, date, type)
      }
      return null
    }

    const standard = await getOrGenerateSport('standard').catch(() => null)
    await new Promise(r => setTimeout(r, 2000)) // пауза между OpenAI запросами
    const high = await getOrGenerateSport('high').catch(() => null)
    res.json({ standard, high })

  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /express/purchase ────────────────────────────────────────────────────
router.post('/purchase', authenticate, (req, res) => {
  // Используем дату из тела запроса (клиент знает на какую дату экспресс)
  // Fallback: завтра — для обратной совместимости
  const rawDate = req.body?.date
  const expressDate = (rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate))
    ? rawDate
    : getTomorrowDate()
  const userId = req.user.id
  const type = req.body?.type === 'high' ? 'high' : 'standard'
  const sport = req.body?.sport || 'football'
  const cost = type === 'standard' ? EXPRESS_COST_STANDARD : EXPRESS_COST_HIGH

  // Football — legacy tables
  if (sport === 'football') {
    const table = type === 'standard' ? 'daily_express' : 'daily_express_high'
    const purchaseTable = type === 'standard' ? 'express_purchases' : 'express_purchases_high'
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
      db.prepare('INSERT INTO coin_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(userId, -cost, 'spend', `Экспресс (${sport}/${type})`)
    }
    db.prepare(`INSERT OR IGNORE INTO ${purchaseTable} (user_id, express_date) VALUES (?, ?)`).run(userId, expressDate)
    const updated = db.prepare('SELECT coins FROM users WHERE id = ?').get(userId)
    return res.json({ purchased: true, coins: updated.coins, ...JSON.parse(row.data) })
  }

  // Other sports — express_sports table
  const alreadyBought = db.prepare('SELECT 1 FROM express_sports_purchases WHERE user_id = ? AND express_date = ? AND sport = ? AND type = ?').get(userId, expressDate, sport, type)
  if (alreadyBought) {
    const row = db.prepare('SELECT * FROM express_sports WHERE date = ? AND sport = ? AND type = ?').get(expressDate, sport, type)
    if (!row) return res.status(404).json({ error: 'Экспресс не найден' })
    return res.json({ purchased: true, ...JSON.parse(row.data) })
  }
  const row = db.prepare('SELECT * FROM express_sports WHERE date = ? AND sport = ? AND type = ?').get(expressDate, sport, type)
  if (!row) return res.status(404).json({ error: 'Экспресс ещё не сгенерирован' })
  if (!req.user.is_admin) {
    const user = db.prepare('SELECT coins FROM users WHERE id = ?').get(userId)
    if (user.coins < cost) return res.status(402).json({ error: 'Недостаточно монет', coins: user.coins })
    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(cost, userId)
    db.prepare('INSERT INTO coin_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(userId, -cost, 'spend', `Экспресс (${sport}/${type})`)
  }
  db.prepare('INSERT OR IGNORE INTO express_sports_purchases (user_id, express_date, sport, type) VALUES (?, ?, ?, ?)').run(userId, expressDate, sport, type)
  const updated = db.prepare('SELECT coins FROM users WHERE id = ?').get(userId)
  res.json({ purchased: true, coins: updated.coins, ...JSON.parse(row.data) })
})

// ── GET /express/debug-stats (admin) — проверить работу API статистики ──────
router.get('/debug-stats', authenticate, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Только для администраторов' })
  const result = { iihf: null, nhl: null, iihfRaw: null, nhlRaw: null }

  // IIHF standings raw
  try {
    const sid = seasonIdCacheEx.get(3)?.seasonId || 81043
    const data = await sofascoreGetExpress(`/api/v1/unique-tournament/3/season/${sid}/standings/total`)
    result.iihfRaw = JSON.stringify(data).slice(0, 1000)
    result.iihf = await fetchIIHFGroupStandings(sid)
  } catch (err) {
    result.iihf = `ERROR: ${err.message}`
    result.iihfRaw = err.message
  }

  // NHL standings raw
  try {
    const data = await httpsGet('https://api-web.nhle.com/v1/standings/now')
    result.nhlRaw = JSON.stringify((data?.standings || []).slice(0, 2)).slice(0, 800)
    result.nhl = await fetchNHLStandingsMap()
    if (result.nhl) result.nhlSample = Object.entries(result.nhl).slice(0, 5)
  } catch (err) {
    result.nhl = `ERROR: ${err.message}`
    result.nhlRaw = err.message
  }

  res.json(result)
})

// ── GET /express/debug-football (admin) — диагностика футбольного экспресса ──
router.get('/debug-football', authenticate, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Только для администраторов' })

  const targetDate = getTomorrowDate()
  const result = {
    targetDate,
    sstatsKeySet: !!process.env.SSTATS_API_KEY,
    leagues: {},
    totalMatches: 0,
    matchesWithOdds: 0,
    matchesList: [],
    error: null,
  }

  if (!process.env.SSTATS_API_KEY) {
    result.error = 'SSTATS_API_KEY не установлен в переменных окружения Railway'
    return res.json(result)
  }

  try {
    // Проверяем каждую лигу отдельно
    for (const leagueId of TOP_LEAGUE_IDS) {
      try {
        const data = await httpsGet(
          `https://api.sstats.net/Games/list?upcoming=true&leagueid=${leagueId}&limit=10&apikey=${process.env.SSTATS_API_KEY}`
        )
        const games = Array.isArray(data?.data) ? data.data : []
        const todayGames = games.filter(g => g.date?.slice(0, 10) === targetDate)
        result.leagues[leagueId] = {
          total: games.length,
          onTargetDate: todayGames.length,
          sample: todayGames.slice(0, 3).map(g => `${g.homeTeam?.name} vs ${g.awayTeam?.name}`),
        }
      } catch (err) {
        result.leagues[leagueId] = { error: err.message }
      }
    }

    // Полный список матчей через fetchRealMatches
    const { matches } = await fetchRealMatches(targetDate)
    result.totalMatches = matches.length
    result.matchesList = matches.map(m => ({ home: m.home, away: m.away, league: m.league, id: m.id }))

    // Проверяем коэффициенты для первых 3 матчей
    if (matches.length > 0) {
      const sample = matches.slice(0, 3)
      const oddsResults = await Promise.all(sample.map(m => fetchOddsText(m.id)))
      result.matchesWithOdds = oddsResults.filter(Boolean).length
      result.oddsSample = sample.map((m, i) => ({
        match: `${m.home} vs ${m.away}`,
        hasOdds: !!oddsResults[i],
        oddsPreview: oddsResults[i]?.slice(0, 120) || null,
      }))
    }
  } catch (err) {
    result.error = err.message
  }

  res.json(result)
})

// ── GET /express/debug-hockey (admin) — диагностика хоккейного экспресса ─────
router.get('/debug-hockey', authenticate, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Только для администраторов' })

  const targetDate = getTomorrowDate()
  const result = {
    targetDate,
    sources: {},
    totalMatches: 0,
    withOdds: 0,
    matchesList: [],
    oddsApiKeySet: !!process.env.ODDS_API_KEY,
    rapidApiKeySet: !!process.env.RAPIDAPI_KEY,
    error: null,
  }

  try {
    // ── NHL (free API) ────────────────────────────────────────────────────────
    const nhlMatches = []
    try {
      const prevDate = new Date(targetDate)
      prevDate.setDate(prevDate.getDate() - 1)
      const data = await httpsGet(`https://api-web.nhle.com/v1/schedule/${targetDate}`)
      const allowed = new Set([prevDate.toISOString().slice(0, 10), targetDate])
      for (const day of (data.gameWeek || [])) {
        if (!allowed.has(day.date)) continue
        for (const game of (day.games || [])) {
          if (game.gameState === 'OFF' || game.gameState === 'FINAL') continue
          const ha = game.homeTeam?.abbrev || ''
          const aa = game.awayTeam?.abbrev || ''
          const home = NHL_TEAMS_RU[ha] || ha
          const away = NHL_TEAMS_RU[aa] || aa
          if (home && away) nhlMatches.push({ home, away, league: 'НХЛ' })
        }
      }
      result.sources['НХЛ (free API)'] = { count: nhlMatches.length, status: 'ok' }
    } catch (err) {
      result.sources['НХЛ (free API)'] = { count: 0, status: 'error', detail: err.message }
    }

    // ── AllSports/Sofascore: ИИХФ ЧМ, КХЛ, МХЛ, ВХЛ ────────────────────────
    const leagueMatches = []
    for (const t of HOCKEY_TOURNAMENTS_EXPRESS) {
      try {
        const seasonId = await fetchSeasonIdForExpress(t.id, t.fallbackSeasonId)
        if (!seasonId) { result.sources[t.league] = { count: 0, status: 'no_season' }; continue }
        const matches = await fetchTournamentMatchesForExpress({ ...t, seasonId }, targetDate)
        leagueMatches.push(...matches)
        result.sources[t.league] = {
          count: matches.length, status: 'ok',
          sample: matches.slice(0, 2).map(m => `${m.home} vs ${m.away}`),
        }
      } catch (err) {
        result.sources[t.league] = { count: 0, status: 'error', detail: err.message }
      }
    }

    // ── Итого ─────────────────────────────────────────────────────────────────
    const allMatches = [...nhlMatches, ...leagueMatches]
    result.totalMatches = allMatches.length
    result.matchesList = allMatches.map(m => ({ home: m.home, away: m.away, league: m.league }))

    // ── Odds API ──────────────────────────────────────────────────────────────
    if (process.env.ODDS_API_KEY && allMatches.length > 0) {
      try {
        const oddsMap = await fetchHockeyOddsForExpress()
        const withOdds = allMatches.filter(m => lookupHockeyOdds(m.home, m.away, oddsMap)).length
        result.withOdds = withOdds
        result.oddsSample = allMatches.slice(0, 3).map(m => {
          const odds = lookupHockeyOdds(m.home, m.away, oddsMap)
          return { match: `${m.home} vs ${m.away}`, hasOdds: !!odds, odds: odds || null }
        })
      } catch (err) {
        result.oddsError = err.message
      }
    }

  } catch (err) {
    result.error = err.message
  }

  res.json(result)
})

// ── GET /express/debug-cs2 (admin) ───────────────────────────────────────────
router.get('/debug-cs2', authenticate, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Только для администраторов' })
  await debugEsport('cs2', res)
})

// ── GET /express/debug-dota2 (admin) ─────────────────────────────────────────
router.get('/debug-dota2', authenticate, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Только для администраторов' })
  await debugEsport('dota2', res)
})

async function debugEsport(game, res) {
  const targetDate = getTomorrowDate()
  const result = {
    targetDate,
    game,
    totalMatches: 0,
    matchesList: [],
    error: null,
  }
  try {
    const { getFonbetEsportsMatches } = require('./matches')
    const matches = await getFonbetEsportsMatches(game, targetDate)
    result.totalMatches = matches.length
    result.matchesList = matches.map(m => ({
      home: m.home,
      away: m.away,
      league: m.league,
      markets: m.markets,
    }))
  } catch (err) {
    result.error = err.message
  }
  res.json(result)
}

// ── POST /express/generate (admin) ───────────────────────────────────────────
router.post('/generate', authenticate, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Только для администраторов' })

  // Поддержка произвольной даты (YYYY-MM-DD) — по умолчанию завтра
  const rawDate = req.body?.date
  const expressDate = (rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate))
    ? rawDate
    : getTomorrowDate()

  const type  = req.body?.type  // 'standard' | 'high' | undefined (both)
  const sport = req.body?.sport || 'football'

  try {
    // ── Non-football sports → express_sports table ───────────────────────────
    if (sport !== 'football') {
      const isEsport = sport === 'cs2' || sport === 'dota2'
      const generator = isEsport ? generateEsportsExpress : generateSportExpress

      if (type === 'standard' || type === 'high') {
        const data = await generator(sport, type, expressDate)
        db.prepare('INSERT OR REPLACE INTO express_sports (date, sport, type, data) VALUES (?, ?, ?, ?)')
          .run(expressDate, sport, type, JSON.stringify(data))
        return res.json({ success: true, date: expressDate, sport, type, ...data })
      }
      // Both types
      const [standard, high] = await Promise.all([
        generator(sport, 'standard', expressDate),
        generator(sport, 'high',     expressDate),
      ])
      db.prepare('INSERT OR REPLACE INTO express_sports (date, sport, type, data) VALUES (?, ?, ?, ?)')
        .run(expressDate, sport, 'standard', JSON.stringify(standard))
      db.prepare('INSERT OR REPLACE INTO express_sports (date, sport, type, data) VALUES (?, ?, ?, ?)')
        .run(expressDate, sport, 'high', JSON.stringify(high))
      return res.json({ success: true, date: expressDate, sport, standard, high })
    }

    // ── Football → legacy daily_express / daily_express_high tables ──────────
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
    // Both
    const [standard, high] = await Promise.all([
      generateExpress(expressDate, 'standard'),
      generateExpress(expressDate, 'high'),
    ])
    db.prepare('INSERT OR REPLACE INTO daily_express (date, data) VALUES (?, ?)').run(expressDate, JSON.stringify(standard))
    db.prepare('INSERT OR REPLACE INTO daily_express_high (date, data) VALUES (?, ?)').run(expressDate, JSON.stringify(high))
    res.json({ success: true, date: expressDate, standard, high })
  } catch (err) {
    const status = err.message?.includes('Нет') ? 404 : 500
    res.status(status).json({ error: err.message })
  }
})

// ── Esports express generator (CS2 / Dota2) ──────────────────────────────────
async function generateEsportsExpress(game, type, targetDate) {
  const { getFonbetEsportsMatches } = require('./matches')

  // Берём матчи ТОЛЬКО на targetDate — никакого расширения на другие дни
  const matches = await getFonbetEsportsMatches(game, targetDate)
  if (matches.length < 2) {
    throw new Error(`Нет матчей ${game} на ${targetDate}`)
  }

  const useMatches = matches.slice(0, 10)
  const gameName = game === 'cs2' ? 'CS2' : 'Dota 2'
  const isHigh = type === 'high'

  const matchBlocks = useMatches.map((m, i) => {
    const o = m.markets || {}
    const lines = []
    if (o.home)  lines.push(`П1=${o.home}`)
    if (o.away)  lines.push(`П2=${o.away}`)
    if (o.tb25)  lines.push(`ТБ2.5карт=${o.tb25}`)
    if (o.tm25)  lines.push(`ТМ2.5карт=${o.tm25}`)
    if (o.map1h) lines.push(`Карта1-П1=${o.map1h}`)
    if (o.map1a) lines.push(`Карта1-П2=${o.map1a}`)
    if (o.hcp1)  lines.push(`Фора+1.5(П1)=${o.hcp1}`)
    if (o.hcp2)  lines.push(`Фора+1.5(П2)=${o.hcp2}`)
    return `${i + 1}. ${m.home} vs ${m.away} [${m.league}]\n   ${lines.join('  ')}`
  }).join('\n\n')

  const oddsReq = isHigh
    ? `- РОВНО 3 события, итоговый коэф НЕ МЕНЕЕ 3.00, каждый коэф от 1.40 до 2.00 — ЗАПРЕЩЕНО брать коэф > 2.00
- Ищи ценность в форах карт (+1.5), победителе первой карты, тоталах карт
- Вероятность каждой ставки >70%`
    : `- РОВНО 2 события, итоговый коэф от 2.00 до 3.00
- Предпочитай надёжные ставки: тотал карт ТМ2.5 или фора +1.5 для фаворита
- Вероятность каждой ставки >70%, каждый коэф от 1.40 до 1.60 — ЗАПРЕЩЕНО брать коэф > 1.60`

  const esportSource = game === 'cs2' ? 'hltv.org и liquipedia.net/counterstrike' : 'liquipedia.net/dota2 и dotabuff.com'
  const esportTeamList = useMatches.map(m => `${m.home} vs ${m.away}`).join(', ')

  const prompt = `Ты — эксперт по ставкам на ${gameName}. Составь ${isHigh ? 'ВЫСОКОДОХОДНЫЙ' : 'НАДЁЖНЫЙ'} экспресс.

ШАГ 1 — ПОИСК ДАННЫХ.
Найди на ${esportSource} актуальную форму для этих матчей: ${esportTeamList}
Для каждой пары выясни:
- Последние 5 результатов каждой команды (победы/поражения по картам)
- Кто явный фаворит и насколько велика разница в классе
- Склонность к Bo3 (часто ли доходит до 3 карт или один доминирует)
${game === 'cs2' ? '- HLTV рейтинг команд и ключевые игроки\n- Map pool — на каких картах каждая команда сильнее' : '- Текущий состав и герои-пики ключевых игроков'}

ШАГ 2 — ОЦЕНКА МАТЧЕЙ.
На основе найденного выбери ${isHigh ? '3' : '2'} матча с наибольшей уверенностью (>70%).

МАТЧИ ${gameName.toUpperCase()} С КОЭФФИЦИЕНТАМИ FONBET:
${matchBlocks}

ПОЯСНЕНИЕ РЫНКОВ:
- П1/П2 — победитель матча
- ТБ/ТМ 2.5 карт — сыграют больше/меньше 2.5 карт (Bo3)
- Карта1-П1/П2 — победитель первой карты
- Фора+1.5 — команда возьмёт хотя бы 1 карту в Bo3

ШАГ 3 — СОСТАВЬ ЭКСПРЕСС.
- Выбирай ТОЛЬКО из матчей выше
- В "odds" — ТОЧНОЕ число из таблицы выше
- В "prediction": "Победа команды X (П1)", "ТБ 2.5 карт", "Карта 1 — X", "Фора +1.5 — X"
- home/away/league — ТОЧНО как в списке выше
- В "reasoning" — конкретные факты из поиска (результаты, рейтинг, форма)
- Не придумывай статистику — только то, что нашёл
- ВСЕ поля — на русском языке
${oddsReq}

Ответь ТОЛЬКО валидным JSON:
{
  "date": "${targetDate}",
  "picks": [
    {
      "home": "название",
      "away": "название",
      "league": "лига",
      "prediction": "ТБ 2.5 карт",
      "odds": 1.83,
      "reasoning": "Факты из поиска: форма, рейтинг, почему исход надёжный."
    }
  ],
  "total_odds": 2.75,
  "summary": "Краткое описание экспресса на русском"
}`

  const content = await openAIRequest([
    { role: 'system', content: `Ты профессиональный беттинг-аналитик по ${gameName}. Сначала ищи актуальные данные в интернете, потом выбирай ставки. Не придумывай статистику. Отвечай только валидным JSON на русском языке.` },
    { role: 'user', content: prompt },
  ])

  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Invalid JSON from OpenAI')
  let data
  try { data = JSON.parse(jsonMatch[0]) } catch { throw new Error('JSON parse failed') }

  const expectedPicks = isHigh ? 3 : 2
  if (!data.picks || data.picks.length < expectedPicks) throw new Error('Not enough picks')
  data.picks = data.picks.slice(0, expectedPicks)

  // Deduplicate: one match can only appear once in an express
  const seenMatchesEs = new Set()
  data.picks = data.picks.filter(p => {
    const key = `${p.home}|${p.away}`
    if (seenMatchesEs.has(key)) return false
    seenMatchesEs.add(key)
    return true
  })
  if (data.picks.length < expectedPicks) throw new Error('Duplicate matches in express, regenerating')

  const total = data.picks.reduce((acc, p) => acc * (parseFloat(p.odds) || 1), 1)
  data.total_odds = Math.round(total * 100) / 100
  return data
}

module.exports = router
module.exports.generateExpressForDate    = generateExpress
module.exports.generateSportExpressForCron = generateSportExpress
module.exports.generateEsportsExpress    = generateEsportsExpress
module.exports.getTomorrowDate           = getTomorrowDate
