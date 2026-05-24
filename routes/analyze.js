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
