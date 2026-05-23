const express = require('express')
const https = require('https')
const db = require('../db')
const { authenticate } = require('../middleware/auth')
const { translateTeam } = require('../teamNames')

const router = express.Router()
const EXPRESS_COST_STANDARD = 39
const EXPRESS_COST_HIGH = 49

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

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
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

  let events = []
  for (const fetchFn of [
    () => allSportsGetPathExpress(legacyPath),
    () => sofascoreGetExpress(sofaPath),
  ]) {
    try {
      const data = await fetchFn()
      const evts = data?.events || []
      if (evts.length > 0) { events = evts; break }
    } catch {}
  }

  const matches = []
  for (const ev of events) {
    const statusType = (ev.status?.type || '').toLowerCase()
    if (statusType === 'finished' || statusType === 'inprogress') continue
    // Filter to targetDate by startTimestamp (Unix seconds → UTC date)
    if (ev.startTimestamp) {
      const evDate = new Date(ev.startTimestamp * 1000).toISOString().slice(0, 10)
      if (evDate !== targetDate) continue
    }
    const home = translateHockeyTeamExpress(ev.homeTeam?.name || '')
    const away = translateHockeyTeamExpress(ev.awayTeam?.name || '')
    if (home && away) matches.push({ home, away, league: t.league })
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
function parseExpressJson(content, date) {
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Invalid JSON from OpenAI')
  let data
  try { data = JSON.parse(jsonMatch[0]) } catch { throw new Error('JSON parse failed') }
  if (!data.picks || !Array.isArray(data.picks) || data.picks.length < 1) throw new Error('No picks in response')
  data.date = data.date || date
  data.total_odds = Math.round(data.picks.reduce((acc, p) => acc * (parseFloat(p.odds) || 1), 1) * 100) / 100
  return data
}

function buildSportExpressPrompt(sport, type, matches, date, statsContext = null) {
  const isHigh = type === 'high'
  const isHockey = sport === 'hockey'
  const sportLabel = { hockey: 'хоккей' }[sport] || sport

  const oddsReq = isHigh
    ? `- Итоговый коэф ≥ 4.00, выбери 3-4 события
- Каждый коэф от 1.40 и выше`
    : `- Итоговый коэф 2.00–4.00, выбери 2-3 события
- Каждый коэф 1.30–2.20`

  // Build match blocks — show П1/П2 and team records where available
  const matchBlocks = matches.map((m, i) => {
    let block = `${i + 1}. ${m.home} — ${m.away} (${m.league})`
    if (isHockey && m.odds) {
      block += `\n  П1: ${m.odds.home} | П2: ${m.odds.away}`
    }
    if (m.homeRecord || m.awayRecord) {
      block += `\n  Статистика сезона — ${m.home}: ${m.homeRecord || 'н/д'} | ${m.away}: ${m.awayRecord || 'н/д'}`
    }
    return block
  }).join('\n\n')

  const oddsNote = isHockey
    ? `КОЭФФИЦИЕНТЫ:
- Где указаны П1/П2 — используй эти точные числа если выбираешь победу команды
- Для тоталов (ТБ/ТМ), фор и других рынков — оцени реалистично как у топ-букмекеров
- Не выдумывай П1/П2 если они указаны в списке выше`
    : `Коэффициенты оцени реалистично на основе силы команд, как у топ-букмекеров.`

  const predNote = isHockey
    ? `"prediction" — ОБЯЗАТЕЛЬНО выбирай разнообразные ставки, не только П1/П2:
  * Тотал: "ТБ 5.5" / "ТМ 5.5" (в хоккее типичный тотал 5.5 или 6.5)
  * Фора: "Фора (-1.5)" / "Фора (+1.5)"
  * Победа: "П1" / "П2"
  * Двойной шанс: "1X" / "X2"
  * Обе забьют: "ОО" (оба отличатся — оба забьют 2+ шайбы)
  Выбирай ТУ ставку где у тебя наибольшая уверенность, независимо от типа`
    : `"prediction" — конкретная ставка (Победа хозяев / П1 / ТБ 2.5 / Фора (-1.5) / 1X)`

  const statsBlock = statsContext
    ? `\nРЕАЛЬНАЯ СТАТИСТИКА (используй для обоснования ставок):\n${statsContext}\n`
    : ''

  return `Ты эксперт по ставкам на ${sportLabel}. Составь ${isHigh ? 'ВЫСОКОДОХОДНЫЙ' : 'НАДЁЖНЫЙ'} экспресс на основе реального расписания.

МАТЧИ НА ${date}:
${matchBlocks}
${statsBlock}
${oddsNote}

Требования:
${oddsReq}
- Выбирай ТОЛЬКО из матчей выше
- Все текстовые поля СТРОГО на русском языке
- ${predNote}
- В "reasoning" объясни ПОЧЕМУ выбрал именно эту ставку (форма команд, статистика, сила составов)
- Используй РЕАЛЬНУЮ статистику из блока выше (если есть) для обоснования, не выдумывай цифры

Ответь ТОЛЬКО валидным JSON без markdown:
{"date":"${date}","picks":[{"home":"...","away":"...","league":"...","prediction":"ТБ 5.5","odds":1.82,"reasoning":"Обоснование на русском 2-3 предложения"}],"total_odds":2.72,"summary":"Описание экспресса на русском"}`
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

  // ── Fetch real stats context in parallel ─────────────────────────────────
  const hasIIHF = matches.some(m => m.league?.includes('ИИХФ') || m.league?.includes('Чемпионат мира'))
  const hasNHL  = matches.some(m => m.league?.includes('НХЛ'))

  const iihfSeasonId = seasonIdCacheEx.get(3)?.seasonId || 81043

  const [iihfStandings, nhlStandingsMap] = await Promise.all([
    hasIIHF ? fetchIIHFGroupStandings(iihfSeasonId) : Promise.resolve(null),
    hasNHL  ? fetchNHLStandingsMap()                 : Promise.resolve(null),
  ])

  // Attach NHL record to each NHL match
  if (nhlStandingsMap) {
    matches = matches.map(m => {
      if (!m.league?.includes('НХЛ')) return m
      // Find NHL abbrev by Russian name lookup
      const findAbbrev = (ruName) =>
        Object.entries(NHL_TEAMS_RU).find(([, ru]) => ru === ruName)?.[0]
      const homeAbbr = findAbbrev(m.home)
      const awayAbbr = findAbbrev(m.away)
      return {
        ...m,
        homeRecord: homeAbbr ? nhlStandingsMap[homeAbbr] : null,
        awayRecord: awayAbbr ? nhlStandingsMap[awayAbbr] : null,
      }
    })
  }

  const statsContext = [iihfStandings].filter(Boolean).join('\n\n') || null

  const prompt = buildSportExpressPrompt(sport, type, matches.slice(0, 6), targetDate, statsContext)
  const content = await openAIRequest([
    { role: 'system', content: `Ты эксперт по ставкам на спорт. Отвечай только валидным JSON на русском языке.` },
    { role: 'user', content: prompt },
  ])
  return parseExpressJson(content, targetDate)
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

    const expressDate = getTomorrowDate()

    // ── Football: existing legacy tables ─────────────────────────────────────
    if (sport === 'football') {
      const getOrGenerate = async (table, purchaseTable) => {
        const type = table === 'daily_express' ? 'standard' : 'high'
        let row = db.prepare(`SELECT * FROM ${table} WHERE date = ?`).get(expressDate)
        if (!row) {
          await withMutex(`${table}_${expressDate}`, async () => {
            const existing = db.prepare(`SELECT * FROM ${table} WHERE date = ?`).get(expressDate)
            if (existing) { row = existing; return }
            try {
              const data = await generateExpress(expressDate, type)
              db.prepare(`INSERT OR IGNORE INTO ${table} (date, data) VALUES (?, ?)`).run(expressDate, JSON.stringify(data))
              row = db.prepare(`SELECT * FROM ${table} WHERE date = ?`).get(expressDate)
            } catch { return null }
          })
          if (!row) row = db.prepare(`SELECT * FROM ${table} WHERE date = ?`).get(expressDate)
        }
        let expressData
        try { expressData = JSON.parse(row.data) } catch { return null }
        const purchased = userId
          ? !!db.prepare(`SELECT 1 FROM ${purchaseTable} WHERE user_id = ? AND express_date = ?`).get(userId, expressDate)
          : false
        if (purchased) return { date: expressDate, purchased: true, ...expressData }
        return {
          date: expressDate, purchased: false,
          summary: expressData.summary, total_odds: expressData.total_odds,
          picks_count: expressData.picks.length,
          picks: expressData.picks.map(p => ({ home: p.home, away: p.away, league: p.league, prediction: null, odds: null })),
        }
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
  const expressDate = getTomorrowDate()
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

// ── POST /express/generate (admin) ───────────────────────────────────────────
router.post('/generate', authenticate, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Только для администраторов' })
  const expressDate = getTomorrowDate()
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
module.exports.getTomorrowDate = getTomorrowDate
