const express = require('express')
const router = express.Router()
const https = require('https')
const { authenticate } = require('../middleware/auth')
const db = require('../db')

const CACHE_TTL = 3 * 60 * 60 * 1000 // 3 hours — stale before lineups announced

function cacheGet(key) {
  try {
    const row = db.prepare('SELECT content, created_at FROM analysis_cache WHERE cache_key = ?').get(key)
    if (!row) return null
    if (Date.now() - row.created_at > CACHE_TTL) {
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

// ── PandaScore helper (replaces dead esports-data.p.rapidapi.com) ─────────────
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
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`pandascore ${res.statusCode}`)); return }
        try { resolve(JSON.parse(data)) } catch { reject(new Error('parse error')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

const PS_GAME_SLUGS = { cs2: 'cs-go', dota2: 'dota-2', valorant: 'valorant', lol: 'league-of-legends' }

// Find team on PandaScore — returns team object WITH players array
async function findPSTeam(game, teamName) {
  const gameSlug = PS_GAME_SLUGS[game] || game
  const data = await pandascoreGet('/teams', {
    'search[name]': teamName,
    'filter[videogame_slug]': gameSlug,
    'page[size]': 5,
  })
  const teams = Array.isArray(data) ? data : []
  if (!teams.length) return null
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const q = norm(teamName)
  return teams.find(t =>
    norm(t.name).includes(q) || q.includes(norm(t.name)) ||
    norm(t.acronym || '').includes(q) || q.includes(norm(t.acronym || ''))
  ) || teams[0]
}

// Fetch last N finished matches for a team
async function fetchPSRecentMatches(teamId, count = 7) {
  const data = await pandascoreGet('/matches/past', {
    'filter[opponent_id]': teamId,
    'sort': '-end_at',
    'page[size]': count,
  })
  return Array.isArray(data) ? data : []
}

// Format PandaScore match results to readable string
function formatPSMatches(matches, teamId) {
  if (!matches.length) return null
  return matches.slice(0, 7).map(m => {
    const opp1 = m.opponents?.[0]?.opponent
    const opp2 = m.opponents?.[1]?.opponent
    const isT1  = String(opp1?.id) === String(teamId)
    const opponent = isT1 ? opp2?.name : opp1?.name || '?'
    const myRes  = (m.results || []).find(r => String(r.team_id) === String(teamId))
    const oppRes = (m.results || []).find(r => String(r.team_id) !== String(teamId))
    const myScore  = myRes?.score  ?? 0
    const oppScore = oppRes?.score ?? 0
    const win = myScore > oppScore
    const tourney = m.tournament?.name || m.league?.name || ''
    return `${win ? 'W' : 'L'} vs ${opponent} ${myScore}:${oppScore}${tourney ? ` [${tourney}]` : ''}`
  }).join(' | ')
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

// Esports Data API by mrcupcake (esports-data.p.rapidapi.com)
function esportsGet(path, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString()
    const fullPath = qs ? `${path}?${qs}` : path
    const options = {
      hostname: ESPORTS_HOST,
      path: fullPath,
      method: 'GET',
      headers: {
        'x-rapidapi-host': ESPORTS_HOST,
        'x-rapidapi-key': process.env.RAPIDAPI_KEY,
      },
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`[esports] ${path} → ${res.statusCode}: ${data.slice(0, 300)}`)
          reject(new Error(`esports API ${res.statusCode}`))
          return
        }
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('esports parse error')) }
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

// ── Esports Data (mrcupcake) ────────────────────────────────────────────────

const ESPORTS_GAME_IDS = {
  dota2: 'dota2',
  cs2: 'csgo',
  valorant: 'valorant',
  lol: 'lol',
}

// Find team in rankings by name → returns { id, name, rank, ... }
async function findTeamInRankings(game, teamName) {
  const gameId = ESPORTS_GAME_IDS[game] || game
  const norm = normalize(teamName)

  const res = await esportsGet('/teams/rankings', { game: gameId, per_page: 50, page: 1 })
  const teams = res?.data || res?.teams || res?.rankings || (Array.isArray(res) ? res : [])

  return teams.find(t => {
    const n = normalize(t.name || t.team_name || t.teamName || '')
    return fuzzyMatch(n, norm)
  }) || null
}

// Fetch recent matches for a game, filter to those involving a specific team
async function fetchTeamRecentMatches(game, teamName, teamId) {
  const gameId = ESPORTS_GAME_IDS[game] || game
  const norm = normalize(teamName)

  const res = await esportsGet('/matches/recent', { game: gameId, per_page: 50, page: 1 })
  const all = res?.data || res?.matches || (Array.isArray(res) ? res : [])

  return all.filter(m => {
    // Match by team ID if we have it
    if (teamId) {
      const id1 = m.team1?.id || m.home_team?.id || m.radiant?.team_id
      const id2 = m.team2?.id || m.away_team?.id || m.dire?.team_id
      if (String(id1) === String(teamId) || String(id2) === String(teamId)) return true
    }
    // Fallback: fuzzy name match
    const t1 = normalize(m.team1?.name || m.home_team?.name || m.radiant?.name || '')
    const t2 = normalize(m.team2?.name || m.away_team?.name || m.dire?.name || '')
    return fuzzyMatch(t1, norm) || fuzzyMatch(t2, norm)
  })
}

// Format recent match results into readable string
function formatMatches(matches, teamName, teamId) {
  if (!matches.length) return null
  const norm = normalize(teamName)
  return matches.slice(0, 7).map(m => {
    const t1name = m.team1?.name || m.home_team?.name || m.radiant?.name || '?'
    const t2name = m.team2?.name || m.away_team?.name || m.dire?.name || '?'
    const t1id = String(m.team1?.id || m.home_team?.id || m.radiant?.team_id || '')
    const t1score = m.team1?.score ?? m.team1_score ?? m.radiant_score ?? '?'
    const t2score = m.team2?.score ?? m.team2_score ?? m.dire_score ?? '?'
    const isT1 = (teamId && t1id === String(teamId)) || fuzzyMatch(normalize(t1name), norm)
    const opponent = isT1 ? t2name : t1name
    const myScore = isT1 ? t1score : t2score
    const oppScore = isT1 ? t2score : t1score
    const win = Number(myScore) > Number(oppScore)
    const tournament = m.tournament?.name || m.league?.name || m.event?.name || ''
    return `${win ? 'W' : 'L'} vs ${opponent} ${myScore}:${oppScore}${tournament ? ` [${tournament}]` : ''}`
  }).join(' | ')
}

// Get team details (roster) by team ID → GET /teams/{id}
async function fetchTeamRoster(teamId) {
  const res = await esportsGet(`/teams/${teamId}`)
  const team = res?.data || res?.team || res || null
  if (!team) return []

  const players = team.players || team.roster || team.members || []
  return players.map(p => ({
    name: p.name || p.nickname || p.tag || p.player?.name,
    role: p.role || p.position || null,
  })).filter(p => p.name)
}

// Search players by OCR-recognized name → GET /players/search
async function searchPlayers(game, names) {
  if (!names?.length) return []
  const gameId = ESPORTS_GAME_IDS[game] || game
  const results = []

  for (const name of names.slice(0, 5)) {
    try {
      const res = await esportsGet('/players/search', { game: gameId, name, per_page: 5, page: 1 })
      const players = res?.data || res?.players || (Array.isArray(res) ? res : [])
      if (players.length) {
        const p = players[0]
        results.push({
          name: p.name || p.nickname || name,
          role: p.role || p.position || null,
          team: p.team?.name || null,
        })
      }
    } catch { continue }
  }
  return results
}

// Get upcoming tournaments for context (tournament name enriches GPT prompt)
async function fetchUpcomingTournament(game) {
  const gameId = ESPORTS_GAME_IDS[game] || game
  const res = await esportsGet('/tournaments/upcoming', { game: gameId, per_page: 10, page: 1 })
  const list = res?.data || res?.tournaments || (Array.isArray(res) ? res : [])
  return list[0]?.name || null
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

// Esports context — real data from PandaScore (replaces dead esports-data.p.rapidapi.com)
router.post('/esports-context', authenticate, async (req, res) => {
  const { game, home, away } = req.body
  if (!home || !away || !game) return res.status(400).json({ error: 'game, home and away required' })

  const result = {
    homeResults: null,
    awayResults: null,
    homeRoster: [],
    awayRoster: [],
    homeRank: null,
    awayRank: null,
  }

  if (!process.env.PANDASCORE_TOKEN) {
    console.log('[esports-context] PANDASCORE_TOKEN not set — returning empty context')
    return res.json(result)
  }

  try {
    // Step 1: find both teams on PandaScore in parallel (response includes players[])
    const [homeTeam, awayTeam] = await Promise.all([
      findPSTeam(game, home).catch(err => { console.error('[esports-context] findPSTeam home:', err.message); return null }),
      findPSTeam(game, away).catch(err => { console.error('[esports-context] findPSTeam away:', err.message); return null }),
    ])

    const homeId = homeTeam?.id ?? null
    const awayId = awayTeam?.id ?? null

    // Step 2: fetch last 7 finished matches for each team in parallel
    const [homeMatches, awayMatches] = await Promise.all([
      homeId ? fetchPSRecentMatches(homeId, 7).catch(() => []) : Promise.resolve([]),
      awayId ? fetchPSRecentMatches(awayId, 7).catch(() => []) : Promise.resolve([]),
    ])

    result.homeResults = formatPSMatches(homeMatches, homeId)
    result.awayResults = formatPSMatches(awayMatches, awayId)

    // Step 3: extract roster from team.players[] (PandaScore includes active roster)
    if (homeTeam?.players?.length) {
      result.homeRoster = homeTeam.players
        .map(p => ({ name: p.name || p.first_name || null, role: p.role || null }))
        .filter(p => p.name)
    }
    if (awayTeam?.players?.length) {
      result.awayRoster = awayTeam.players
        .map(p => ({ name: p.name || p.first_name || null, role: p.role || null }))
        .filter(p => p.name)
    }

    console.log(`[esports-context] ${home}(id:${homeId}) vs ${away}(id:${awayId}) [${game}]: ` +
      `homeMatches=${homeMatches.length}, awayMatches=${awayMatches.length}, ` +
      `homeRoster=${result.homeRoster.length}, awayRoster=${result.awayRoster.length}`)
    res.json(result)
  } catch (err) {
    console.error('[esports-context] error:', err.message)
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

module.exports = router
