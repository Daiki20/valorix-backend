const express = require('express')
const router = express.Router()
const https = require('https')
const { authenticate } = require('../middleware/auth')
const db = require('../db')

const CACHE_TTL        = 3  * 60 * 60 * 1000  // 3 hours  — regular analysis cache
const SEARCH_CACHE_TTL = 12 * 60 * 60 * 1000  // 12 hours — web search pre-match cache
const TEAM_FORM_TTL  = 6 * 60 * 60 * 1000 // 6 hours — team form/h2h cache

function cacheGet(key, ttl = CACHE_TTL) {
  try {
    const row = db.prepare('SELECT content, created_at FROM analysis_cache WHERE cache_key = ?').get(key)
    if (!row) return null
    if (Date.now() - row.created_at > ttl) {
      db.prepare('DELETE FROM analysis_cache WHERE cache_key = ?').run(key)
      return null
    }
    return row.content
  } catch { return null }
}

function cacheSet(key, val) {
  try {
    db.prepare('INSERT OR REPLACE INTO analysis_cache (cache_key, content, created_at) VALUES (?, ?, ?)').run(key, val, Date.now())
    // Cleanup old entries (keep max 1000)
    db.prepare('DELETE FROM analysis_cache WHERE cache_key NOT IN (SELECT cache_key FROM analysis_cache ORDER BY created_at DESC LIMIT 1000)').run()
  } catch {}
}

const RAPIDAPI_HOST = 'free-api-live-football-data.p.rapidapi.com'

// gpt-4o-search-preview — поиск в интернете перед ответом
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
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`OpenAI search ${res.statusCode}: ${data}`)); return }
        try {
          const parsed = JSON.parse(data)
          const content = parsed?.choices?.[0]?.message?.content
          if (!content) throw new Error('Empty response')
          resolve(content)
        } catch { reject(new Error('OpenAI search parse error')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenAI search timeout')) })
    req.write(payload)
    req.end()
  })
}

function callOpenAI(messages, max_tokens = 1500) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'gpt-4o',
      messages,
      max_tokens,
      response_format: { type: 'json_object' },
    })
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`OpenAI ${res.statusCode}: ${data}`)); return }
        try {
          const parsed = JSON.parse(data)
          const content = parsed?.choices?.[0]?.message?.content
          if (!content) throw new Error('Empty response')
          resolve(content)
        } catch { reject(new Error('OpenAI parse error')) }
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

function rapidGet(path, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString()
    const fullPath = qs ? `${path}?${qs}` : path
    const options = {
      hostname: RAPIDAPI_HOST,
      path: fullPath,
      method: 'GET',
      headers: {
        'x-rapidapi-host': RAPIDAPI_HOST,
        'x-rapidapi-key': process.env.RAPIDAPI_KEY,
      },
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { reject(new Error('parse error')) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-zа-яё0-9]/gi, '')
}

// ── API-Football (RapidAPI) ──────────────────────────────────────────────────
const APIFOOTBALL_HOST = 'api-football-v1.p.rapidapi.com'
function apiFootballGet(path, params = {}) {
  const key = process.env.RAPIDAPI_KEY
  if (!key) return Promise.reject(new Error('No RAPIDAPI_KEY'))
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString()
    const options = {
      hostname: APIFOOTBALL_HOST,
      path: qs ? `${path}?${qs}` : path,
      method: 'GET',
      timeout: 8000,
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': APIFOOTBALL_HOST,
        'Accept': 'application/json',
      },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch { reject(new Error('parse')) } })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

// ── TheSportsDB (free, no key needed) ────────────────────────────────────────
function theSportsDBGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.thesportsdb.com',
      path: `/api/v1/json/3/${path}`,
      method: 'GET',
      timeout: 8000,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch { reject(new Error('parse')) } })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

// sstats league IDs → API-Football league IDs (mostly 1:1)
const LEAGUE_TO_APIFOOTBALL = {
  2: 2, 3: 3, 848: 848,           // UCL / UEL / UECL
  39: 39, 140: 140, 135: 135,     // PL / La Liga / Serie A
  78: 78, 61: 61, 94: 94,         // Bundesliga / Ligue 1 / Portugal
  88: 88, 144: 144, 203: 203,     // Netherlands / Belgium / Turkey
  235: 235, 40: 40, 79: 79,       // РПЛ / Championship / Bundesliga 2
  197: 197, 210: 210, 179: 179,   // Greece / Ukraine / Scotland
}

function fuzzyMatch(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  if (a.includes(b) || b.includes(a)) return true
  if (Math.abs(a.length - b.length) > 5) return false
  let diff = 0
  const shorter = a.length < b.length ? a : b
  const longer = a.length < b.length ? b : a
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] !== longer[i]) diff++
  }
  return diff <= 3
}

function dateStr(offsetDays = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return d.toISOString().split('T')[0].replace(/-/g, '')
}

// ── Football (free-api-live-football-data) ──────────────────────────────────

async function findEvent(home, away) {
  const homeNorm = normalize(home)
  const awayNorm = normalize(away)
  for (let i = 0; i <= 3; i++) {
    try {
      const res = await rapidGet('/football-get-matches-by-date', { date: dateStr(i) })
      const matches = res?.response || []
      const found = matches.find(m => {
        const h = normalize(m.homeTeam?.name || m.home?.name || m.homeName || '')
        const a = normalize(m.awayTeam?.name || m.away?.name || m.awayName || '')
        return fuzzyMatch(h, homeNorm) && fuzzyMatch(a, awayNorm)
      })
      if (found) return found
    } catch { continue }
  }
  return null
}

async function fetchHomeLineup(eventId) {
  const res = await rapidGet('/football-get-hometeam-lineup', { eventId })
  const players = res?.response || []
  return players
    .filter(p => p.lineup === true || p.isStarting === true || p.starting === true)
    .map(p => p.name || p.playerName)
    .filter(Boolean)
}

async function fetchAwayLineup(eventId) {
  const res = await rapidGet('/football-get-awayteam-lineup', { eventId })
  const players = res?.response || []
  return players
    .filter(p => p.lineup === true || p.isStarting === true || p.starting === true)
    .map(p => p.name || p.playerName)
    .filter(Boolean)
}

async function fetchStandings(leagueId) {
  const res = await rapidGet('/football-get-standing-all', { leagueId })
  return res?.response || []
}

function extractTeamStanding(standings, teamName) {
  const norm = normalize(teamName)
  return standings.find(s => fuzzyMatch(normalize(s.team?.name || s.teamName || ''), norm)) || null
}

// ── Routes ───────────────────────────────────────────────────────────────────

router.post('/context', authenticate, async (req, res) => {
  const { home, away, leagueId } = req.body
  if (!home || !away) return res.status(400).json({ error: 'home and away required' })
  if (!process.env.RAPIDAPI_KEY) return res.json({})

  const result = {
    homeLineup: [],
    awayLineup: [],
    homeStanding: null,
    awayStanding: null,
    formation: { home: null, away: null },
  }

  try {
    const event = await findEvent(home, away).catch(() => null)
    if (event) {
      const eventId = event.id || event.eventId || event.matchId
      const eventLeagueId = event.leagueId || event.league?.id || leagueId
      const [homeLineup, awayLineup, standings] = await Promise.all([
        eventId ? fetchHomeLineup(eventId).catch(() => []) : [],
        eventId ? fetchAwayLineup(eventId).catch(() => []) : [],
        eventLeagueId ? fetchStandings(eventLeagueId).catch(() => []) : [],
      ])
      result.homeLineup = homeLineup
      result.awayLineup = awayLineup
      result.formation.home = event.homeFormation || event.home?.formation || null
      result.formation.away = event.awayFormation || event.away?.formation || null
      if (standings.length) {
        result.homeStanding = extractTeamStanding(standings, home)
        result.awayStanding = extractTeamStanding(standings, away)
      }
    }
    res.json(result)
  } catch (err) {
    console.error('Context error:', err.message)
    res.json(result)
  }
})

