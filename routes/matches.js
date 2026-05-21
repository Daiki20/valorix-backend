const express = require('express')
const https = require('https')
const router = express.Router()

const SSTATS_BASE = 'https://api.sstats.net'

let upcomingCache = { data: null, ts: 0 }
let liveCache = { data: null, ts: 0 }
let hockeyCache = { data: null, ts: 0 }
let basketballCache = { data: null, ts: 0 }
let esportsCache = { data: null, ts: 0 }
const UPCOMING_TTL = 15 * 60 * 1000
const LIVE_TTL = 60 * 1000
const HOCKEY_TTL = 6 * 60 * 60 * 1000   // 6 hours — saves RapidAPI quota (100 req/day BASIC)
const BASKETBALL_TTL = 6 * 60 * 60 * 1000
const ESPORTS_TTL = 60 * 60 * 1000       // 1 hour

function sstatsGet(path, params = {}) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ ...params, apikey: process.env.SSTATS_API_KEY })
    const options = {
      hostname: 'api.sstats.net',
      path: `${path}?${q}`,
      method: 'GET',
      timeout: 8000,
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('JSON parse error')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

const LEAGUE_IDS = [
  2, 3, 848,
  39, 140, 135, 78, 61,
  94, 88, 144, 203, 179, 207, 197, 210,
  235, 236,
  71, 128, 131, 13,
  253, 262,
  98, 292, 480,
  169, 113, 119,
  40, 79, 62,
  106, 383, 218,
]

// GET /matches/upcoming — cached 15 min
router.get('/upcoming', async (req, res) => {
  if (upcomingCache.data && Date.now() - upcomingCache.ts < UPCOMING_TTL) {
    return res.json({ data: upcomingCache.data, cached: true })
  }

  if (!process.env.SSTATS_API_KEY) return res.json({ data: [] })

  try {
    const results = await Promise.allSettled(
      LEAGUE_IDS.map(id =>
        sstatsGet('/Games/list', { upcoming: true, leagueid: id, limit: 5 })
      )
    )
    const allGames = results.flatMap(r =>
      r.status === 'fulfilled' ? (r.value?.data || []) : []
    )
    upcomingCache = { data: allGames, ts: Date.now() }
    console.log(`[matches/upcoming] fetched ${allGames.length} games, cached for 15 min`)
    res.json({ data: allGames })
  } catch (err) {
    console.error('[matches/upcoming]', err.message)
    res.status(500).json({ error: 'Failed to fetch matches' })
  }
})

// GET /matches/live — cached 1 min
router.get('/live', async (req, res) => {
  if (liveCache.data && Date.now() - liveCache.ts < LIVE_TTL) {
    return res.json({ data: liveCache.data, cached: true })
  }

  if (!process.env.SSTATS_API_KEY) return res.json({ data: [] })

  try {
    const result = await sstatsGet('/Games/list', { live: true, limit: 20 })
    const data = result?.data || []
    liveCache = { data, ts: Date.now() }
    res.json({ data })
  } catch (err) {
    console.error('[matches/live]', err.message)
    res.json({ data: [] })
  }
})

// ── AllSportsApi helper (direct path) ────────────────────────────────────────
// Uses Sofascore-mirrored tournament endpoints. Format:
//   /api/tournament/{id}/season/{sid}/matches/next/0
function allSportsGetPath(path) {
  const key = process.env.RAPIDAPI_KEY
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
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('JSON parse error')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

// Keep legacy helper for basketball (uses old endpoint format)
function allSportsGet(sport, endpoint) {
  return allSportsGetPath(`/api/${sport}/${endpoint}`)
}

// ── Hockey tournament config ──────────────────────────────────────────────────
// IDs match Sofascore / AllSportsApi.  Season IDs valid for 2025-26 season.
// Update seasonId each September when the new season starts.
const HOCKEY_TOURNAMENTS = [
  { id: 3,    seasonId: 81043, league: 'IIHF · Чемпионат мира' },
  { id: 234,  seasonId: 78476, league: 'НХЛ' },
  { id: 268,  seasonId: 77998, league: 'КХЛ' },
  { id: 1159, seasonId: 79945, league: 'МХЛ' },
  { id: 1141, seasonId: 78633, league: 'ВХЛ' },
]

// ── NHL free API helper ───────────────────────────────────────────────────────
function httpsGetJson(hostname, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      method: 'GET',
      timeout: 8000,
      headers: { 'User-Agent': 'valorix-app/1.0', 'Accept': 'application/json' },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('JSON parse error')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

function formatHockeyDate(dateStr) {
  if (!dateStr) return ''
  try {
    const d = new Date(dateStr)
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' }) +
      ' · ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })
  } catch { return dateStr }
}

// Known KHL team names ru translation
const KHL_TEAMS_RU = {
  'CSKA': 'ЦСКА', 'SKA': 'СКА', 'Ak Bars': 'Ак Барс', 'Avangard': 'Авангард',
  'Metallurg Magnitogorsk': 'Металлург Мг', 'Lokomotiv': 'Локомотив',
  'Dinamo Moscow': 'Динамо Москва', 'Dynamo Moscow': 'Динамо Москва',
  'Spartak': 'Спартак', 'Torpedo': 'Торпедо', 'Traktor': 'Трактор',
  'Salavat Yulaev': 'Салават Юлаев', 'Neftekhimik': 'Нефтехимик',
  'Severstal': 'Северсталь', 'Amur': 'Амур', 'Sibir': 'Сибирь',
  'Yugra': 'Югра', 'Kunlun': 'Куньлунь', 'Barys': 'Барыс',
  'Dinamo Riga': 'Динамо Рига', 'Dinamo Minsk': 'Динамо Минск',
  'Admiral': 'Адмирал', 'Lada': 'Лада', 'HC Sochi': 'ХК Сочи',
  'Vityaz': 'Витязь', 'Metallurg Novokuznetsk': 'Металлург Нк',
}
function translateKHL(name) {
  for (const [en, ru] of Object.entries(KHL_TEAMS_RU)) {
    if (name.includes(en)) return ru
  }
  return name
}

// NHL team names (English → readable)
const NHL_TEAMS = {
  'ANA': 'Анахайм Дакс', 'ARI': 'Аризона Койотис', 'UTH': 'Юта Хоккей Клаб',
  'BOS': 'Бостон Брюинс', 'BUF': 'Баффало Сэйбрс', 'CGY': 'Калгари Флэймс',
  'CAR': 'Каролина Харрикейнс', 'CHI': 'Чикаго Блэкхокс', 'COL': 'Колорадо Эвэланш',
  'CBJ': 'Коламбус Блю Джекетс', 'DAL': 'Даллас Старс', 'DET': 'Детройт Ред Уингс',
  'EDM': 'Эдмонтон Ойлерс', 'FLA': 'Флорида Пантерс', 'LAK': 'Лос-Анджелес Кингс',
  'MIN': 'Миннесота Уайлд', 'MTL': 'Монреаль Канадьенс', 'NSH': 'Нэшвилл Предаторс',
  'NJD': 'Нью-Джерси Девилс', 'NYI': 'Нью-Йорк Айлендерс', 'NYR': 'Нью-Йорк Рейнджерс',
  'OTT': 'Оттава Сенаторс', 'PHI': 'Филадельфия Флайерс', 'PIT': 'Питтсбург Пингвинс',
  'SJS': 'Сан-Хосе Шаркс', 'SEA': 'Сиэтл Кракен', 'STL': 'Сент-Луис Блюз',
  'TBL': 'Тампа-Бэй Лайтнинг', 'TOR': 'Торонто Мэйпл Лифс', 'VAN': 'Ванкувер Кэнакс',
  'VGK': 'Вегас Голден Найтс', 'WSH': 'Вашингтон Кэпиталс', 'WPG': 'Виннипег Джетс',
}

// Normalize AllSportsApi match to our format
function normalizeAllSportsMatch(m, sport, leagueName) {
  const home = m.event_home_team || m.homeTeam?.name || ''
  const away = m.event_away_team || m.awayTeam?.name || ''
  if (!home || !away) return null

  const dateRaw = m.event_date || m.event_date_start || ''
  const timeRaw = m.event_time || ''
  const rawDate = dateRaw + (timeRaw ? `T${timeRaw}:00` : '')

  const isLive = m.event_status === 'inprogress' || m.event_live === '1'
  const score = isLive && m.event_home_final_result != null
    ? `${m.event_home_final_result}:${m.event_away_final_result}`
    : null

  return {
    id: `as_${sport}_${m.event_key || Math.random()}`,
    home: sport === 'hockey' ? translateKHL(home) : home,
    away: sport === 'hockey' ? translateKHL(away) : away,
    league: m.league_name || leagueName || sport,
    sport,
    date: formatHockeyDate(rawDate || dateRaw),
    rawDate: rawDate || dateRaw || new Date().toISOString(),
    isLive,
    score,
  }
}

// Normalize Sofascore-style event (returned by /matches/next endpoint)
// tournamentId/seasonId passed through so frontend can fetch stats
function normalizeSofascoreMatch(event, leagueName, tournamentId, seasonId) {
  const home = event.homeTeam?.name || ''
  const away = event.awayTeam?.name || ''
  if (!home || !away) return null

  const ts = event.startTimestamp
  const rawDate = ts ? new Date(ts * 1000).toISOString() : null

  const statusType = (event.status?.type || '').toLowerCase()
  const isFinished = statusType === 'finished'
  if (isFinished) return null

  const isLive = statusType === 'inprogress'
  let score = null
  if (isLive) {
    const hs = event.homeScore?.current ?? event.homeScore?.normaltime ?? 0
    const as_ = event.awayScore?.current ?? event.awayScore?.normaltime ?? 0
    score = `${hs}:${as_}`
  }

  return {
    id: `as_${event.id || Math.random()}`,
    eventId: event.id,
    homeTeamId: event.homeTeam?.id,
    awayTeamId: event.awayTeam?.id,
    tournamentId,
    seasonId,
    home: translateKHL(home),
    away: translateKHL(away),
    league: leagueName,
    sport: 'hockey',
    date: rawDate ? formatHockeyDate(rawDate) : '',
    rawDate: rawDate || new Date().toISOString(),
    isLive,
    score,
  }
}

// Leagues to show (filter by name from AllSportsApi response)
const HOCKEY_LEAGUE_FILTER = [
  'khl', 'кхл', 'kontinental',
  'nhl', 'нхл', 'national hockey',
  'vhl', 'вхл',
  'mhl', 'юхл', 'молодёж', 'junior',
  'world championship', 'чемпионат мира', 'iihf', 'mundial',
  'shl', 'liiga', 'del ', 'nla', 'ahl',
  'playoffs', 'плей-офф', 'финал', 'final',
]
function isImportantHockeyLeague(leagueName) {
  if (!leagueName) return false
  const l = leagueName.toLowerCase()
  return HOCKEY_LEAGUE_FILTER.some(f => l.includes(f))
}

// Format date as DD/MM/YYYY for AllSportsApi
function toAllSportsDate(isoDate) {
  const [y, m, d] = isoDate.split('-')
  return `${d}/${m}/${y}`
}

router.get('/hockey', async (req, res) => {
  if (hockeyCache.data && Date.now() - hockeyCache.ts < HOCKEY_TTL) {
    return res.json({ data: hockeyCache.data, cached: true })
  }

  const games = []
  let nhlCount = 0

  // 1. NHL Official Free API (no key needed, always available)
  // Use explicit date — /v1/schedule/now returns 307 redirect which Node doesn't follow
  try {
    const todayDate = new Date().toISOString().slice(0, 10)
    const nhlData = await httpsGetJson('api-web.nhle.com', `/v1/schedule/${todayDate}`)
    const gameWeek = nhlData.gameWeek || []
    for (const day of gameWeek) {
      for (const game of (day.games || [])) {
        const state = game.gameState
        if (state === 'OFF' || state === 'FINAL') continue
        const homeAbbr = game.homeTeam?.abbrev || ''
        const awayAbbr = game.awayTeam?.abbrev || ''
        const home = NHL_TEAMS[homeAbbr] ||
          `${game.homeTeam?.placeName?.default || ''} ${game.homeTeam?.commonName?.default || ''}`.trim()
        const away = NHL_TEAMS[awayAbbr] ||
          `${game.awayTeam?.placeName?.default || ''} ${game.awayTeam?.commonName?.default || ''}`.trim()
        const isLive = state === 'LIVE' || state === 'CRIT'
        games.push({
          id: `nhl_${game.id}`,
          home, away,
          league: 'НХЛ · Плей-офф',
          sport: 'hockey',
          date: formatHockeyDate(game.startTimeUTC),
          rawDate: game.startTimeUTC,
          isLive,
          score: isLive ? `${game.homeTeam?.score ?? 0}:${game.awayTeam?.score ?? 0}` : null,
        })
        nhlCount++
      }
    }
    console.log(`[matches/hockey] NHL free API: ${nhlCount} games`)
  } catch (err) {
    console.error('[matches/hockey] NHL error:', err.message)
  }

  // 2. AllSportsApi — tournament-based matches (KHL, IIHF, MHL, VHL, NHL backup)
  if (process.env.RAPIDAPI_KEY) {
    // Skip NHL from AllSportsApi if free NHL API already returned games (avoid duplicates)
    const tournamentsToFetch = nhlCount > 0
      ? HOCKEY_TOURNAMENTS.filter(t => t.id !== 234)
      : HOCKEY_TOURNAMENTS

    const results = await Promise.allSettled(
      tournamentsToFetch.map(t =>
        allSportsGetPath(`/api/tournament/${t.id}/season/${t.seasonId}/matches/next/0`)
          .then(data => {
            const evts = data?.events || []
            console.log(`[matches/hockey] T=${t.id} "${t.league}": ${evts.length} events, hasErr=${!!data?.message}`)
            return { ...t, events: evts }
          })
      )
    )

    for (const r of results) {
      if (r.status !== 'fulfilled') {
        console.error('[matches/hockey] AllSportsApi rejected:', r.reason?.message)
        continue
      }
      // NOTE: use r.value (not outer t) — t is out of scope here
      const { id: tournamentId, seasonId, league, events } = r.value
      let added = 0
      for (const event of events) {
        const normalized = normalizeSofascoreMatch(event, league, tournamentId, seasonId)
        if (!normalized) continue
        // Dedup with NHL free API results (same team names)
        if (games.some(g => g.home === normalized.home && g.away === normalized.away)) continue
        games.push(normalized)
        added++
      }
      if (added > 0 || events.length > 0) {
        console.log(`[matches/hockey] ${league}: ${added}/${events.length} added`)
      }
    }
    console.log(`[matches/hockey] AllSportsApi total: ${games.length} games`)
  } else {
    console.log('[matches/hockey] RAPIDAPI_KEY not set — only NHL free API available')
  }

  games.sort((a, b) => {
    if (a.isLive && !b.isLive) return -1
    if (!a.isLive && b.isLive) return 1
    return new Date(a.rawDate || 0) - new Date(b.rawDate || 0)
  })

  if (games.length > 0) {
    // Full cache: 2 hours
    hockeyCache = { data: games, ts: Date.now() }
    console.log(`[matches/hockey] cached ${games.length} total games for 2 hrs`)
  } else {
    // Empty result (API quota exceeded or no games today) — cache for 30 min
    // to avoid hammering the API and burning daily quota
    hockeyCache = { data: [], ts: Date.now() - (HOCKEY_TTL - 30 * 60 * 1000) }
    console.log('[matches/hockey] WARNING: 0 games — caching empty for 30 min to protect quota')
  }
  res.json({ data: games })
})

// ── GET /matches/hockey-stats ─────────────────────────────────────────────────
// Returns real form + standings for a hockey match (called at analysis time)
const hockeyStatsCache = new Map()   // key: `${homeId}_${awayId}` → { data, ts }
const HOCKEY_STATS_TTL = 10 * 60 * 1000  // 10 min

router.get('/hockey-stats', async (req, res) => {
  const { homeId, awayId, tournamentId, seasonId } = req.query
  if (!homeId || !awayId) return res.status(400).json({ error: 'homeId and awayId required' })
  if (!process.env.RAPIDAPI_KEY) return res.json({ homeForm: [], awayForm: [], standings: [] })

  const cacheKey = `${homeId}_${awayId}_${tournamentId}`
  const cached = hockeyStatsCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < HOCKEY_STATS_TTL) {
    return res.json(cached.data)
  }

  const fetches = [
    allSportsGetPath(`/api/team/${homeId}/matches/previous/0`).catch(() => null),
    allSportsGetPath(`/api/team/${awayId}/matches/previous/0`).catch(() => null),
  ]
  if (tournamentId && seasonId) {
    fetches.push(
      allSportsGetPath(`/api/tournament/${tournamentId}/season/${seasonId}/standings/total`).catch(() => null)
    )
  }

  const [homeRes, awayRes, standingsRes] = await Promise.all(fetches)

  const data = {
    homeForm: homeRes?.events || [],
    awayForm: awayRes?.events || [],
    standings: standingsRes?.standings || [],
  }

  hockeyStatsCache.set(cacheKey, { data, ts: Date.now() })
  console.log(`[matches/hockey-stats] home=${homeId} away=${awayId}: ` +
    `${data.homeForm.length}/${data.awayForm.length} form events, ${data.standings.length} standing groups`)
  res.json(data)
})

// ── GET /matches/basketball ───────────────────────────────────────────────────
const BASKETBALL_LEAGUE_FILTER = [
  'nba', 'нба', 'euroleague', 'евролига', 'eurocup',
  'vtb', 'втб', 'united league',
  'acb', 'bsl', 'lnb', 'bbl', 'bnl',
  'playoffs', 'плей-офф', 'finals', 'финал',
  'nbl', 'ncaa', 'fiba',
]
function isImportantBasketballLeague(name) {
  if (!name) return false
  const l = name.toLowerCase()
  return BASKETBALL_LEAGUE_FILTER.some(f => l.includes(f))
}

router.get('/basketball', async (req, res) => {
  if (basketballCache.data && Date.now() - basketballCache.ts < BASKETBALL_TTL) {
    return res.json({ data: basketballCache.data, cached: true })
  }

  if (!process.env.RAPIDAPI_KEY) return res.json({ data: [] })

  const today = new Date().toISOString().slice(0, 10)
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const games = []

  const [todayRes, tomorrowRes] = await Promise.allSettled([
    allSportsGet('basketball', `matches/${toAllSportsDate(today)}`),
    allSportsGet('basketball', `matches/${toAllSportsDate(tomorrow)}`),
  ])

  for (const r of [todayRes, tomorrowRes]) {
    if (r.status !== 'fulfilled') continue
    const matches = r.value?.result || r.value?.data || r.value?.events || r.value?.matches || []
    for (const m of (Array.isArray(matches) ? matches : [])) {
      const leagueName = m.league_name || m.event_competition || ''
      if (!isImportantBasketballLeague(leagueName)) continue
      const normalized = normalizeAllSportsMatch(m, 'basketball', leagueName)
      if (normalized && !games.find(g => g.home === normalized.home && g.away === normalized.away)) {
        games.push(normalized)
      }
    }
  }

  games.sort((a, b) => {
    if (a.isLive && !b.isLive) return -1
    if (!a.isLive && b.isLive) return 1
    return new Date(a.rawDate || 0) - new Date(b.rawDate || 0)
  })

  basketballCache = { data: games, ts: Date.now() }
  console.log(`[matches/basketball] cached ${games.length} games for 15 min`)
  res.json({ data: games })
})

// ── Esports — PandaScore (pandascore.co) ─────────────────────────────────────
// Free tier: 1000 req/hour. Token from pandascore.co (free registration).
// Add PANDASCORE_TOKEN to Railway Variables to enable the match list.
function pandascoreGet(path, params = {}) {
  const token = process.env.PANDASCORE_TOKEN
  if (!token) return Promise.reject(new Error('No PANDASCORE_TOKEN'))
  const qs = new URLSearchParams(params).toString()
  const fullPath = qs ? `${path}?${qs}` : path
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.pandascore.co',
      path: fullPath,
      method: 'GET',
      timeout: 10000,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`[pandascore] ${path} → HTTP ${res.statusCode}: ${data.slice(0, 200)}`)
          reject(new Error(`pandascore HTTP ${res.statusCode}`))
          return
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

// PandaScore videogame slug → frontend game key
const PS_GAME_MAP = {
  'cs-go': 'cs2', 'csgo': 'cs2',
  'dota-2': 'dota2', 'dota2': 'dota2',
  'valorant': 'valorant',
  'league-of-legends': 'lol', 'lol': 'lol',
}
const PS_TARGET_GAMES = new Set(['cs2', 'dota2', 'valorant', 'lol'])

// game key → display name
const ESPORTS_GAME_DISPLAY = { cs2: 'CS2', dota2: 'Dota 2', valorant: 'Valorant', lol: 'LoL' }

// Normalize PandaScore match object to our format
function normalizeEsportsMatch(m) {
  const opp1 = m.opponents?.[0]?.opponent
  const opp2 = m.opponents?.[1]?.opponent
  const team1 = opp1?.name || ''
  const team2 = opp2?.name || ''
  if (!team1 || !team2) return null

  const gameSlug = m.videogame?.slug || ''
  const gameFrontend = PS_GAME_MAP[gameSlug] || gameSlug
  if (!PS_TARGET_GAMES.has(gameFrontend)) return null

  const gameDisplay = ESPORTS_GAME_DISPLAY[gameFrontend] || gameFrontend.toUpperCase()
  const tournamentName = m.serie?.full_name || m.tournament?.name || m.league?.name || ''

  const isLive = m.status === 'running'
  let score = null
  if (isLive && m.results?.length >= 2) {
    score = `${m.results[0]?.score ?? 0}:${m.results[1]?.score ?? 0}`
  }

  // Team logos from PandaScore CDN
  const homeImg = opp1?.image_url || null
  const awayImg = opp2?.image_url || null

  // Odds — PandaScore returns winner odds in some match objects
  // Format: m.winner_odds = [{winner: {name}, value: 1.45}, ...]
  let odds1x2 = null
  const wonOdds = m.winner_odds || m.odds || null
  if (Array.isArray(wonOdds) && wonOdds.length >= 2) {
    const o1 = wonOdds.find(o => o.winner?.name === team1 || o.team?.name === team1)
    const o2 = wonOdds.find(o => o.winner?.name === team2 || o.team?.name === team2)
    if (o1?.value && o2?.value) {
      odds1x2 = { home: o1.value, away: o2.value, draw: null }
    }
  }

  return {
    id: `ps_${m.id}`,
    home: team1,
    away: team2,
    homeImg,
    awayImg,
    league: tournamentName ? `${gameDisplay} · ${tournamentName}` : gameDisplay,
    game: gameFrontend,
    sport: 'esports',
    date: m.scheduled_at ? formatHockeyDate(m.scheduled_at) : '',
    rawDate: m.scheduled_at || new Date().toISOString(),
    isLive,
    score,
    odds1x2,
  }
}

// GET /matches/esports — PandaScore, cached 1 hour
router.get('/esports', async (req, res) => {
  if (esportsCache.data && Date.now() - esportsCache.ts < ESPORTS_TTL) {
    return res.json({ data: esportsCache.data, cached: true })
  }

  if (!process.env.PANDASCORE_TOKEN) {
    console.log('[matches/esports] PANDASCORE_TOKEN not set — skipping')
    return res.json({ data: [], hint: 'Set PANDASCORE_TOKEN in Railway Variables (free at pandascore.co)' })
  }

  const games = []

  try {
    // Fetch running (live) + upcoming matches in parallel
    // Also fetch odds in parallel with the match lists
    const [runningRes, upcomingRes] = await Promise.allSettled([
      pandascoreGet('/matches/running', {
        'page[size]': 30,
        sort: 'begin_at',
      }),
      pandascoreGet('/matches/upcoming', {
        'page[size]': 100,
        sort: 'begin_at',
      }),
    ])

    const running  = (runningRes.status  === 'fulfilled' && Array.isArray(runningRes.value))  ? runningRes.value  : []
    const upcoming = (upcomingRes.status === 'fulfilled' && Array.isArray(upcomingRes.value)) ? upcomingRes.value : []
    console.log(`[matches/esports] PandaScore: ${running.length} running + ${upcoming.length} upcoming`)

    // Fetch odds for upcoming matches (paginated, same page size)
    // PandaScore odds endpoint: /matches/{id}/odds  — but free tier may not have it.
    // Try batch odds endpoint instead: included in match detail when available.
    // We rely on winner_odds embedded in match objects (returned by some plan levels).
    // Separate odds fetch attempt for the first 20 upcoming matches:
    const upcomingIds = upcoming.slice(0, 20).map(m => m.id).join(',')
    if (upcomingIds) {
      try {
        const oddsData = await pandascoreGet('/matches/upcoming', {
          'filter[id]': upcomingIds,
          'page[size]': 20,
          with_odds: true,
        })
        if (Array.isArray(oddsData)) {
          for (const om of oddsData) {
            const idx = upcoming.findIndex(m => m.id === om.id)
            if (idx >= 0 && (om.winner_odds || om.odds)) {
              upcoming[idx] = { ...upcoming[idx], winner_odds: om.winner_odds, odds: om.odds }
            }
          }
        }
      } catch { /* odds are optional */ }
    }

    for (const m of [...running, ...upcoming]) {
      const normalized = normalizeEsportsMatch(m)
      if (!normalized) continue
      if (games.some(g => g.home === normalized.home && g.away === normalized.away)) continue
      games.push(normalized)
    }
  } catch (err) {
    console.error('[matches/esports] PandaScore error:', err.message)
  }

  games.sort((a, b) => {
    if (a.isLive && !b.isLive) return -1
    if (!a.isLive && b.isLive) return 1
    return new Date(a.rawDate || 0) - new Date(b.rawDate || 0)
  })

  console.log(`[matches/esports] total ${games.length} matches (${games.filter(g => g.isLive).length} live)`)

  if (games.length > 0) {
    esportsCache = { data: games, ts: Date.now() }
  } else {
    esportsCache = { data: [], ts: Date.now() - (ESPORTS_TTL - 15 * 60 * 1000) }
  }

  res.json({ data: games })
})

// GET /matches/esports-debug — test PandaScore connection
router.get('/esports-debug', async (req, res) => {
  if (!process.env.PANDASCORE_TOKEN) return res.json({ error: 'PANDASCORE_TOKEN not set' })
  try {
    const data = await pandascoreGet('/matches/upcoming', { 'page[size]': 3, sort: 'begin_at' })
    const matches = Array.isArray(data) ? data : []
    res.json({
      ok: true,
      count: matches.length,
      sample: matches.slice(0, 2).map(m => ({
        id: m.id,
        name: m.name,
        status: m.status,
        scheduled_at: m.scheduled_at,
        game: m.videogame?.slug,
        opp1: m.opponents?.[0]?.opponent?.name,
        opp2: m.opponents?.[1]?.opponent?.name,
      }))
    })
  } catch (e) {
    res.json({ error: e.message })
  }
})

module.exports = router
