const express = require('express')
const https = require('https')
const db = require('../db')
const { authenticate } = require('../middleware/auth')
const { translateTeam } = require('../teamNames')

const router = express.Router()
const EXPRESS_COST_STANDARD = 52
const EXPRESS_COST_HIGH = 72

// Только топ-лиги которые точно есть на BetBoom/Fonbet/Winline
// Убрали UECL/Eredivisie/Portuguesa — там попадаются команды которых нет на русских букмекерах
const ALL_LEAGUE_IDS = [
  2,   // Champions League
  3,   // Europa League
  39,  // Premier League
  140, // La Liga
  135, // Serie A
  78,  // Bundesliga 1
  61,  // Ligue 1
  235, // Russian Premier League
]

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
    const body = JSON.stringify({ model: 'gpt-4o', messages, temperature: 0.7, max_tokens: 900 })
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
function parseExpressJson(content, date, sport = 'football') {
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Invalid JSON from OpenAI')
  let data
  try { data = JSON.parse(jsonMatch[0]) } catch { throw new Error('JSON parse failed') }
  if (!data.picks || !Array.isArray(data.picks) || data.picks.length < 1) throw new Error('No picks in response')
  data.date = data.date || date

  // For hockey: clamp individual odds to 2.00 max, then recalculate total
  if (sport === 'hockey') {
    data.picks = data.picks.map(p => ({
      ...p,
      odds: Math.min(parseFloat(p.odds) || 1.5, 2.00),
    }))
  }

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
    const oddsNote = `КОЭФФИЦИЕНТЫ:
- Где указаны П1/П2 — используй эти точные числа если выбираешь победу команды
- Для тоталов (ТБ/ТМ), фор и других рынков — оцени реалистично как у топ-букмекеров`

    const statsInstruction = hasAnyStats
      ? `- В "reasoning" ОБЯЗАТЕЛЬНО используй реальную статистику из блока выше
- Ссылайся на конкретные цифры: "в последних 4 встречах ...", "команда выиграла X из 5 матчей"`
      : `- В "reasoning" объясни ПОЧЕМУ выбрал именно эту ставку на основе силы команд`

    return `Ты эксперт по ставкам на хоккей. Твоя задача — составить МАКСИМАЛЬНО НАДЁЖНЫЙ экспресс.

МАТЧИ НА ${date}:
${matchBlocks}

${oddsNote}

ШАГ 1 — ОЦЕНКА КАЖДОГО МАТЧА.
Для каждого матча из списка выше определи:
- Наиболее вероятный исход (тип ставки + направление)
- Уверенность от 0 до 100 (только если уверенность ≥ 65 — матч подходит для экспресса)
- Причина уверенности (форма, H2H, явный фаворит, статистика тоталов)

ШАГ 2 — ОТБОР.
Возьми 2-3 матча с НАИБОЛЬШЕЙ уверенностью (≥ 65).
Если матчей с уверенностью ≥ 65 меньше 2 — бери лучшие из доступных.
НИКОГДА не включай матч с уверенностью < 55.

ШАГ 3 — СТАВКИ.
Для каждого отобранного матча выбери ставку:
  * Двойной шанс "1X" / "X2" — если один явный фаворит (коэф ~1.25–1.50)
  * Тотал "ТБ 5.5" / "ТМ 5.5" — если статистика голов очевидна (коэф ~1.65–1.85)
  * Победа "П1" / "П2" — только если коэф ≤ 2.00 и явное преимущество
  ЗАПРЕЩЕНО: коэф > 2.00

Итоговый коэф экспресса: строго 2.00–3.00.
Все текстовые поля СТРОГО на русском языке.
${statsInstruction}

Ответь ТОЛЬКО валидным JSON без markdown:
{"date":"${date}","picks":[{"home":"...","away":"...","league":"...","prediction":"1X","odds":1.40,"confidence":78,"reasoning":"Конкретное обоснование с цифрами из статистики"}],"total_odds":2.74,"summary":"Краткое описание почему этот экспресс надёжный"}`
  }

  // ── Football prompt (unchanged) ──────────────────────────────────────────
  const oddsReq = isHigh
    ? `- Итоговый коэф ≥ 4.00, выбери 3-4 события
- Каждый коэф от 1.40 и выше`
    : `- Итоговый коэф 2.00–4.00, выбери 2-3 события
- Каждый коэф 1.30–2.20`

  const statsInstruction = hasAnyStats
    ? `- В "reasoning" ОБЯЗАТЕЛЬНО используй реальную статистику из блока выше (личные встречи, форму команд, счета)
- Ссылайся на конкретные цифры: "в последних 4 встречах ...", "команда выиграла X из 5 матчей" и т.д.`
    : `- В "reasoning" объясни ПОЧЕМУ выбрал именно эту ставку (форма команд, статистика, сила составов)`

  return `Ты эксперт по ставкам на ${sportLabel}. Составь ${isHigh ? 'ВЫСОКОДОХОДНЫЙ' : 'НАДЁЖНЫЙ'} экспресс на основе реального расписания и РЕАЛЬНОЙ статистики.

МАТЧИ НА ${date} (со статистикой):
${matchBlocks}

Коэффициенты оцени реалистично на основе силы команд, как у топ-букмекеров.

Требования:
${oddsReq}
- Выбирай ТОЛЬКО из матчей выше
- Все текстовые поля СТРОГО на русском языке
- "prediction" — конкретная ставка (Победа хозяев / П1 / ТБ 2.5 / Фора (-1.5) / 1X)
${statsInstruction}

Ответь ТОЛЬКО валидным JSON без markdown:
{"date":"${date}","picks":[{"home":"...","away":"...","league":"...","prediction":"ТБ 5.5","odds":1.82,"reasoning":"Конкретное обоснование с реальными цифрами из статистики выше"}],"total_odds":2.72,"summary":"Описание экспресса на русском"}`
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

  // Accumulate matches from targetDate + next 4 days until we have at least 2
  // (NHL playoffs may have only 1 game per day — combine days)
  for (let i = 0; i <= 4; i++) {
    const d = new Date(targetDate); d.setDate(d.getDate() + i)
    const dateStr = d.toISOString().slice(0, 10)
    const dayMatches = await fetchHockeyMatchesForExpress(dateStr)
    for (const m of dayMatches) {
      if (!matches.some(g => g.home === m.home && g.away === m.away)) {
        matches.push(m)
      }
    }
    if (matches.length >= 2) break
  }
  if (matches.length < 2) throw new Error('Нет хоккейных матчей в ближайшие дни')

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
  return parseExpressJson(content, targetDate, sport)
}