router.post('/chat', authenticate, async (req, res) => {
  const { messages, max_tokens = 1200, cacheKey } = req.body
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages required' })
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'OpenAI API key not configured' })

  if (cacheKey) {
    const cached = cacheGet(cacheKey)
    if (cached) return res.json({ content: cached })
  }

  try {
    const content = await callOpenAI(messages, max_tokens)
    if (cacheKey) cacheSet(cacheKey, content)
    res.json({ content })
  } catch (err) {
    console.error('OpenAI error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── AllSports basketball fallback (uses existing RAPIDAPI_KEY) ───────────────

const ALLSPORTS_BASKETBALL_HOST = 'allsportsapi2.p.rapidapi.com'
const NBA_LEAGUE_ID = 766

function allSportsBasketGet(queryString) {
  return new Promise((resolve, reject) => {
    const key = process.env.RAPIDAPI_KEY
    if (!key) { resolve({ result: [] }); return }
    const options = {
      hostname: ALLSPORTS_BASKETBALL_HOST,
      path: `/api/basketball/?${queryString}`,
      method: 'GET',
      timeout: 8000,
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': ALLSPORTS_BASKETBALL_HOST,
        'Accept': 'application/json',
      },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('allsports-basketball parse error')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('allsports-basketball timeout')) })
    req.end()
  })
}

// Parse "120 - 115" → { home: 120, away: 115 }
function parseAllSportsScore(str) {
  if (!str) return null
  const parts = (str + '').split('-').map(s => parseInt(s.trim()))
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) return { home: parts[0], away: parts[1] }
  return null
}

function computeBasketballFormAllSports(fixtures, teamKey, venue) {
  const filtered = (fixtures || [])
    .filter(f => f.event_status === 'Finished' || f.event_final_result)
    .filter(f => {
      if (venue === 'home') return String(f.home_team_key) === String(teamKey)
      if (venue === 'away') return String(f.away_team_key) === String(teamKey)
      return String(f.home_team_key) === String(teamKey) || String(f.away_team_key) === String(teamKey)
    })
    .slice(0, 10)

  if (!filtered.length) return null
  let wins = 0, losses = 0, ptsFor = 0, ptsAgainst = 0
  for (const f of filtered) {
    const score = parseAllSportsScore(f.event_final_result)
    if (!score) continue
    const isHome = String(f.home_team_key) === String(teamKey)
    const tp = isHome ? score.home : score.away
    const op = isHome ? score.away : score.home
    ptsFor += tp; ptsAgainst += op
    tp > op ? wins++ : losses++
  }
  const count = filtered.length
  return { gamesCount: count, wins, losses, avgPts: +(ptsFor/count).toFixed(1), avgPtsAllowed: +(ptsAgainst/count).toFixed(1) }
}

async function getBasketballFormFromAllSports(homeTeam, awayTeam) {
  if (!process.env.RAPIDAPI_KEY) return null
  try {
    // Step 1: get all NBA teams (cached)
    const teamsCacheKey = `allsports_nba_teams`
    let teams = null
    const cached = cacheGet(teamsCacheKey, 24 * 60 * 60 * 1000) // 24h
    if (cached) {
      teams = JSON.parse(cached)
    } else {
      const res = await allSportsBasketGet(`met=Teams&leagueId=${NBA_LEAGUE_ID}`)
      teams = res?.result || []
      if (teams.length) cacheSet(teamsCacheKey, JSON.stringify(teams))
    }
    if (!teams.length) return null

    // Step 2: fuzzy match team names
    const normTeam = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const findTeam = (query) => {
      const q = normTeam(query)
      return teams.find(t => {
        const n = normTeam(t.team_name)
        return n === q || n.includes(q) || q.includes(n)
      }) || null
    }
    const homeData = findTeam(homeTeam)
    const awayData = findTeam(awayTeam)
    if (!homeData || !awayData) return null

    const homeKey = homeData.team_key, awayKey = awayData.team_key
    const today = new Date().toISOString().slice(0, 10)
    const past45 = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    // Step 3: fetch fixtures for both teams
    const [homeRes, awayRes] = await Promise.all([
      allSportsBasketGet(`met=Fixtures&teamId=${homeKey}&from=${past45}&to=${today}`),
      allSportsBasketGet(`met=Fixtures&teamId=${awayKey}&from=${past45}&to=${today}`),
    ])
    const homeFixtures = homeRes?.result || []
    const awayFixtures = awayRes?.result || []

    // Step 4: H2H from home team fixtures
    const h2hRaw = homeFixtures.filter(f =>
      String(f.home_team_key) === String(awayKey) || String(f.away_team_key) === String(awayKey)
    ).filter(f => parseAllSportsScore(f.event_final_result)).slice(0, 6)

    return {
      source: 'allsports',
      homeTeamName: homeData.team_name,
      awayTeamName: awayData.team_name,
      homeForm: computeBasketballFormAllSports(homeFixtures, homeKey, 'home'),
      awayForm: computeBasketballFormAllSports(awayFixtures, awayKey, 'away'),
      homeStanding: null, awayStanding: null,
      h2h: h2hRaw.map(f => {
        const score = parseAllSportsScore(f.event_final_result)
        return { date: f.event_date?.slice(0, 10), homeTeam: f.event_home_team, awayTeam: f.event_away_team, homeScore: score?.home, awayScore: score?.away }
      }),
    }
  } catch (err) {
    console.error('allsports-basketball fallback error:', err.message)
    return null
  }
}

// ── BallDontLie API helper ────────────────────────────────────────────────────

