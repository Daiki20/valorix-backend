/**
 * Локальный тест: API-Football → GPT анализ
 * Запуск: node test-football-api.js "Хорватия" "Гана"
 *
 * Нужно: RAPIDAPI_KEY и OPENAI_API_KEY в .env или переменных окружения
 */
require('dotenv').config()
const https = require('https')

const HOME = process.argv[2] || 'Croatia'
const AWAY = process.argv[3] || 'Ghana'

const APIFOOTBALL_KEY = process.env.APIFOOTBALL_KEY
const OPENAI_KEY      = process.env.OPENAI_API_KEY

if (!APIFOOTBALL_KEY) { console.error('❌ APIFOOTBALL_KEY not set'); process.exit(1) }
if (!OPENAI_KEY)      { console.error('❌ OPENAI_API_KEY not set'); process.exit(1) }

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function apiFootball(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'v3.football.api-sports.io',
      path,
      method: 'GET',
      headers: {
        'x-apisports-key': APIFOOTBALL_KEY,
      },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function openAI(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'gpt-4o',
      messages,
      max_tokens: 1000,
      temperature: 0.3,
    })
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          resolve(json.choices?.[0]?.message?.content || '')
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── Data fetchers ─────────────────────────────────────────────────────────────
async function findTeam(name) {
  console.log(`🔍 Ищу команду: ${name}`)
  const res = await apiFootball(`/teams?search=${encodeURIComponent(name)}`)
  console.log(`   RAW response:`, JSON.stringify(res).slice(0, 300))
  const results = res.response || []
  if (!results.length) throw new Error(`Команда не найдена: ${name}`)
  console.log(`   Найдено вариантов: ${results.length}`)
  results.forEach((r, i) => console.log(`   ${i+1}. ${r.team.name} (id=${r.team.id}, страна=${r.team.country})`))
  const team = results[0].team
  console.log(`   ✓ Выбрана: ${team.name}`)
  return team
}

async function getLastMatches(teamId, teamName, count = 5) {
  const res = await apiFootball(`/fixtures?team=${teamId}&last=${count}`)
  const fixtures = res.response || []
  console.log(`   📊 ${teamName}: ${fixtures.length} матчей найдено`)
  return fixtures.map(f => {
    const home = f.teams.home
    const away = f.teams.away
    const goals = f.goals
    const isHome = home.id === teamId
    return {
      date: f.fixture.date?.slice(0, 10),
      home: home.name,
      away: away.name,
      score: `${goals.home}:${goals.away}`,
      result: isHome
        ? (home.winner ? 'W' : away.winner ? 'L' : 'D')
        : (away.winner ? 'W' : home.winner ? 'L' : 'D'),
      league: f.league.name,
    }
  })
}

async function getH2H(teamId1, teamId2) {
  const res = await apiFootball(`/fixtures/headtohead?h2h=${teamId1}-${teamId2}&last=8`)
  const fixtures = res.response || []
  console.log(`   🤝 H2H: ${fixtures.length} матчей`)
  return fixtures.map(f => ({
    date: f.fixture.date?.slice(0, 10),
    home: f.teams.home.name,
    away: f.teams.away.name,
    score: `${f.goals.home}:${f.goals.away}`,
  }))
}

// ── Format stats for GPT ──────────────────────────────────────────────────────
function formatMatches(matches, teamName) {
  if (!matches.length) return `${teamName}: нет данных`
  return `${teamName} (последние матчи):\n` +
    matches.map(m => `  ${m.date} | ${m.home} vs ${m.away} — ${m.score} (${m.result}) | ${m.league}`).join('\n')
}

function formatH2H(h2h, home, away) {
  if (!h2h.length) return 'Очные встречи: нет данных'
  return `Очные встречи ${home} vs ${away}:\n` +
    h2h.map(m => `  ${m.date} | ${m.home} vs ${m.away} — ${m.score}`).join('\n')
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n⚽ Анализ: ${HOME} vs ${AWAY}\n`)

  const delay = ms => new Promise(r => setTimeout(r, ms))

  // 1. Найти команды (последовательно — rate limit)
  const homeTeam = await findTeam(HOME)
  await delay(1000)
  const awayTeam = await findTeam(AWAY)

  // 2. Получить статистику (последовательно)
  console.log('\n📥 Получаю статистику...')
  const homeMatches = await getLastMatches(homeTeam.id, homeTeam.name)
  await delay(1000)
  const awayMatches = await getLastMatches(awayTeam.id, awayTeam.name)
  await delay(1000)
  const h2h = await getH2H(homeTeam.id, awayTeam.id)

  // 3. Сформировать контекст
  const statsBlock = [
    formatMatches(homeMatches, homeTeam.name),
    '',
    formatMatches(awayMatches, awayTeam.name),
    '',
    formatH2H(h2h, homeTeam.name, awayTeam.name),
  ].join('\n')

  console.log('\n📋 Данные из API:\n')
  console.log(statsBlock)

  // 4. Отправить в GPT
  console.log('\n🤖 Отправляю в GPT-4o...\n')

  const result = await openAI([
    {
      role: 'system',
      content: 'Ты профессиональный беттинг-аналитик. Тебе предоставлена РЕАЛЬНАЯ статистика из API. Используй ТОЛЬКО эти данные — не выдумывай факты. Если данных недостаточно — так и скажи.',
    },
    {
      role: 'user',
      content: `Проанализируй матч ${homeTeam.name} vs ${awayTeam.name}.

РЕАЛЬНАЯ СТАТИСТИКА ИЗ API:
${statsBlock}

Дай прогноз по ставкам:
1. Тотал голов (ТБ 2.5 или ТМ 2.5) — с обоснованием через среднее голов
2. Обе забьют (Да/Нет)
3. Победитель или Х

Для каждой ставки укажи уверенность в % и почему.`,
    },
  ])

  console.log('═'.repeat(60))
  console.log('📊 РЕЗУЛЬТАТ АНАЛИЗА:')
  console.log('═'.repeat(60))
  console.log(result)
  console.log('═'.repeat(60))
}

main().catch(err => {
  console.error('❌ Ошибка:', err.message)
  process.exit(1)
})
