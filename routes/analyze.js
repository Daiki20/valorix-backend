const express = require('express')
const router = express.Router()
const https = require('https')
const { authenticate } = require('../middleware/auth')

const RAPIDAPI_HOST = 'free-api-live-football-data.p.rapidapi.com'

function callOpenAI(messages, max_tokens = 1200) {
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
        if (res.statusCode !== 200) {
          reject(new Error(`OpenAI ${res.statusCode}: ${data}`))
          return
        }
        try {
          resolve(JSON.parse(data).choices[0].message.content)
        } catch (e) {
          reject(new Error('OpenAI parse error'))
        }
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
        try { resolve(JSON.parse(data)) } catch { reject(new Error('RapidAPI parse error')) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// Search team by name → return team object
async function searchTeam(name) {
  const res = await rapidGet('/football-search-teams', { query: name })
  return res?.response?.[0] || null
}

// Get upcoming fixtures for a team → find match vs opponent
async function findFixture(homeTeamId, awayTeamId) {
  const res = await rapidGet('/football-fixtures-team', { teamId: homeTeamId, next: 10 })
  const fixtures = res?.response || []
  return fixtures.find(f =>
    f.teams?.away?.id === awayTeamId || f.teams?.home?.id === awayTeamId
  ) || null
}

// Get lineups for a fixture
async function fetchLineups(fixtureId) {
  const res = await rapidGet('/football-fixture-lineups', { fixtureId })
  const lineups = res?.response || []
  const result = {}
  for (const side of lineups) {
    const teamName = side.team?.name
    if (!teamName) continue
    result[teamName] = {
      formation: side.formation || null,
      startXI: (side.startXI || []).map(p => p.player?.name).filter(Boolean),
      substitutes: (side.substitutes || []).map(p => p.player?.name).filter(Boolean),
    }
  }
  return result
}

// Get team's standing in the league
async function fetchStanding(teamId, leagueId, season) {
  const res = await rapidGet('/football-league-standings', { leagueId, season })
  const standings = res?.response?.[0]?.league?.standings?.[0] || []
  return standings.find(s => s.team?.id === teamId) || null
}

// Get last 5 results for a team
async function fetchRecentForm(teamId) {
  const res = await rapidGet('/football-fixtures-team', { teamId, last: 5 })
  const fixtures = res?.response || []
  return fixtures.map(f => {
    const isHome = f.teams?.home?.id === teamId
    const homeGoals = f.goals?.home
    const awayGoals = f.goals?.away
    if (homeGoals === null || awayGoals === null) return null
    if (isHome) return homeGoals > awayGoals ? 'W' : homeGoals < awayGoals ? 'L' : 'D'
    return awayGoals > homeGoals ? 'W' : awayGoals < homeGoals ? 'L' : 'D'
  }).filter(Boolean)
}

// Get injured players for a team
async function fetchInjuries(teamId) {
  const res = await rapidGet('/football-team-players', { teamId })
  const players = res?.response || []
  return players
    .filter(p => p.injured === true)
    .map(p => p.name)
    .filter(Boolean)
}

// Main context endpoint — returns everything in one call
router.post('/context', authenticate, async (req, res) => {
  const { home, away } = req.body
  if (!home || !away) return res.status(400).json({ error: 'home and away required' })
  if (!process.env.RAPIDAPI_KEY) return res.json({})

  try {
    // Step 1: find both teams
    const [homeTeam, awayTeam] = await Promise.all([
      searchTeam(home).catch(() => null),
      searchTeam(away).catch(() => null),
    ])

    const result = {
      homeInjured: [],
      awayInjured: [],
      homeForm: [],
      awayForm: [],
      homeStanding: null,
      awayStanding: null,
      lineups: {},
    }

    if (!homeTeam?.id || !awayTeam?.id) return res.json(result)

    const homeId = homeTeam.id
    const awayId = awayTeam.id

    // Step 2: get fixture + injuries + form in parallel
    const [fixture, homeInjured, awayInjured, homeForm, awayForm] = await Promise.all([
      findFixture(homeId, awayId).catch(() => null),
      fetchInjuries(homeId).catch(() => []),
      fetchInjuries(awayId).catch(() => []),
      fetchRecentForm(homeId).catch(() => []),
      fetchRecentForm(awayId).catch(() => []),
    ])

    result.homeInjured = homeInjured
    result.awayInjured = awayInjured
    result.homeForm = homeForm
    result.awayForm = awayForm

    if (fixture) {
      const fixtureId = fixture.fixture?.id
      const leagueId = fixture.league?.id
      const season = fixture.league?.season

      // Step 3: get lineups + standings in parallel
      const [lineups, homeStanding, awayStanding] = await Promise.all([
        fixtureId ? fetchLineups(fixtureId).catch(() => ({})) : {},
        leagueId ? fetchStanding(homeId, leagueId, season).catch(() => null) : null,
        leagueId ? fetchStanding(awayId, leagueId, season).catch(() => null) : null,
      ])

      result.lineups = lineups
      result.homeStanding = homeStanding
      result.awayStanding = awayStanding
    }

    res.json(result)
  } catch (err) {
    console.error('Context error:', err.message)
    res.json({})
  }
})

router.post('/chat', authenticate, async (req, res) => {
  const { messages, max_tokens = 1200 } = req.body
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages required' })
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'OpenAI API key not configured' })
  }
  try {
    const content = await callOpenAI(messages, max_tokens)
    res.json({ content })
  } catch (err) {
    console.error('OpenAI error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
