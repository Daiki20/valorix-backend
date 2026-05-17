const express = require('express')
const router = express.Router()
const https = require('https')
const auth = require('../middleware/auth')

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

router.post('/chat', auth, async (req, res) => {
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
