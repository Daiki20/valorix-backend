const express = require('express')
const router = express.Router()
const https = require('https')
const { authenticate } = require('../middleware/auth')
const db = require('../db')

const CACHE_TTL      = 3 * 60 * 60 * 1000 // 3 hours — analysis cache
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

module.exports = router
