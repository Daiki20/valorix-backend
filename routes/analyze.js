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
          const parsed = JSON.parse(data)
          resolve(parsed.choices[0].message.content)
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

async function fetchTeamInjuries(teamName) {
  if (!process.env.RAPIDAPI_KEY) return []
  try {
    // Search team by name
    const teamsRes = await rapidGet('/football-search-teams', { query: teamName })
    const teams = teamsRes?.response || []
    const team = teams[0]
    if (!team?.id) return []

    // Get squad with injury status
    const squadRes = await rapidGet('/football-team-players', { teamId: team.id })
    const players = squadRes?.response || []

    return players
      .filter(p => p.injured === true)
      .map(p => p.name)
      .filter(Boolean)
  } catch {
    return []
  }
}

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

router.post('/injuries', authenticate, async (req, res) => {
  const { home, away } = req.body
  if (!home || !away) return res.status(400).json({ error: 'home and away required' })
  try {
    const [homeInjured, awayInjured] = await Promise.all([
      fetchTeamInjuries(home).catch(() => []),
      fetchTeamInjuries(away).catch(() => []),
    ])
    res.json({ home: homeInjured, away: awayInjured })
  } catch (err) {
    res.json({ home: [], away: [] })
  }
})

module.exports = router
