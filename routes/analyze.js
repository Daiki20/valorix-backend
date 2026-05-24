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
      path: `/v2${path}${qs ? '?' + qs : ''}`,
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
      ballDontLieGet('/nba/teams', { search: homeTeam }),
      ballDontLieGet('/nba/teams', { search: awayTeam }),
    ])
    const homeData = homeRes.data?.[0]
    const awayData = awayRes.data?.[0]
    if (!homeData || !awayData) return res.json({ error: 'Teams not found', homeTeam, awayTeam })

    const homeId = homeData.id, awayId = awayData.id

    const [homeGamesRes, awayGamesRes, standingsRes] = await Promise.allSettled([
      ballDontLieGet('/nba/games', { team_ids: [homeId], seasons: [nbaSeason], per_page: 25 }),
      ballDontLieGet('/nba/games', { team_ids: [awayId], seasons: [nbaSeason], per_page: 25 }),
      ballDontLieGet('/nba/standings', { season: nbaSeason }),
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

module.exports = router