function ballDontLieGet(path, params = {}) {
  return new Promise((resolve, reject) => {
    if (!process.env.BALLDONTLIE_KEY) { resolve({ data: [] }); return }
    const parts = []
    for (const [key, val] of Object.entries(params)) {
      if (Array.isArray(val)) val.forEach(v => parts.push(`${key}[]=${encodeURIComponent(v)}`))
      else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`)
    }
    const qs = parts.join('&')
    const options = {
      hostname: 'api.balldontlie.io',
      path: `${path}${qs ? '?' + qs : ''}`,
      method: 'GET',
      headers: { 'Authorization': process.env.BALLDONTLIE_KEY, 'Content-Type': 'application/json' },
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('BallDontLie parse error')) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// Compute W/L + avg points from BallDontLie games list
function computeBasketballForm(games, teamId, venue) {
  const filtered = (games || [])
    .filter(g => g.home_team_score > 0 && g.visitor_team_score > 0) // finished
    .filter(g => {
      if (venue === 'home') return g.home_team?.id === teamId
      if (venue === 'away') return g.visitor_team?.id === teamId
      return g.home_team?.id === teamId || g.visitor_team?.id === teamId
    })
    .slice(0, 10)
  if (!filtered.length) return null
  let wins = 0, losses = 0, ptsFor = 0, ptsAgainst = 0
  for (const g of filtered) {
    const isHome = g.home_team?.id === teamId
    const tp = isHome ? g.home_team_score : g.visitor_team_score
    const op = isHome ? g.visitor_team_score : g.home_team_score
    ptsFor += tp; ptsAgainst += op
    tp > op ? wins++ : losses++
  }
  const count = filtered.length
  return { gamesCount: count, wins, losses, avgPts: +(ptsFor/count).toFixed(1), avgPtsAllowed: +(ptsAgainst/count).toFixed(1) }
}

// POST /analyze/basketball-form — real NBA stats with 12h SQLite cache
router.post('/basketball-form', authenticate, async (req, res) => {
  const { homeTeam, awayTeam } = req.body || {}
  if (!homeTeam || !awayTeam) return res.json({})
  if (!process.env.BALLDONTLIE_KEY) return res.json({ error: 'BALLDONTLIE_KEY not set' })

  const cacheKey = `bball_${homeTeam.toLowerCase().replace(/\s/g,'')}_${awayTeam.toLowerCase().replace(/\s/g,'')}`
  const cached = cacheGet(cacheKey, 12 * 60 * 60 * 1000)
  if (cached) { try { return res.json(JSON.parse(cached)) } catch {} }

  try {
    const now = new Date()
    const nbaSeason = (now.getMonth() + 1) >= 10 ? now.getFullYear() : now.getFullYear() - 1

    const [homeRes, awayRes] = await Promise.all([
      ballDontLieGet('/v1/teams', { search: homeTeam }),
      ballDontLieGet('/v1/teams', { search: awayTeam }),
    ])
    const homeData = homeRes.data?.[0]
    const awayData = awayRes.data?.[0]
    if (!homeData || !awayData) return res.json({ error: 'Teams not found', homeTeam, awayTeam })

    const homeId = homeData.id, awayId = awayData.id

    const [homeGamesRes, awayGamesRes, standingsRes] = await Promise.allSettled([
      ballDontLieGet('/v1/games', { team_ids: [homeId], seasons: [nbaSeason], per_page: 25 }),
      ballDontLieGet('/v1/games', { team_ids: [awayId], seasons: [nbaSeason], per_page: 25 }),
      ballDontLieGet('/v1/standings', { season: nbaSeason }),
    ])

    const homeGames  = homeGamesRes.status  === 'fulfilled' ? homeGamesRes.value?.data  || [] : []
    const awayGames  = awayGamesRes.status  === 'fulfilled' ? awayGamesRes.value?.data  || [] : []
    const standings  = standingsRes.status  === 'fulfilled' ? standingsRes.value?.data  || [] : []

    const h2h = homeGames.filter(g =>
      (g.home_team?.id === homeId && g.visitor_team?.id === awayId) ||
      (g.home_team?.id === awayId && g.visitor_team?.id === homeId)
    ).filter(g => g.home_team_score > 0).slice(0, 6)

    const homeStanding = standings.find(s => s.team?.id === homeId)
    const awayStanding = standings.find(s => s.team?.id === awayId)

    const result = {
      season: nbaSeason,
      homeTeamName: homeData.full_name,
      awayTeamName: awayData.full_name,
      homeForm: computeBasketballForm(homeGames, homeId, 'home'),
      awayForm: computeBasketballForm(awayGames, awayId, 'away'),
      homeStanding: homeStanding ? { wins: homeStanding.wins, losses: homeStanding.losses, rank: homeStanding.conference_rank } : null,
      awayStanding: awayStanding ? { wins: awayStanding.wins, losses: awayStanding.losses, rank: awayStanding.conference_rank } : null,
      h2h: h2h.map(g => ({
        date: (g.date || '').slice(0, 10),
        homeTeam: g.home_team?.full_name,
        awayTeam: g.visitor_team?.full_name,
        homeScore: g.home_team_score,
        awayScore: g.visitor_team_score,
      })),
    }

    cacheSet(cacheKey, JSON.stringify(result))
    return res.json(result)
  } catch (err) {
    console.error('BallDontLie error, trying AllSports fallback:', err.message)
  }

  // ── Fallback: AllSports basketball ────────────────────────────────────────
  const fallback = await getBasketballFormFromAllSports(homeTeam, awayTeam)
  if (fallback) {
    cacheSet(cacheKey, JSON.stringify(fallback))
    return res.json(fallback)
  }

  res.json({ error: 'Both BallDontLie and AllSports unavailable' })
})

// ── sstats backend helpers ────────────────────────────────────────────────────

function sstatsBackendGet(path, params = {}) {
  return new Promise((resolve, reject) => {
    if (!process.env.SSTATS_API_KEY) { resolve({ data: [] }); return }
    const q = new URLSearchParams({ ...params, apikey: process.env.SSTATS_API_KEY }).toString()
    const options = {
      hostname: 'api.sstats.net',
      path: `${path}?${q}`,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('sstats parse error')) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// Compute W/D/L + goals from raw game list filtered by venue
function computeFormStats(games, teamId, venue) {
  const filtered = (games || []).filter(g => {
    if (venue === 'home') return g.homeTeam?.id === teamId
    if (venue === 'away') return g.awayTeam?.id === teamId
    return true
  }).slice(0, 10)

  if (!filtered.length) return null

  let wins = 0, draws = 0, losses = 0, goalsFor = 0, goalsAgainst = 0
  for (const g of filtered) {
    const isHome = g.homeTeam?.id === teamId
    const tf = Number(isHome
      ? (g.homeFTResult ?? g.homeGoals ?? 0)
      : (g.awayFTResult ?? g.awayGoals ?? 0))
    const ta = Number(isHome
      ? (g.awayFTResult ?? g.awayGoals ?? 0)
      : (g.homeFTResult ?? g.homeGoals ?? 0))
    goalsFor += tf
    goalsAgainst += ta
    if (tf > ta) wins++
    else if (tf === ta) draws++
    else losses++
  }
  const count = filtered.length
  return {
    gamesCount: count,
    wins, draws, loses: losses,
    avgScore:    +(goalsFor  / count).toFixed(2),
    avgConceded: +(goalsAgainst / count).toFixed(2),
  }
}

// POST /analyze/team-form
// Returns real home/away form + H2H for a pair of team IDs (cached 6h in SQLite)
router.post('/team-form', authenticate, async (req, res) => {
  const { homeId, awayId } = req.body || {}
  if (!homeId || !awayId) return res.json({ homeForm: null, awayForm: null, h2h: [] })
  if (!process.env.SSTATS_API_KEY) return res.json({ homeForm: null, awayForm: null, h2h: [] })

  const cacheKey = `tf_${homeId}_${awayId}`
  const cached = cacheGet(cacheKey, TEAM_FORM_TTL)
  if (cached) {
    try { return res.json(JSON.parse(cached)) } catch {}
  }

  try {
    const [homeGamesRes, awayGamesRes, h2hRes] = await Promise.allSettled([
      sstatsBackendGet('/Games/list', { ended: true, team: homeId, limit: 20 }),
      sstatsBackendGet('/Games/list', { ended: true, team: awayId, limit: 20 }),
      sstatsBackendGet('/Games/list', { ended: true, bothTeams: `${homeId},${awayId}`, limit: 10 }),
    ])

    const homeGames = homeGamesRes.status === 'fulfilled' ? homeGamesRes.value?.data || [] : []
    const awayGames = awayGamesRes.status === 'fulfilled' ? awayGamesRes.value?.data || [] : []
    const h2hGames  = h2hRes.status  === 'fulfilled' ? h2hRes.value?.data  || [] : []

    const result = {
      homeForm: computeFormStats(homeGames, homeId, 'home'),
      awayForm: computeFormStats(awayGames, awayId, 'away'),
      h2h: h2hGames.slice(0, 8).map(g => ({
        homeTeam:  g.homeTeam?.name || '?',
        awayTeam:  g.awayTeam?.name || '?',
        homeScore: g.homeFTResult ?? g.homeGoals ?? '?',
        awayScore: g.awayFTResult ?? g.awayGoals ?? '?',
        date: (g.date || '').slice(0, 10),
      })),
    }

    cacheSet(cacheKey, JSON.stringify(result))
    res.json(result)
  } catch (err) {
    console.error('team-form error:', err.message)
    res.json({ homeForm: null, awayForm: null, h2h: [] })
  }
})

// ── AllSports Football form + H2H (covers all leagues Fonbet has) ────────────
const ALLSPORTS_FOOTBALL_TTL = 12 * 60 * 60 * 1000 // 12 hours

// Russian national team names → English (for AllSports search)
const RU_TO_EN_TEAMS = {
  'россия':'Russia','германия':'Germany','франция':'France','испания':'Spain',
  'англия':'England','италия':'Italy','португалия':'Portugal','нидерланды':'Netherlands',
  'бельгия':'Belgium','хорватия':'Croatia','дания':'Denmark','швеция':'Sweden',
  'норвегия':'Norway','швейцария':'Switzerland','австрия':'Austria','польша':'Poland',
  'чехия':'Czech Republic','сербия':'Serbia','греция':'Greece','турция':'Turkey',
  'украина':'Ukraine','румыния':'Romania','венгрия':'Hungary','словакия':'Slovakia',
  'финляндия':'Finland','шотландия':'Scotland','уэльс':'Wales','ирландия':'Ireland',
  'бразилия':'Brazil','аргентина':'Argentina','уругвай':'Uruguay','чили':'Chile',
  'колумбия':'Colombia','мексика':'Mexico','сша':'USA','канада':'Canada',
  'япония':'Japan','южная корея':'South Korea','австралия':'Australia',
  'египет':'Egypt','марокко':'Morocco','сенегал':'Senegal','нигерия':'Nigeria',
  'камерун':'Cameroon','гана':'Ghana','алжир':'Algeria','тунис':'Tunisia',
  'иран':'Iran','саудовская аравия':'Saudi Arabia','катар':'Qatar',
  'дания':'Denmark','польша':'Poland','венгрия':'Hungary',
  'гаити':'Haiti','новая зеландия':'New Zealand','н.зеландия':'New Zealand',
  'гибралтар':'Gibraltar','филиппины':'Philippines','гуам':'Guam',
  'албания':'Albania','израиль':'Israel','конго':'Congo','др конго':'DR Congo',
  'нигерия':'Nigeria','эквадор':'Ecuador','парагвай':'Paraguay','боливия':'Bolivia',
  'перу':'Peru','венесуэла':'Venezuela','коста-рика':'Costa Rica','панама':'Panama',
  'ямайка':'Jamaica','куба':'Cuba','гондурас':'Honduras','сальвадор':'El Salvador',
}

function translateTeamToEn(name) {
  const key = (name || '').toLowerCase().trim()
  return RU_TO_EN_TEAMS[key] || name
}

function parseAllSportsFixtures(fixtures, teamKey) {
  const finished = (fixtures || [])
    .filter(f => f.event_status === 'Finished' || (f.event_final_result && f.event_final_result !== '? - ?'))
    .slice(0, 10)

  if (!finished.length) return null

  let wins = 0, draws = 0, loses = 0, goalsFor = 0, goalsAgainst = 0

  for (const f of finished) {
    const parts = (f.event_final_result || '').split('-').map(s => parseInt(s.trim()))
    if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) continue
    const isHome = String(f.home_team_key || f.event_home_team_id) === String(teamKey)
    const myGoals = isHome ? parts[0] : parts[1]
    const theirGoals = isHome ? parts[1] : parts[0]
    goalsFor += myGoals
    goalsAgainst += theirGoals
    if (myGoals > theirGoals) wins++
    else if (myGoals === theirGoals) draws++
    else loses++
  }

  const count = wins + draws + loses
  if (!count) return null
  return {
    wins, draws, loses,
    gamesCount: count,
    avgScore:    +(goalsFor    / count).toFixed(2),
    avgConceded: +(goalsAgainst / count).toFixed(2),
  }
}

function parseAllSportsH2H(h2hData) {
  const raw = h2hData?.result || {}
  const matches = [
    ...(Array.isArray(raw.H2H) ? raw.H2H : []),
    ...(Array.isArray(raw.firstTeamResults)  ? raw.firstTeamResults.slice(0,3)  : []),
    ...(Array.isArray(raw.secondTeamResults) ? raw.secondTeamResults.slice(0,3) : []),
  ]
  return matches
    .filter(f => f.event_final_result && f.event_final_result !== '? - ?')
    .slice(0, 8)
    .map(f => {
      const parts = (f.event_final_result || '').split('-').map(s => parseInt(s.trim()))
      return {
        homeTeam:  { name: f.event_home_team || '?' },
        awayTeam:  { name: f.event_away_team || '?' },
        homeScore: isNaN(parts[0]) ? '?' : parts[0],
        awayScore: isNaN(parts[1]) ? '?' : parts[1],
        date:      (f.event_date || '').slice(0, 10),
      }
    })
}

// POST /analyze/football-form-allsports
// Searches sstats by team name → fetches form + H2H for ANY football match
// Works for Fonbet matches that don't have a sstats match ID
// Cached 12 hours per team pair
router.post('/football-form-allsports', authenticate, async (req, res) => {
  const { home, away } = req.body || {}
  if (!home || !away) return res.json({ homeForm: null, awayForm: null, h2h: [] })
  if (!process.env.SSTATS_API_KEY) return res.json({ homeForm: null, awayForm: null, h2h: [] })

  const cacheKey = `ssfb_${normalize(home)}_${normalize(away)}`
  const cached = cacheGet(cacheKey, ALLSPORTS_FOOTBALL_TTL)
  if (cached) {
    try { return res.json(JSON.parse(cached)) } catch {}
  }

  try {
    // Search sstats for team IDs by name (supports Russian + English)
    const enHome = translateTeamToEn(home)
    const enAway = translateTeamToEn(away)

    const [homeRes, awayRes] = await Promise.allSettled([
      sstatsBackendGet('/Teams/list', { name: enHome !== home ? enHome : home, limit: 3 }),
      sstatsBackendGet('/Teams/list', { name: enAway !== away ? enAway : away, limit: 3 }),
    ])

    const normStr = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const pickTeam = (res, query) => {
      const teams = res.status === 'fulfilled' ? (res.value?.data || []) : []
      const q = normStr(query)
      return teams.find(t => {
        const n = normStr(t.name || '')
        return n === q || n.includes(q) || q.includes(n)
      }) || teams[0] || null
    }

    const homeTeam = pickTeam(homeRes, enHome !== home ? enHome : home)
    const awayTeam = pickTeam(awayRes, enAway !== away ? enAway : away)

    if (!homeTeam && !awayTeam) {
      const empty = { homeForm: null, awayForm: null, h2h: [], source: 'sstats', homeTeamFound: false, awayTeamFound: false }
      cacheSet(cacheKey, JSON.stringify(empty))
      console.log(`[football-form] ${home} vs ${away}: teams not found in sstats`)
      return res.json(empty)
    }

    const homeId = homeTeam?.id
    const awayId = awayTeam?.id

    const [homeGamesRes, awayGamesRes, h2hRes] = await Promise.allSettled([
      homeId ? sstatsBackendGet('/Games/list', { ended: true, team: homeId, limit: 15 }) : Promise.resolve({ data: [] }),
      awayId ? sstatsBackendGet('/Games/list', { ended: true, team: awayId, limit: 15 }) : Promise.resolve({ data: [] }),
      (homeId && awayId)
        ? sstatsBackendGet('/Games/list', { ended: true, bothTeams: `${homeId},${awayId}`, limit: 8 })
        : Promise.resolve({ data: [] }),
    ])

    const homeGames = homeGamesRes.status === 'fulfilled' ? (homeGamesRes.value?.data || []) : []
    const awayGames = awayGamesRes.status === 'fulfilled' ? (awayGamesRes.value?.data || []) : []
    const h2hGames  = h2hRes.status === 'fulfilled' ? (h2hRes.value?.data || []) : []

    const result = {
      homeForm: computeFormStats(homeGames, homeId, 'home'),
      awayForm: computeFormStats(awayGames, awayId, 'away'),
      h2h: h2hGames.slice(0, 8).map(g => ({
        homeTeam:  { name: g.homeTeam?.name || '?' },
        awayTeam:  { name: g.awayTeam?.name || '?' },
        homeScore: g.homeFTResult ?? g.homeGoals ?? '?',
        awayScore: g.awayFTResult ?? g.awayGoals ?? '?',
        date:      (g.date || '').slice(0, 10),
      })),
      source: 'sstats',
      homeTeamFound: !!homeTeam,
      awayTeamFound: !!awayTeam,
    }

    cacheSet(cacheKey, JSON.stringify(result))
    console.log(`[football-form] ${home} vs ${away}: home=${!!result.homeForm}, away=${!!result.awayForm}, h2h=${result.h2h.length}`)
    res.json(result)

  } catch (err) {
    console.error('[football-form]', err.message)
    res.json({ homeForm: null, awayForm: null, h2h: [] })
  }
})

// POST /analyze/match-with-search
// POST /analyze/match-with-search
// Pre-match: gpt-4o-search-preview, cached 12h
// Live: gpt-4o-search-preview with live score/minute, NOT cached
router.post('/match-with-search', authenticate, async (req, res) => {
  const { home, away, league, date, odds1x2, sport = 'football', score, minute, isLive } = req.body || {}
  if (!home || !away) return res.status(400).json({ error: 'home/away required' })

  const live = !!(isLive || score)
  const year = new Date().getFullYear()

  // Pre-match: check cache (12h)
  const cacheKey = `wsearch_${(sport||'f')[0]}_${normalize(home)}_${normalize(away)}`
  if (!live) {
    const cached = cacheGet(cacheKey, SEARCH_CACHE_TTL)
    if (cached) {
      try { return res.json(JSON.parse(cached)) } catch {}
    }
  }

  const oddsBlock = odds1x2
    ? `Коэффициенты: П1 ${odds1x2.home}${odds1x2.draw ? ` | X ${odds1x2.draw}` : ''} | П2 ${odds1x2.away}`
    : ''

  // Sport-specific config for prompts
  const SPORT_CFG = {
    football: {
      name: 'футбол',
      searchItems: `1. Последние 5-7 матчей ${home} — результаты, голы, форма\n2. Последние 5-7 матчей ${away} — результаты, голы, форма\n3. История очных встреч (3-5 матчей)\n4. Травмы и дисквалификации ключевых игроков\n5. Актуальные новости перед матчем`,
      betTypes: '- Тотал голов (ТБ/ТМ 2.5)\n- Обе команды забьют\n- Фора по голам\n- Победитель матча',
      liveItems: `Что происходит в этом матче прямо сейчас — голы, карточки, замены, кто доминирует`,
      unit: 'голы',
    },
    hockey: {
      name: 'хоккей',
      searchItems: `1. Последние 5-7 матчей ${home} — результаты, голы, форма\n2. Последние 5-7 матчей ${away} — результаты\n3. Статистика вратарей (save%), игра в большинстве/меньшинстве\n4. Травмы ключевых хоккеистов\n5. История очных встреч (3-5 матчей)`,
      betTypes: '- Тотал голов (ТБ/ТМ 5.5)\n- Победа в основное время\n- Обе команды забьют 2+\n- Фора по голам (-1.5/+1.5)',
      liveItems: `Что происходит в матче — голы, штрафы, период. Кто доминирует по броскам и голам`,
      unit: 'голы',
    },
    cs2: {
      name: 'Counter-Strike 2',
      searchItems: `1. Последние 5-7 матчей ${home} — результаты по картам\n2. Последние 5-7 матчей ${away} — результаты\n3. История очных встреч этих команд\n4. Рейтинг игроков (rating 2.0), состав, форма\n5. Актуальные новости и трансферы`,
      betTypes: '- Победитель матча (нет ничьих)\n- Тотал карт под/над 2.5\n- Фора по картам (-1.5/+1.5)\n- Победа на первой карте',
      liveItems: `Текущий счёт по картам, кто выигрывает раунды, общая форма команд`,
      unit: 'карты',
    },
    dota2: {
      name: 'Dota 2',
      searchItems: `1. Последние 5-7 матчей ${home} — результаты по картам\n2. Последние 5-7 матчей ${away}\n3. История очных встреч\n4. Стиль игры, hero pool, текущий состав\n5. Актуальные новости и форма`,
      betTypes: '- Победитель матча (нет ничьих)\n- Тотал карт под/над 2.5\n- Фора по картам (-1.5/+1.5)\n- Победа на первой карте',
      liveItems: `Найди следующее по этому матчу:
1. Счёт по картам (сколько карт выиграл каждый)
2. Текущая карта — какие герои выбраны каждой командой (пики/баны)
3. Нетворт и XP преимущество — кто ведёт по золоту
4. KDA ключевых игроков на текущей карте
5. Насколько метовые герои у каждой команды — сравни с текущим патчем
6. Взятые объекты: Рошан, башни, бараки
Сделай вывод: у кого более выигрышный драфт и кто побеждает по ходу матча`,
      unit: 'карты',
    },
  }
  const cfg = SPORT_CFG[sport] || SPORT_CFG.football

  const prompt = live
    ? `Ты профессиональный спортивный аналитик (${cfg.name}). Матч ИДЁТ прямо сейчас.

МАТЧ: ${home} vs ${away}
ТУРНИР: ${league || 'не указан'}
🔴 ТЕКУЩИЙ СЧЁТ: ${score}${minute ? ` (${minute} мин)` : ''}
${oddsBlock}

ЗАДАЧА: найди в интернете: ${cfg.liveItems}

Сделай лайв-анализ: кто победит, что ожидается дальше.

Ответь СТРОГО в JSON (без markdown):
{
  "verdict": "вердикт с учётом текущего счёта",
  "summary": "3-4 предложения о ходе матча с реальными данными",
  "confidence": число 50-90,
  "risk": "low | medium | high",
  "fairOdds": "справедливый коэф сейчас",
  "bookOdds": null,
  "value": 0,
  "reasons": ["факт 1", "факт 2", "факт 3"],
  "extraBets": [
    {"type": "ставка", "confidence": число, "reason": "обоснование"},
    {"type": "ставка", "confidence": число, "reason": "обоснование"}
  ],
  "bestOdds": [],
  "dataWarning": null
}`
    : `Ты профессиональный спортивный аналитик (${cfg.name}). Проанализируй предстоящий матч.

МАТЧ: ${home} vs ${away}
ТУРНИР: ${league || 'не указан'}
${date ? `Дата: ${date}` : ''}
${oddsBlock}

ЗАДАЧА: найди в интернете актуальную информацию за ${year} год:
${cfg.searchItems}

Единица счёта в ${cfg.name}: ${cfg.unit}.

Ответь СТРОГО в JSON (без markdown):
{
  "verdict": "чёткий вердикт — победитель или исход",
  "summary": "3-4 предложения с конкретными фактами из интернета",
  "confidence": число 50-90,
  "risk": "low | medium | high",
  "fairOdds": "справедливый коэффициент",
  "bookOdds": "коэф букмекера если есть",
  "value": число или 0,
  "reasons": ["факт 1 с цифрой", "факт 2", "факт 3", "факт 4"],
  "extraBets": [
    {"type": "название ставки", "confidence": число, "reason": "обоснование"},
    {"type": "название ставки", "confidence": число, "reason": "обоснование"},
    {"type": "название ставки", "confidence": число, "reason": "обоснование"}
  ],
  "bestOdds": [],
  "dataWarning": null
}

Доп. ставки: ${cfg.betTypes}`

  try {
    const raw = await callOpenAIWithWebSearch([
      { role: 'system', content: 'Ты спортивный аналитик. Ищи реальные данные в интернете. Отвечай только JSON без markdown.' },
      { role: 'user', content: prompt },
    ])

    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
    let analysis
    try { analysis = JSON.parse(cleaned) }
    catch { const m = raw.match(/\{[\s\S]*\}/); analysis = m ? JSON.parse(m[0]) : null }

    if (!analysis) return res.status(500).json({ error: 'Parse failed' })

    // Убираем markdown-ссылки [text](url) → text; принудительно строки
    const stripMd = (s) => {
      if (s === null || s === undefined) return s
      const str = typeof s === 'object' ? JSON.stringify(s) : String(s)
      return str.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s{2,}/g, ' ').trim()
    }
    const forceStr = (s, fallback = '') => {
      if (s === null || s === undefined) return fallback
      if (typeof s === 'object') return fallback
      return String(s)
    }

    const result = {
      verdict:    stripMd(analysis.verdict)    || `Победа ${home}`,
      summary:    stripMd(analysis.summary)    || '',
      confidence: Math.min(90, Math.max(50, Number(analysis.confidence) || 65)),
      risk:       forceStr(analysis.risk, 'medium'),
      fairOdds:   forceStr(analysis.fairOdds, '—') || '—',
      bookOdds:   typeof analysis.bookOdds === 'string' ? analysis.bookOdds : null,
      value:      Number(analysis.value) || 0,
      reasons:    Array.isArray(analysis.reasons)   ? analysis.reasons.map(r => stripMd(r))   : [],
      extraBets:  Array.isArray(analysis.extraBets) ? analysis.extraBets.map(b => ({ ...b, type: stripMd(b.type), reason: stripMd(b.reason) })) : [],
      bestOdds:   [],
      dataWarning: stripMd(analysis.dataWarning) || null,
      searchUsed: true,
    }

    // Cache only pre-match results
    if (!live) cacheSet(cacheKey, JSON.stringify(result))
    console.log(`[match-with-search] ${live ? '🔴 LIVE' : '📅 PRE'} ${home} vs ${away}: "${result.verdict}" conf=${result.confidence}`)
    res.json(result)

  } catch (err) {
    console.error('[match-with-search]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── BallDontLie universal sport support ───────────────────────────────────────

// Season calculation per sport
function getBDLSeason(prefix) {
  const now = new Date()
  const month = now.getMonth() + 1
  const year = now.getFullYear()
  if (prefix === 'nhl') return month >= 10 ? year : year - 1
  if (prefix === 'nfl') return month >= 9  ? year : year - 1
  return year // mlb, esports, tennis, mma — calendar year
}

// Generic W/L + avg score computation from BDL games array
// Tries home_team/visitor_team fields first, then team1/team2 (esports)
function computeBDLTeamForm(games, teamId) {
  if (!games?.length) return null
  const sample = games[0] || {}
  const useTeam1 = sample.team1 !== undefined
  const homeKey   = useTeam1 ? 'team1'       : 'home_team'
  const visKey    = useTeam1 ? 'team2'        : 'visitor_team'
  const homeSKey  = useTeam1 ? 'team1_score'  : 'home_team_score'
  const visSKey   = useTeam1 ? 'team2_score'  : 'visitor_team_score'

  const finished = games.filter(g => {
    const hs = g[homeSKey], vs = g[visSKey]
    return hs != null && vs != null && (Number(hs) + Number(vs)) > 0
  })
  if (!finished.length) return null

  let wins = 0, losses = 0, scoresFor = 0, scoresAgainst = 0
  for (const g of finished) {
    const isHome = g[homeKey]?.id === teamId
    const tf = Number(isHome ? g[homeSKey] : g[visSKey])
    const ta = Number(isHome ? g[visSKey]  : g[homeSKey])
    scoresFor += tf; scoresAgainst += ta
    tf > ta ? wins++ : losses++
  }
  const count = finished.length
  return { gamesCount: count, wins, losses,
    avgScore:    +(scoresFor    / count).toFixed(1),
    avgConceded: +(scoresAgainst / count).toFixed(1) }
}

// Fetch team stats for any BDL team sport (nhl, nfl, mlb, cs2, dota2, lol, valorant)
async function getBDLTeamForm(prefix, homeTeam, awayTeam) {
  const season = getBDLSeason(prefix)
  const [homeRes, awayRes] = await Promise.all([
    ballDontLieGet(`/${prefix}/v1/teams`, { search: homeTeam }),
    ballDontLieGet(`/${prefix}/v1/teams`, { search: awayTeam }),
  ])
  const homeData = homeRes?.data?.[0]
  const awayData = awayRes?.data?.[0]
  if (!homeData || !awayData) return { error: 'teams not found', homeTeam, awayTeam }

  const homeId = homeData.id, awayId = awayData.id
  const teamName = t => t.full_name || t.name || String(t.id)

  const [homeGamesRes, awayGamesRes, standingsRes] = await Promise.allSettled([
    ballDontLieGet(`/${prefix}/v1/games`, { team_ids: [homeId], seasons: [season], per_page: 25 }),
    ballDontLieGet(`/${prefix}/v1/games`, { team_ids: [awayId], seasons: [season], per_page: 25 }),
    ballDontLieGet(`/${prefix}/v1/standings`, { season }).catch(() => ({ data: [] })),
  ])

  const homeGames  = homeGamesRes.status  === 'fulfilled' ? homeGamesRes.value?.data  || [] : []
  const awayGames  = awayGamesRes.status  === 'fulfilled' ? awayGamesRes.value?.data  || [] : []
  const standings  = standingsRes.status  === 'fulfilled' ? standingsRes.value?.data  || [] : []

  // H2H: games involving both teams
  const sample = homeGames[0] || {}
  const useTeam1 = sample.team1 !== undefined
  const hk = useTeam1 ? 'team1' : 'home_team', vk = useTeam1 ? 'team2' : 'visitor_team'
  const hsk = useTeam1 ? 'team1_score' : 'home_team_score'

  const h2h = homeGames.filter(g => {
    const ht = g[hk]?.id, vt = g[vk]?.id
    return (ht === homeId && vt === awayId) || (ht === awayId && vt === homeId)
  }).filter(g => (g[hsk] ?? 0) > 0).slice(0, 6)

  const homeStanding = standings.find(s => s.team?.id === homeId)
  const awayStanding = standings.find(s => s.team?.id === awayId)

  return {
    sport: prefix, season,
    homeTeamName: teamName(homeData),
    awayTeamName: teamName(awayData),
    homeForm: computeBDLTeamForm(homeGames.filter(g => g[hk]?.id === homeId), homeId),
    awayForm: computeBDLTeamForm(awayGames.filter(g => g[vk]?.id === awayId), awayId),
    homeStanding: homeStanding ? { wins: homeStanding.wins, losses: homeStanding.losses, rank: homeStanding.conference_rank } : null,
    awayStanding: awayStanding ? { wins: awayStanding.wins, losses: awayStanding.losses, rank: awayStanding.conference_rank } : null,
    h2h: h2h.map(g => ({
      date: (g.date || '').slice(0, 10),
      homeTeam: teamName(g[hk] || {}),
      awayTeam: teamName(g[vk] || {}),
      homeScore: g[hsk],
      awayScore: g[useTeam1 ? 'team2_score' : 'visitor_team_score'],
    })),
    source: 'balldontlie',
  }
}

// Fetch player stats for individual sports (tennis, mma)
async function getBDLPlayerForm(prefix, player1, player2) {
  const year = new Date().getFullYear()
  const playerEndpoint = prefix === 'mma' ? 'fighters' : 'players'
  const matchEndpoint  = prefix === 'mma' ? 'bouts'    : 'matches'

  const [p1Res, p2Res] = await Promise.all([
    ballDontLieGet(`/${prefix}/v1/${playerEndpoint}`, { search: player1, per_page: 5 }),
    ballDontLieGet(`/${prefix}/v1/${playerEndpoint}`, { search: player2, per_page: 5 }),
  ])
  const p1 = p1Res?.data?.[0], p2 = p2Res?.data?.[0]
  if (!p1 || !p2) return { error: 'players not found', player1, player2 }

  const pName = p => p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || String(p.id)

  const [p1MatchesRes, p2MatchesRes] = await Promise.allSettled([
    ballDontLieGet(`/${prefix}/v1/${matchEndpoint}`, { player_ids: [p1.id], seasons: [year], per_page: 20 }),
    ballDontLieGet(`/${prefix}/v1/${matchEndpoint}`, { player_ids: [p2.id], seasons: [year], per_page: 20 }),
  ])
  const p1Matches = p1MatchesRes.status === 'fulfilled' ? p1MatchesRes.value?.data || [] : []
  const p2Matches = p2MatchesRes.status === 'fulfilled' ? p2MatchesRes.value?.data || [] : []

  const computePlayerForm = (matches, playerId) => {
    const finished = matches.filter(m => m.winner_id != null || m.winner?.id != null)
    if (!finished.length) return null
    const wins = finished.filter(m => (m.winner_id ?? m.winner?.id) === playerId).length
    return { gamesCount: finished.length, wins, losses: finished.length - wins }
  }

  // H2H: matches where both players appeared
  const h2h = p1Matches.filter(m => {
    const ids = (m.players || m.fighters || []).map(p => p.id)
    return ids.includes(p1.id) && ids.includes(p2.id)
  }).slice(0, 5)

  return {
    sport: prefix,
    player1Name: pName(p1),
    player2Name: pName(p2),
    player1Form: computePlayerForm(p1Matches, p1.id),
    player2Form: computePlayerForm(p2Matches, p2.id),
    h2h: h2h.map(m => ({
      date: (m.date || '').slice(0, 10),
      winnerId: m.winner_id ?? m.winner?.id,
      winnerName: m.winner?.name ?? (m.winner_id === p1.id ? pName(p1) : pName(p2)),
      result: m.result || m.score || '',
    })),
    source: 'balldontlie',
  }
}

// ── AllSports fallback for sport-form (uses same RAPIDAPI_KEY as basketball) ──

// Generic AllSports getter for any sport path (hockey, tennis, esports, mma, etc.)
function allSportsGet(sportPath, queryString) {
  return new Promise((resolve, reject) => {
    const key = process.env.RAPIDAPI_KEY
    if (!key) { resolve({ result: [] }); return }
    const options = {
      hostname: ALLSPORTS_BASKETBALL_HOST, // allsportsapi2.p.rapidapi.com
      path: `/api/${sportPath}/?${queryString}`,
      method: 'GET',
      timeout: 8000,
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': ALLSPORTS_BASKETBALL_HOST,
        'Accept': 'application/json',
      },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error(`allsports-${sportPath} parse error`)) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error(`allsports-${sportPath} timeout`)) })
    req.end()
  })
}

// AllSports sport path mapping (sports not listed here → no fallback)
const ALLSPORTS_SPORT_PATH = {
  hockey:   'hockey',
  cs2:      'esports',
  dota2:    'esports',
  lol:      'esports',
  valorant: 'esports',
  tennis:   'tennis',
  mma:      'mma',
}

// Generic AllSports form fallback — searches team by name, fetches last 45 days fixtures
async function getFormFromAllSports(sport, homeTeam, awayTeam) {
  const sportPath = ALLSPORTS_SPORT_PATH[sport]
  if (!sportPath || !process.env.RAPIDAPI_KEY) return null

  try {
    const normTeam = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const findTeam = (teams, query) => {
      const q = normTeam(query)
      return teams.find(t => {
        const n = normTeam(t.team_name || t.player_name || '')
        return n === q || n.includes(q) || q.includes(n)
      }) || null
    }

    // Search teams by name (AllSports supports teamName= for most sports)
    const [homeTeamsRes, awayTeamsRes] = await Promise.all([
      allSportsGet(sportPath, `met=Teams&teamName=${encodeURIComponent(homeTeam)}`).catch(() => ({ result: [] })),
      allSportsGet(sportPath, `met=Teams&teamName=${encodeURIComponent(awayTeam)}`).catch(() => ({ result: [] })),
    ])

    const homeTeams = homeTeamsRes?.result || []
    const awayTeams = awayTeamsRes?.result || []
    const homeData  = findTeam(homeTeams, homeTeam)
    const awayData  = findTeam(awayTeams, awayTeam)
    if (!homeData || !awayData) return null

    const homeKey = homeData.team_key, awayKey = awayData.team_key
    const today  = new Date().toISOString().slice(0, 10)
    const past45 = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    const [homeRes, awayRes] = await Promise.all([
      allSportsGet(sportPath, `met=Fixtures&teamId=${homeKey}&from=${past45}&to=${today}`).catch(() => ({ result: [] })),
      allSportsGet(sportPath, `met=Fixtures&teamId=${awayKey}&from=${past45}&to=${today}`).catch(() => ({ result: [] })),
    ])

    const homeFixtures = homeRes?.result || []
    const awayFixtures = awayRes?.result || []
    if (!homeFixtures.length && !awayFixtures.length) return null

    const h2hRaw = homeFixtures.filter(f =>
      String(f.home_team_key) === String(awayKey) || String(f.away_team_key) === String(awayKey)
    ).filter(f => parseAllSportsScore(f.event_final_result)).slice(0, 6)

    // Reuse basketball form helper — same AllSports fixture structure
    const hf = computeBasketballFormAllSports(homeFixtures, homeKey, 'home')
    const af = computeBasketballFormAllSports(awayFixtures, awayKey, 'away')

    return {
      source: 'allsports',
      sport,
      homeTeamName: homeData.team_name,
      awayTeamName: awayData.team_name,
      homeForm: hf ? { gamesCount: hf.gamesCount, wins: hf.wins, losses: hf.losses, avgScore: hf.avgPts, avgConceded: hf.avgPtsAllowed } : null,
      awayForm: af ? { gamesCount: af.gamesCount, wins: af.wins, losses: af.losses, avgScore: af.avgPts, avgConceded: af.avgPtsAllowed } : null,
      h2h: h2hRaw.map(f => {
        const score = parseAllSportsScore(f.event_final_result)
        return { date: f.event_date?.slice(0, 10), homeTeam: f.event_home_team, awayTeam: f.event_away_team, homeScore: score?.home, awayScore: score?.away }
      }),
    }
  } catch (err) {
    console.error(`allsports fallback error [${sport}]:`, err.message)
    return null
  }
}

// Sport routing table: frontend sport → BDL prefix + type
const SPORT_MAP = {
  hockey:   { prefix: 'nhl',        type: 'team'       },
  nfl:      { prefix: 'nfl',        type: 'team'       },
  baseball: { prefix: 'mlb',        type: 'team'       },
  cs2:      { prefix: 'cs2',        type: 'team'       },
  dota2:    { prefix: 'dota2',      type: 'team'       },
  lol:      { prefix: 'lol',        type: 'team'       },
  valorant: { prefix: 'valorant',   type: 'team'       },
  tennis:   { prefix: 'atp_tennis', type: 'individual' },
  mma:      { prefix: 'mma',        type: 'individual' },
}

// POST /analyze/sport-form — BDL primary + AllSports fallback
router.post('/sport-form', authenticate, async (req, res) => {
  const { sport, homeTeam, awayTeam } = req.body || {}
  if (!sport || !homeTeam || !awayTeam) return res.status(400).json({ error: 'sport, homeTeam, awayTeam required' })

  const cacheKey = `bdl_${sport}_${homeTeam.toLowerCase().replace(/\s/g, '')}_${awayTeam.toLowerCase().replace(/\s/g, '')}`
  const cached = cacheGet(cacheKey, 12 * 60 * 60 * 1000)
  if (cached) { try { return res.json(JSON.parse(cached)) } catch {} }

  const config = SPORT_MAP[sport]
  if (!config) return res.json({ error: `Unknown sport: ${sport}`, sport })

  // ── Step 1: BallDontLie ───────────────────────────────────────────────────
  if (process.env.BALLDONTLIE_KEY) {
    try {
      const result = config.type === 'team'
        ? await getBDLTeamForm(config.prefix, homeTeam, awayTeam)
        : await getBDLPlayerForm(config.prefix, homeTeam, awayTeam)
      if (!result.error) {
        cacheSet(cacheKey, JSON.stringify(result))
        return res.json(result)
      }
      console.warn(`BDL sport-form no data [${sport}]: ${result.error}`)
    } catch (err) {
      console.error(`BDL sport-form error [${sport}]:`, err.message)
    }
  }

  // ── Step 2: AllSports fallback ────────────────────────────────────────────
  const fallback = await getFormFromAllSports(sport, homeTeam, awayTeam)
  if (fallback) {
    cacheSet(cacheKey, JSON.stringify(fallback))
    return res.json(fallback)
  }

  res.json({ error: 'Both BallDontLie and AllSports unavailable', sport })
})

// ── Football enrichment: TheSportsDB logos + API-Football injuries/lineups ───
// Called before AI analysis — enriches prompt with real squad/injury data
// Caches logos 7 days, injuries/lineups 12h to stay within 100 req/day quota
const ENRICH_TTL_LOGOS   = 7 * 24 * 60 * 60 * 1000  // 7 days
const ENRICH_TTL_SQUADS  = 12 * 60 * 60 * 1000       // 12 hours

router.post('/football-enrich', authenticate, async (req, res) => {
  const { homeEn, awayEn, date, leagueId } = req.body || {}
  if (!homeEn || !awayEn) return res.status(400).json({ error: 'Missing homeEn/awayEn' })

  const result = {
    homeLogoTSDB: null, awayLogoTSDB: null,
    homeStadium: null,  awayStadium: null,
    injuries: null,     lineups: null,
  }

  // ── Step 1: TheSportsDB logos (free, cached 7 days) ───────────────────────
  const logoKey = `tsdb_${normalize(homeEn)}_${normalize(awayEn)}`
  const cachedLogos = cacheGet(logoKey, ENRICH_TTL_LOGOS)
  if (cachedLogos) {
    const logos = JSON.parse(cachedLogos)
    Object.assign(result, logos)
  } else {
    try {
      const [homeData, awayData] = await Promise.allSettled([
        theSportsDBGet(`searchteams.php?t=${encodeURIComponent(homeEn)}`),
        theSportsDBGet(`searchteams.php?t=${encodeURIComponent(awayEn)}`),
      ])
      const homeTeam = homeData.status === 'fulfilled' ? homeData.value?.teams?.[0] : null
      const awayTeam = awayData.status === 'fulfilled' ? awayData.value?.teams?.[0] : null

      const logos = {
        homeLogoTSDB: homeTeam?.strTeamBadge || null,
        awayLogoTSDB: awayTeam?.strTeamBadge || null,
        homeStadium:  homeTeam?.strStadium   || null,
        awayStadium:  awayTeam?.strStadium   || null,
      }
      Object.assign(result, logos)
      cacheSet(logoKey, JSON.stringify(logos))
      console.log(`[enrich/tsdb] ${homeEn} vs ${awayEn}: home_logo=${!!logos.homeLogoTSDB}, away_logo=${!!logos.awayLogoTSDB}`)
    } catch (err) {
      console.warn('[enrich/tsdb]', err.message)
    }
  }

  // ── Step 2: API-Football injuries + lineups (100 req/day, cached 12h) ──────
  const squadKey = `apifb_${normalize(homeEn)}_${normalize(awayEn)}_${date || 'nd'}`
  const cachedSquads = cacheGet(squadKey, ENRICH_TTL_SQUADS)
  if (cachedSquads) {
    const squads = JSON.parse(cachedSquads)
    result.injuries = squads.injuries
    result.lineups  = squads.lineups
  } else if (date && LEAGUE_TO_APIFOOTBALL[leagueId] && process.env.RAPIDAPI_KEY) {
    try {
      const apiLeague = LEAGUE_TO_APIFOOTBALL[leagueId]
      const season = new Date(date).getFullYear()
      const fixturesData = await apiFootballGet('/v3/fixtures', { date, league: apiLeague, season })
      const fixtures = fixturesData?.response || []

      // Fuzzy-match fixture by team names
      const normStr = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
      const hN = normStr(homeEn), aN = normStr(awayEn)
      const fixture = fixtures.find(f => {
        const fh = normStr(f.teams?.home?.name), fa = normStr(f.teams?.away?.name)
        return (fh.includes(hN) || hN.includes(fh)) && (fa.includes(aN) || aN.includes(fa))
      })

      const squads = { injuries: null, lineups: null }
      if (fixture) {
        const fid = fixture.fixture?.id
        const [injRes, linRes] = await Promise.allSettled([
          apiFootballGet('/v3/injuries', { fixture: fid }),
          apiFootballGet('/v3/fixtures/lineups', { fixture: fid }),
        ])

        // Parse injuries
        if (injRes.status === 'fulfilled') {
          const inj = injRes.value?.response || []
          if (inj.length) {
            const pickSide = (teamName) => inj
              .filter(i => normStr(i.team?.name).includes(normStr(teamName)) || normStr(teamName).includes(normStr(i.team?.name || '')))
              .map(i => ({ player: i.player?.name, reason: i.player?.reason || i.player?.type || 'травма' }))
            squads.injuries = { home: pickSide(homeEn), away: pickSide(awayEn) }
          }
        }

        // Parse lineups
        if (linRes.status === 'fulfilled') {
          const lins = linRes.value?.response || []
          if (lins.length >= 1) {
            const parseSide = (l) => l ? {
              formation: l.formation,
              coach: l.coach?.name,
              startXI: (l.startXI || []).map(p => p.player?.name).filter(Boolean),
            } : null
            // Match home/away by team name
            const hLin = lins.find(l => normStr(l.team?.name).includes(hN) || hN.includes(normStr(l.team?.name || '')))
            const aLin = lins.find(l => normStr(l.team?.name).includes(aN) || aN.includes(normStr(l.team?.name || '')))
            squads.lineups = { home: parseSide(hLin), away: parseSide(aLin) }
          }
        }
        console.log(`[enrich/apifb] fixture ${fid}: injuries=${!!squads.injuries}, lineups=${!!squads.lineups}`)
      } else {
        console.warn(`[enrich/apifb] no fixture for ${homeEn} vs ${awayEn} on ${date} league=${apiLeague}`)
      }

      result.injuries = squads.injuries
      result.lineups  = squads.lineups
      cacheSet(squadKey, JSON.stringify(squads))
    } catch (err) {
      console.warn('[enrich/apifb]', err.message)
    }
  }

  res.json(result)
})

// ── sstats proxy — hides API key from frontend bundle ────────────────────────
// Allowed path prefixes (whitelist to prevent abuse)
const SSTATS_ALLOWED_PATHS = [
  '/Teams/list', '/Games/list', '/Games/last-games-stats',
  '/Games/glicko/', '/Games/statistics', '/Games/',
  '/Odds/', '/Pari/matches',
]

function sstatsProxyGet(path, params = {}) {
  const key = process.env.SSTATS_API_KEY
  if (!key) return Promise.reject(new Error('SSTATS_API_KEY not configured'))
  const qs = new URLSearchParams({ ...params, apikey: key }).toString()
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.sstats.net',
      path: `${path}?${qs}`,
      method: 'GET',
      timeout: 10000,
      headers: { 'Accept': 'application/json' },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        if (res.statusCode >= 400) { reject(new Error(`sstats HTTP ${res.statusCode}`)); return }
        try { resolve(JSON.parse(data)) } catch { reject(new Error('sstats parse error')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('sstats timeout')) })
    req.end()
  })
}

router.post('/sstats', authenticate, async (req, res) => {
  const { path, params = {} } = req.body || {}
  if (!path || typeof path !== 'string') return res.status(400).json({ error: 'Missing path' })
  if (!SSTATS_ALLOWED_PATHS.some(p => path.startsWith(p))) {
    return res.status(400).json({ error: 'Path not allowed' })
  }
  try {
    const data = await sstatsProxyGet(path, params)
    res.json(data)
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// ── OpenAI proxy — replaces Cloudflare Worker for Russian users ──────────────
router.post('/ai-proxy', authenticate, async (req, res) => {
  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(req.body),
    })
    const data = await openaiRes.json()
    res.status(openaiRes.status).json(data)
  } catch (err) {
    res.status(500).json({ error: { message: err.message } })
  }
})

module.exports = router