async function fetchRealMatches(targetDate) {
  const key = process.env.SSTATS_API_KEY
  if (!key) return { matches: [], date: targetDate }

  const results = await Promise.all(
    ALL_LEAGUE_IDS.map(id =>
      httpsGet(`https://api.sstats.net/Games/list?upcoming=true&leagueid=${id}&limit=5&apikey=${key}`)
        .catch(() => ({ data: [] }))
    )
  )

  const allGames = results.flatMap(r => Array.isArray(r.data) ? r.data : [])

  const matches = allGames
    .filter(g => g.date && g.homeTeam?.name && g.awayTeam?.name && g.date.slice(0, 10) === targetDate)
    .map(g => ({ id: g.id, home: translateTeam(g.homeTeam.name), away: translateTeam(g.awayTeam.name), league: g.season?.league?.name || 'Unknown' }))

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
  const { matches: realMatches, date: actualDate } = await fetchRealMatches(targetDate)

  if (realMatches.length >= 2) {
    const oddsTexts = await Promise.all(realMatches.map(m => fetchOddsText(m.id)))

    const matchesWithOdds = realMatches.filter((m, i) => oddsTexts[i] !== null)
    const filteredOdds = oddsTexts.filter(o => o !== null)
    const useMatchesFull = matchesWithOdds.length >= 2 ? matchesWithOdds : realMatches
    const useOddsFull = matchesWithOdds.length >= 2 ? filteredOdds : oddsTexts
    // Максимум 6 матчей в промпте чтобы не превысить TPM лимит
    const useMatches = useMatchesFull.slice(0, 6)
    const useOdds = useOddsFull.slice(0, 6)

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

    const prompt = `Ты — эксперт по ставкам на спорт. Составь ${isHigh ? 'ВЫСОКОДОХОДНЫЙ' : 'НАДЁЖНЫЙ'} экспресс из РЕАЛЬНОГО расписания на ${actualDate}.

РЕАЛЬНЫЕ МАТЧИ С КОЭФФИЦИЕНТАМИ НА ${actualDate}:
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
  "date": "${actualDate}",
  "picks": [
    {
      "home": "название из списка",
      "away": "название из списка",
      "league": "лига из списка",
      "prediction": "Ставка на русском",
      "odds": 1.55,
      "reasoning": "Обоснование на русском 2-3 предложения: форма команд, статистика голов/пропусков, почему именно этот исход выигрышный."
    }
  ],
  "total_odds": 3.47,
  "summary": "Краткое описание экспресса на русском"
}`

    const content = await openAIRequest([
      { role: 'system', content: 'Ты эксперт по ставкам. Отвечай только валидным JSON на русском языке. Используй только реальные коэффициенты из предоставленного списка.' },
      { role: 'user', content: prompt },
    ])

    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('Invalid JSON from OpenAI')
    let data
    try { data = JSON.parse(jsonMatch[0]) } catch { throw new Error('JSON parse failed') }
    if (!data.picks || data.picks.length < 2) throw new Error('Not enough picks')

    const total = data.picks.reduce((acc, p) => acc * (parseFloat(p.odds) || 1), 1)
    data.total_odds = Math.round(total * 100) / 100
    return data
  }

  // Нет реальных матчей в топ-лигах на эту дату
  throw new Error(`Нет матчей в топ-лигах на ${targetDate}. Попробуйте перегенерировать позже.`)
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

    // ── Football: smart date search (завтра → сегодня → послезавтра → +3) ─────
    if (sport === 'football') {
      // Кандидаты в порядке приоритета: завтра первый (основной режим),
      // потом сегодня и послезавтра как fallback
      const CANDIDATE_DATES = [
        getTomorrowDate(),
        getTodayDate(),
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

        return null
      }

      const standard = await getOrGenerate('daily_express', 'express_purchases')
      await new Promise(r => setTimeout(r, 3000))
      const high = await getOrGenerate('daily_express_high', 'express_purchases_high')
      return res.json({ standard, high })
    }

    // ── Other sports: express_sports table ───────────────────────────────────
    const getOrGenerateSport = async (type) => {
      let row = db.prepare('SELECT * FROM express_sports WHERE date = ? AND sport = ? AND type = ?').get(expressDate, sport, type)
      if (!row) {
        await withMutex(`sport_${sport}_${type}_${expressDate}`, async () => {
          const existing = db.prepare('SELECT * FROM express_sports WHERE date = ? AND sport = ? AND type = ?').get(expressDate, sport, type)
          if (existing) { row = existing; return }
          try {
            const data = await generateSportExpress(sport, type, expressDate)
            db.prepare('INSERT OR IGNORE INTO express_sports (date, sport, type, data) VALUES (?, ?, ?, ?)').run(expressDate, sport, type, JSON.stringify(data))
            row = db.prepare('SELECT * FROM express_sports WHERE date = ? AND sport = ? AND type = ?').get(expressDate, sport, type)
          } catch (e) { console.error(`[express] ${sport}/${type}:`, e.message) }
        })
        if (!row) row = db.prepare('SELECT * FROM express_sports WHERE date = ? AND sport = ? AND type = ?').get(expressDate, sport, type)
      }
      if (!row) return null
      let expressData
      try { expressData = JSON.parse(row.data) } catch { return null }
      const purchased = userId
        ? !!db.prepare('SELECT 1 FROM express_sports_purchases WHERE user_id = ? AND express_date = ? AND sport = ? AND type = ?').get(userId, expressDate, sport, type)
        : false
      if (purchased) return { date: expressDate, purchased: true, generated_at: row.created_at, ...expressData }
      return {
        date: expressDate, purchased: false,
        generated_at: row.created_at,
        summary: expressData.summary, total_odds: expressData.total_odds,
        picks_count: expressData.picks.length,
        picks: expressData.picks.map(p => ({ home: p.home, away: p.away, league: p.league, prediction: null, odds: null })),
      }
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
    for (const leagueId of ALL_LEAGUE_IDS) {
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
    // ── Non-football sports (hockey etc.) → express_sports table ─────────────
    if (sport !== 'football') {
      if (type === 'standard' || type === 'high') {
        const data = await generateSportExpress(sport, type, expressDate)
        db.prepare('INSERT OR REPLACE INTO express_sports (date, sport, type, data) VALUES (?, ?, ?, ?)')
          .run(expressDate, sport, type, JSON.stringify(data))
        return res.json({ success: true, date: expressDate, sport, type, ...data })
      }
      // Both types
      const [standard, high] = await Promise.all([
        generateSportExpress(sport, 'standard', expressDate),
        generateSportExpress(sport, 'high',     expressDate),
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
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
module.exports.generateExpressForDate = generateExpress
module.exports.generateSportExpressForCron = generateSportExpress
module.exports.getTomorrowDate = getTomorrowDate
module.exports.getTomorrowDate = getTomorrowDate
