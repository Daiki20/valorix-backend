const express = require('express')
const https = require('https')
const zlib = require('zlib')
const router = express.Router()

const SSTATS_BASE = 'https://api.sstats.net'

let upcomingCache = { data: null, ts: 0 }
let liveCache = { data: null, ts: 0 }
let hockeyCache = { data: null, ts: 0 }
let basketballCache = { data: null, ts: 0 }
let esportsCache = { data: null, ts: 0 }
const UPCOMING_TTL = 15 * 60 * 1000
const LIVE_TTL = 60 * 1000
const HOCKEY_TTL = 3 * 60 * 60 * 1000   // 3 hours — preserve AllSportsApi2 daily quota
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

// ── Sofascore direct API (free, no key, no quota) ────────────────────────────
// Same data that AllSportsApi2 mirrors. Use as fallback when RapidAPI quota exceeded.
// Path format: /api/v1/unique-tournament/{id}/season/{sid}/events/next/0
function sofascoreGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.sofascore.com',
      path,
      method: 'GET',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.sofascore.com/',
        'Origin': 'https://www.sofascore.com',
        'Cache-Control': 'no-cache',
      },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        if (res.statusCode === 403 || res.statusCode === 429) {
          reject(new Error(`Sofascore HTTP ${res.statusCode}`)); return
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

// ── AllSportsApi helper (direct path) ────────────────────────────────────────
// Uses Sofascore-mirrored tournament endpoints. Format:
//   /api/tournament/{id}/season/{sid}/matches/next/0
// If RAPIDAPI_KEY quota is exceeded, retries with ICEHOCKEY_API_KEY (separate account)
function rapidApiGet(host, path, apiKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      path,
      method: 'GET',
      timeout: 8000,
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': host,
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

function isQuotaError(data) {
  const msg = data?.message || ''
  return msg.includes('exceeded') && (msg.includes('quota') || msg.includes('Requests'))
}

async function allSportsGetPath(path) {
  const primaryKey = process.env.RAPIDAPI_KEY
  const secondaryKey = process.env.ICEHOCKEY_API_KEY
  const host = 'allsportsapi2.p.rapidapi.com'

  if (primaryKey) {
    const data = await rapidApiGet(host, path, primaryKey)
    if (!isQuotaError(data)) return data
    console.warn('[allsports] primary RAPIDAPI_KEY quota exceeded — trying ICEHOCKEY_API_KEY')
  }
  if (secondaryKey && secondaryKey !== primaryKey) {
    const data = await rapidApiGet(host, path, secondaryKey)
    if (!isQuotaError(data)) return data
    console.warn('[allsports] secondary ICEHOCKEY_API_KEY also quota exceeded')
  }
  // Both keys exhausted — return empty so caller can try next source
  return {}
}

// Legacy helper for basketball (uses old endpoint format)
async function allSportsGet(sport, endpoint) {
  return allSportsGetPath(`/api/${sport}/${endpoint}`)
}

// IceHockeyApi helper — uses ICEHOCKEY_API_KEY (or fallback RAPIDAPI_KEY)
function iceHockeyGet(path) {
  const key = process.env.ICEHOCKEY_API_KEY || process.env.RAPIDAPI_KEY
  if (!key) return Promise.reject(new Error('No RAPIDAPI_KEY'))
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'icehockeyapi.p.rapidapi.com',
      path,
      method: 'GET',
      timeout: 8000,
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': 'icehockeyapi.p.rapidapi.com',
        'Accept': 'application/json',
      },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { reject(new Error('JSON parse error')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

// ── Hockey tournament config ──────────────────────────────────────────────────
// fallbackSeasonId = hardcoded 2025/26 season IDs (from Sofascore) used when APIs are down
const HOCKEY_TOURNAMENTS_BASE = [
  { id: 3,    league: 'ИИХФ · Чемпионат мира', fallbackSeasonId: 81043 },
  { id: 268,  league: 'КХЛ',                    fallbackSeasonId: 77998 },
  { id: 1159, league: 'МХЛ',                    fallbackSeasonId: 79945 },
  { id: 1141, league: 'ВХЛ',                    fallbackSeasonId: 78633 },
]

// Cache season IDs 24h — they don't change within a day, saves daily quota
const seasonIdCache = new Map()   // tournamentId → { seasonId, ts }
const SEASON_ID_TTL = 24 * 60 * 60 * 1000

// Fetch current season ID: IceHockeyApi → AllSportsApi2 → Sofascore direct → hardcoded fallback
async function fetchCurrentSeasonId(tournamentId, fallbackSeasonId) {
  const cached = seasonIdCache.get(tournamentId)
  if (cached && Date.now() - cached.ts < SEASON_ID_TTL) return cached.seasonId

  // Sort seasons by id desc (highest id = most recent) then year desc
  const pickLatest = (seasons) => {
    if (!seasons?.length) return null
    return seasons.sort((a, b) => {
      const yearA = String(a.year || '').replace('/', '').replace('-', '')
      const yearB = String(b.year || '').replace('/', '').replace('-', '')
      const yearDiff = (Number(yearB) || 0) - (Number(yearA) || 0)
      return yearDiff !== 0 ? yearDiff : (Number(b.id) || 0) - (Number(a.id) || 0)
    })[0]?.id || null
  }

  const sources = [
    // IceHockeyApi — same RAPIDAPI_KEY, hockey-specific host (endpoint may not exist)
    ['icehockeyapi', () => iceHockeyGet(`/api/tournament/${tournamentId}/seasons`)],
    // AllSportsApi2 — primary Sofascore mirror (has daily quota limit)
    ['allsportsapi2', () => allSportsGetPath(`/api/tournament/${tournamentId}/seasons`)],
    // Sofascore direct — free, no quota, original data source
    ['sofascore',    () => sofascoreGet(`/api/v1/unique-tournament/${tournamentId}/seasons`)],
  ]

  for (const [label, fetchFn] of sources) {
    try {
      const data = await fetchFn()
      const seasonId = pickLatest(data?.seasons || data?.uniqueTournamentSeasons || [])
      if (seasonId) {
        seasonIdCache.set(tournamentId, { seasonId, ts: Date.now() })
        console.log(`[matches/hockey] T=${tournamentId} season ${seasonId} via ${label}`)
        return seasonId
      }
    } catch (err) {
      console.warn(`[matches/hockey] fetchCurrentSeasonId(${tournamentId}) ${label} failed: ${err.message}`)
    }
  }

  // Last resort: use hardcoded 2025/26 season ID
  if (fallbackSeasonId) {
    console.warn(`[matches/hockey] T=${tournamentId} using hardcoded fallback season ${fallbackSeasonId}`)
    return fallbackSeasonId
  }
  return null
}

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
  'Neftekhimik Nizhnekamsk': 'Нефтехимик', 'Sibir Novosibirsk': 'Сибирь',
  'HC Amur': 'Амур', 'HC Torpedo': 'Торпедо', 'HC Traktor': 'Трактор',
  'HC Spartak': 'Спартак', 'HC Avangard': 'Авангард', 'HC Admiral': 'Адмирал',
  // МХЛ
  'Loko Yaroslavl': 'Локо Ярославль', 'Loko': 'Локо',
  'Krasnaya Armiya': 'Красная Армия', 'Red Army': 'Красная Армия',
  'SKA-Neva': 'СКА-Нева', 'SKA-1946': 'СКА-1946',
  'Stalnye Lisy': 'Стальные Лисы', 'Reaktor': 'Реактор',
  'Serebryanye Lvy': 'Серебряные Львы', 'Ак Барс-Зилант': 'Ак Барс-Зилант',
  'Ak Bars-Zilant': 'Ак Барс-Зилант', 'HK Ryazan': 'ХК Рязань',
  'Chayka': 'Чайка', 'Atlant': 'Атлант', 'Yuzhny Ural': 'Южный Урал',
  'Russkie Vityazi': 'Русские Витязи', 'Michurinsky Lokomotiv': 'Лок. Мичуринск',
  'Belye Medvedi': 'Белые Медведи', 'Dynamo SPb': 'Динамо СПб',
  'Toros': 'Торос', 'Irbis': 'Ирбис', 'Bars': 'Барс',
  // ВХЛ
  'Neftyanik': 'Нефтяник', 'Rubin': 'Рубин', 'Dizel': 'Дизель',
  'Sokol': 'Сокол', 'Buran': 'Буран', 'Metallurg': 'Металлург',
  'Kristall': 'Кристалл', 'Zауралье': 'Зауралье', 'Zауrаlye': 'Зауралье',
  'Zauralie': 'Зауралье', 'Molot-Prikamye': 'Молот-Прикамье',
  'HK Lipetsk': 'ХК Липецк', 'Khimik': 'Химик',
  'Ugra Khanty-Mansiysk': 'Югра', 'Ugra': 'Югра',
  'HC Khimik': 'Химик Воскресенск', 'Voskresensk': 'Воскресенск',
}

// ИИХФ: национальные сборные
const IIHF_TEAMS_RU = {
  'Canada': 'Канада', 'Russia': 'Россия', 'Finland': 'Финляндия',
  'Sweden': 'Швеция', 'USA': 'США', 'United States': 'США',
  'Czech Republic': 'Чехия', 'Czechia': 'Чехия', 'Slovakia': 'Словакия',
  'Switzerland': 'Швейцария', 'Germany': 'Германия', 'Latvia': 'Латвия',
  'Denmark': 'Дания', 'Norway': 'Норвегия', 'France': 'Франция',
  'Austria': 'Австрия', 'Hungary': 'Венгрия', 'Slovenia': 'Словения',
  'Great Britain': 'Великобритания', 'Kazakhstan': 'Казахстан',
  'Belarus': 'Беларусь', 'Poland': 'Польша', 'Italy': 'Италия',
  'Japan': 'Япония', 'South Korea': 'Ю. Корея', 'Ukraine': 'Украина',
  'Lithuania': 'Литва', 'Estonia': 'Эстония', 'Romania': 'Румыния',
}

function translateHockeyTeam(name) {
  // ИИХФ национальные сборные — точное совпадение
  if (IIHF_TEAMS_RU[name]) return IIHF_TEAMS_RU[name]
  // КХЛ/ВХЛ/МХЛ — подстрока
  for (const [en, ru] of Object.entries(KHL_TEAMS_RU)) {
    if (name.includes(en)) return ru
  }
  return name
}

// Sofascore CDN team image URL
function sofascoreTeamImg(teamId) {
  if (!teamId) return null
  return `https://api.sofascore.com/api/v1/team/${teamId}/image`
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

  const homeTeamId = event.homeTeam?.id
  const awayTeamId = event.awayTeam?.id
  return {
    id: `as_${event.id || Math.random()}`,
    eventId: event.id,
    homeTeamId,
    awayTeamId,
    tournamentId,
    seasonId,
    homeEn: home,   // original English name — used for odds API lookup
    awayEn: away,
    home: translateHockeyTeam(home),
    away: translateHockeyTeam(away),
    // Relative path — frontend prepends API_BASE so backend proxies the image
    homeImg: homeTeamId ? `/matches/team-logo/${homeTeamId}` : null,
    awayImg: awayTeamId ? `/matches/team-logo/${awayTeamId}` : null,
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
        const homeEnName = `${game.homeTeam?.placeName?.default || ''} ${game.homeTeam?.commonName?.default || ''}`.trim() || homeAbbr
        const awayEnName = `${game.awayTeam?.placeName?.default || ''} ${game.awayTeam?.commonName?.default || ''}`.trim() || awayAbbr
        const home = NHL_TEAMS[homeAbbr] || homeEnName
        const away = NHL_TEAMS[awayAbbr] || awayEnName
        const isLive = state === 'LIVE' || state === 'CRIT'
        // NHL logos: use API-provided URL, fallback to NHL CDN
        const homeImg = game.homeTeam?.logo ||
          (homeAbbr ? `https://assets.nhle.com/logos/nhl/svg/${homeAbbr}_dark.svg` : null)
        const awayImg = game.awayTeam?.logo ||
          (awayAbbr ? `https://assets.nhle.com/logos/nhl/svg/${awayAbbr}_dark.svg` : null)
        games.push({
          id: `nhl_${game.id}`,
          homeEn: homeEnName, awayEn: awayEnName,
          home, away,
          homeImg, awayImg,
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

  // 2. AllSportsApi — dynamic season IDs (fetched fresh each day, always current)
  if (process.env.RAPIDAPI_KEY) {
    // Fetch current season IDs for all tournaments in parallel
    const tournamentsWithSeasons = await Promise.all(
      HOCKEY_TOURNAMENTS_BASE.map(async t => {
        const seasonId = await fetchCurrentSeasonId(t.id, t.fallbackSeasonId)
        return { ...t, seasonId }
      })
    )

    const validTournaments = tournamentsWithSeasons.filter(t => t.seasonId)
    console.log(`[matches/hockey] tournaments with valid seasons: ${validTournaments.map(t => `${t.league}(${t.seasonId})`).join(', ')}`)

    // Fetch matches: IceHockeyApi → AllSportsApi2 → Sofascore direct (free fallback)
    async function fetchTournamentMatches(t) {
      const rapidPath = `/api/tournament/${t.id}/season/${t.seasonId}/matches/next/0`
      const sofaPath  = `/api/v1/unique-tournament/${t.id}/season/${t.seasonId}/events/next/0`
      for (const [label, fetchFn] of [
        ['icehockeyapi', () => iceHockeyGet(rapidPath)],
        ['allsportsapi2', () => allSportsGetPath(rapidPath)],
        ['sofascore',    () => sofascoreGet(sofaPath)],
      ]) {
        try {
          const data = await fetchFn()
          const evts = data?.events || []
          if (evts.length > 0 || label === 'sofascore') {
            console.log(`[matches/hockey] T=${t.id} "${t.league}" s=${t.seasonId} via ${label}: ${evts.length} events`)
            return { ...t, events: evts }
          }
        } catch (err) {
          console.warn(`[matches/hockey] ${label} T=${t.id} failed: ${err.message}`)
        }
      }
      return { ...t, events: [] }
    }

    const results = await Promise.allSettled(
      validTournaments.map(t => fetchTournamentMatches(t))
    )

    for (const r of results) {
      if (r.status !== 'fulfilled') {
        console.error('[matches/hockey] AllSportsApi rejected:', r.reason?.message)
        continue
      }
      const { id: tournamentId, seasonId, league, events } = r.value
      let added = 0
      for (const event of events) {
        const normalized = normalizeSofascoreMatch(event, league, tournamentId, seasonId)
        if (!normalized) continue
        if (games.some(g => g.home === normalized.home && g.away === normalized.away)) continue
        games.push(normalized)
        added++
      }
      if (added > 0) console.log(`[matches/hockey] ${league}: ${added}/${events.length} added`)
    }
    console.log(`[matches/hockey] AllSportsApi total: ${games.length} games`)
  } else {
    console.log('[matches/hockey] RAPIDAPI_KEY not set — only NHL free API available')
  }

  // ── Overlay real bookmaker odds ────────────────────────────────────────────────
  // Priority: Pinnacle → API-Hockey → The Odds API (fallback)
  if (games.length > 0) {
    let oddsMap = {}

    // 1. Pinnacle Betting Odds — covers ИИХФ WC + KHL + NHL, sharp real odds
    if (process.env.RAPIDAPI_KEY) {
      try {
        oddsMap = await fetchPinnacleHockeyOdds()
      } catch (err) {
        console.warn('[matches/hockey] pinnacle odds failed:', err.message)
      }
    }

    // 2. API-Hockey (api-sports) — fallback if Pinnacle returned nothing
    if (!Object.keys(oddsMap).length && process.env.RAPIDAPI_KEY) {
      try {
        oddsMap = await fetchApiHockeyOdds()
        if (Object.keys(oddsMap).length) console.log('[matches/hockey] using API-Hockey as fallback')
      } catch (err) {
        console.warn('[matches/hockey] api-hockey fallback failed:', err.message)
      }
    }

    // 3. The Odds API — last resort (NHL/KHL/SHL only)
    if (!Object.keys(oddsMap).length && process.env.ODDS_API_KEY) {
      try {
        oddsMap = await fetchHockeyOdds()
        if (Object.keys(oddsMap).length) console.log('[matches/hockey] using The Odds API as last resort')
      } catch (err) {
        console.warn('[matches/hockey] odds-api fallback failed:', err.message)
      }
    }

    if (Object.keys(oddsMap).length) {
      let oddsOverlaid = 0
      for (const game of games) {
        const odds = lookupOdds(game.homeEn || game.home, game.awayEn || game.away, oddsMap)
        if (odds) { game.odds1x2 = odds; oddsOverlaid++ }
      }
      console.log(`[matches/hockey] overlaid odds on ${oddsOverlaid}/${games.length} matches`)
    }
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
    homeSeasonStats: null,
    awaySeasonStats: null,
  }

  // ── IceHockeyApi: season stats (PP%, PK%, goals per game, shots) ─────────────
  if (process.env.RAPIDAPI_KEY && seasonId) {
    const [homeStatsRes, awayStatsRes] = await Promise.all([
      iceHockeyGet(`/api/hockey/team/${homeId}/statistics/season/${seasonId}`).catch(() => null),
      iceHockeyGet(`/api/hockey/team/${awayId}/statistics/season/${seasonId}`).catch(() => null),
    ])
    if (homeStatsRes?.statistics) data.homeSeasonStats = homeStatsRes.statistics
    if (awayStatsRes?.statistics) data.awaySeasonStats = awayStatsRes.statistics
    console.log(`[matches/hockey-stats] season stats: home=${!!data.homeSeasonStats} away=${!!data.awaySeasonStats}`)
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

// ── The Odds API (the-odds-api.com) — esports h2h coefficients ───────────────
// Free: 500 req/month.  Register at https://the-odds-api.com → add ODDS_API_KEY to Railway.
// Covered esports sports: esports_csgo, esports_lol (dota2 not on free-tier list).
let esportsOddsCache = { data: null, ts: 0 }
const ESPORTS_ODDS_TTL = 4 * 60 * 60 * 1000   // 4 hours — conserves monthly quota

function oddsApiGet(sport) {
  const apiKey = process.env.ODDS_API_KEY
  if (!apiKey) return Promise.reject(new Error('No ODDS_API_KEY'))
  const qs = new URLSearchParams({
    apiKey,
    regions: 'eu',
    markets: 'h2h',
    oddsFormat: 'decimal',
  }).toString()
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.the-odds-api.com',
      path: `/v4/sports/${sport}/odds/?${qs}`,
      method: 'GET',
      timeout: 10000,
      headers: { 'Accept': 'application/json' },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        if (res.statusCode === 401) { reject(new Error('Invalid ODDS_API_KEY')); return }
        if (res.statusCode === 422) { reject(new Error(`Sport not available: ${sport}`)); return }
        if (res.statusCode !== 200) {
          console.error(`[odds-api] ${sport} → HTTP ${res.statusCode}: ${data.slice(0, 200)}`)
          reject(new Error(`odds-api HTTP ${res.statusCode}`)); return
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

// Average h2h prices across bookmakers for one event
function extractOddsApiOdds(event) {
  if (!event?.bookmakers?.length) return null
  const buckets = {}  // team name → [prices]
  for (const bm of event.bookmakers) {
    const market = bm.markets?.find(m => m.key === 'h2h')
    if (!market) continue
    for (const o of (market.outcomes || [])) {
      if (!buckets[o.name]) buckets[o.name] = []
      buckets[o.name].push(o.price)
    }
  }
  const names = Object.keys(buckets)
  if (names.length < 2) return null
  const avg = arr => parseFloat((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2))
  const result = {}
  for (const name of names) result[name] = avg(buckets[name])
  return result
}

const _normOdds = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

// Build lookup: normalizedTeamName → { homeOdds, awayOdds, homeNorm, awayNorm }
function buildOddsLookup(events) {
  const map = {}
  for (const ev of events) {
    const prices = extractOddsApiOdds(ev)
    if (!prices) continue
    const hOdds = prices[ev.home_team]
    const aOdds = prices[ev.away_team]
    if (!hOdds || !aOdds) continue
    const hN = _normOdds(ev.home_team)
    const aN = _normOdds(ev.away_team)
    const entry = { homeOdds: hOdds, awayOdds: aOdds, homeNorm: hN, awayNorm: aN }
    map[hN] = entry
    map[aN] = entry
  }
  return map
}

// Match team names against odds lookup; return odds1x2 or null
function lookupOdds(psHome, psAway, oddsMap) {
  if (!oddsMap || !Object.keys(oddsMap).length) return null
  const hN = _normOdds(psHome)
  const aN = _normOdds(psAway)
  // Guard: if names normalized to empty (e.g. Cyrillic), skip — avoids false matches
  if (!hN || !aN) return null
  // Exact lookup
  let entry = oddsMap[hN] || oddsMap[aN]
  // Substring fallback
  if (!entry) {
    const key = Object.keys(oddsMap).find(k =>
      k.includes(hN) || hN.includes(k) || k.includes(aN) || aN.includes(k)
    )
    if (key) entry = oddsMap[key]
  }
  if (!entry) return null
  const isHomeSide = entry.homeNorm.includes(hN) || hN.includes(entry.homeNorm)
  return {
    home: isHomeSide ? entry.homeOdds : entry.awayOdds,
    away: isHomeSide ? entry.awayOdds : entry.homeOdds,
    draw: null,
  }
}

// ── Pinnacle Betting Odds (pinnacle-betting-odds.p.rapidapi.com) ─────────────
// Free: 550 req/month. Subscribe at https://rapidapi.com/tipsters/api/pinnacle-betting-odds
// Uses same RAPIDAPI_KEY. Covers IIHF WC + KHL + NHL (all Pinnacle markets).
function pinnacleGet(path) {
  const key = process.env.RAPIDAPI_KEY
  if (!key) return Promise.reject(new Error('No RAPIDAPI_KEY'))
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'pinnacle-betting-odds.p.rapidapi.com',
      path,
      method: 'GET',
      timeout: 12000,
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': 'pinnacle-betting-odds.p.rapidapi.com',
        'Accept': 'application/json',
      },
    }
    const req = https.request(options, res => {
      // Pinnacle API returns gzip-compressed JSON — decompress before parsing
      const encoding = res.headers['content-encoding']
      let stream = res
      if (encoding === 'gzip') {
        stream = res.pipe(zlib.createGunzip())
      } else if (encoding === 'deflate') {
        stream = res.pipe(zlib.createInflate())
      } else if (encoding === 'br') {
        stream = res.pipe(zlib.createBrotliDecompress())
      }

      let data = ''
      stream.on('data', c => data += c)
      stream.on('end', () => {
        if (res.statusCode !== 200) {
          console.warn(`[pinnacle] ${path} → HTTP ${res.statusCode}: ${data.slice(0, 200)}`)
          reject(new Error(`pinnacle HTTP ${res.statusCode}`)); return
        }
        try { resolve(JSON.parse(data)) }
        catch {
          console.warn(`[pinnacle] JSON parse failed for ${path}, status=${res.statusCode}, body: ${data.slice(0, 400)}`)
          reject(new Error('JSON parse error'))
        }
      })
      stream.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

// Cache sport/league IDs (never change, fetch once per process start)
let _pinnacleSportId   = null   // ice hockey sport_id
let _pinnacleLeagueIds = null   // { iihfWC, khl, nhl }

async function getPinnacleHockeySportId() {
  if (_pinnacleSportId) return _pinnacleSportId
  // sport_id=5 = Ice Hockey in pinnacle-betting-odds.p.rapidapi.com wrapper
  // (confirmed from their playground default value — NOT Pinnacle's standard 19)
  _pinnacleSportId = 5
  return _pinnacleSportId
}

async function getPinnacleHockeyLeagueIds() {
  if (_pinnacleLeagueIds) return _pinnacleLeagueIds

  const sportId = await getPinnacleHockeySportId()
  const FALLBACK = { iihfWC: null, khl: null, nhl: null }

  try {
    const data = await pinnacleGet(`/kit/v1/leagues?sport_id=${sportId}&is_have_odds=true`)
    // Log raw structure for one-time debug
    console.log('[pinnacle] leagues raw keys:', Object.keys(data || {}).join(', '))
    const leagues = data?.leagues || data?.data || (Array.isArray(data) ? data : [])
    if (!leagues.length) {
      console.log('[pinnacle] leagues: empty response — raw:', JSON.stringify(data).slice(0, 300))
      _pinnacleLeagueIds = FALLBACK; return FALLBACK
    }

    // Log ALL hockey leagues once for debugging
    console.log('[pinnacle] hockey leagues:', leagues.slice(0, 30).map(l =>
      `${l.id ?? l.league_id}: ${l.name ?? l.league_name}`).join(' | '))

    const find = (...parts) => {
      const l = leagues.find(lg => {
        const n = (lg.name || lg.league_name || '').toLowerCase()
        return parts.some(p => n.includes(p.toLowerCase()))
      })
      return l?.id ?? l?.league_id ?? null
    }

    _pinnacleLeagueIds = {
      iihfWC: find('world championship', 'iihf', 'world champ'),
      khl:    find('khl', 'kontinental'),
      nhl:    find('nhl') ?? find('national hockey league'),
    }
    console.log(`[pinnacle] league IDs: IIHF=${_pinnacleLeagueIds.iihfWC} KHL=${_pinnacleLeagueIds.khl} NHL=${_pinnacleLeagueIds.nhl}`)
  } catch (err) {
    console.warn('[pinnacle] league discovery failed:', err.message)
    _pinnacleLeagueIds = FALLBACK
  }
  return _pinnacleLeagueIds
}

// Parse Pinnacle /kit/v1/markets response → lookup map
function parsePinnacleMarkets(items) {
  const map = {}
  for (const item of (Array.isArray(items) ? items : [])) {
    // Multiple possible response shapes from the API wrapper
    const home = item.home ?? item.home_team ?? item.teams?.home?.name ?? item.homeTeam
    const away = item.away ?? item.away_team ?? item.teams?.away?.name ?? item.awayTeam
    if (!home || !away) continue

    // Extract moneyline odds — try every known path
    let hOdds = null, aOdds = null
    const ml = item.money_line ?? item.moneyline ?? item.periods?.num_0?.money_line
           ?? item.odds?.moneyline ?? item.markets?.moneyline
    if (ml) {
      hOdds = parseFloat(ml.home ?? ml.homeOdds ?? ml[home])
      aOdds = parseFloat(ml.away ?? ml.awayOdds ?? ml[away])
    }
    // Also try direct home/away odds on the item
    if (!hOdds) hOdds = parseFloat(item.homeOdds ?? item.home_odds)
    if (!aOdds) aOdds = parseFloat(item.awayOdds ?? item.away_odds)

    if (!hOdds || !aOdds || hOdds < 1 || aOdds < 1) continue

    const hN = _normOdds(home)
    const aN = _normOdds(away)
    if (!hN || !aN) continue

    const entry = { homeOdds: hOdds, awayOdds: aOdds, homeNorm: hN, awayNorm: aN }
    map[hN] = entry
    map[aN] = entry
  }
  return map
}

let pinnacleOddsCache = { data: null, ts: 0 }
const PINNACLE_ODDS_TTL = 6 * 60 * 60 * 1000  // 6 hours → ~120 req/month (well within 550 free limit)

async function fetchPinnacleHockeyOdds() {
  if (pinnacleOddsCache.data && Date.now() - pinnacleOddsCache.ts < PINNACLE_ODDS_TTL) {
    return pinnacleOddsCache.data
  }
  if (!process.env.RAPIDAPI_KEY) return {}

  const sportId    = await getPinnacleHockeySportId()
  const leagueIds  = await getPinnacleHockeyLeagueIds()

  const merged = {}
  const leaguesToFetch = [
    { id: leagueIds.iihfWC, label: 'IIHF WC' },
    { id: leagueIds.khl,    label: 'KHL' },
    { id: leagueIds.nhl,    label: 'NHL' },
  ].filter(l => l.id)   // skip leagues we couldn't discover

  // If league discovery failed, try fetching ALL hockey markets at once
  if (!leaguesToFetch.length) {
    try {
      const data = await pinnacleGet(
        `/kit/v1/markets?sport_id=${sportId}&is_have_odds=true&event_type=prematch`
      )
      const items = data?.markets ?? data?.data ?? data ?? []
      console.log(`[pinnacle] raw response keys: ${Object.keys(data || {}).join(', ')}`)
      console.log(`[pinnacle] all hockey: ${items.length} events, first item keys: ${Object.keys(items[0] || {}).join(', ')}`)
      const parsed = parsePinnacleMarkets(items)
      const count = Math.floor(Object.keys(parsed).length / 2)
      console.log(`[pinnacle/odds] all hockey: ${count} matches`)
      Object.assign(merged, parsed)
    } catch (err) {
      console.warn('[pinnacle/odds] all-hockey fetch failed:', err.message)
    }
  } else {
    for (const { id, label } of leaguesToFetch) {
      try {
        const qs = `/kit/v1/markets?sport_id=${sportId}&league_id=${id}&is_have_odds=true&event_type=prematch`
        const data = await pinnacleGet(qs)
        const items = data?.markets ?? data?.data ?? data ?? []
        const parsed = parsePinnacleMarkets(items)
        const count = Math.floor(Object.keys(parsed).length / 2)
        console.log(`[pinnacle/odds] ${label} (league=${id}): ${count} matches`)
        Object.assign(merged, parsed)
      } catch (err) {
        console.warn(`[pinnacle/odds] ${label} failed:`, err.message)
      }
    }
  }

  // Log first match for format debugging
  const keys = Object.keys(merged)
  if (keys.length) console.log(`[pinnacle/odds] sample: ${keys[0]} → ${JSON.stringify(merged[keys[0]])}`)

  pinnacleOddsCache = { data: merged, ts: Date.now() }
  console.log(`[pinnacle/odds] cached ${Math.floor(keys.length / 2)} total matches`)
  return merged
}

// ── Hockey odds (The Odds API) ────────────────────────────────────────────────
// icehockey_nhl, icehockey_khl — icehockey_shl removed (returns 404 Unknown sport)
let hockeyOddsCache = { data: null, ts: 0 }
const HOCKEY_ODDS_TTL = 6 * 60 * 60 * 1000   // 6 hours — conserves monthly quota
const HOCKEY_ODDS_SPORTS = ['icehockey_nhl', 'icehockey_khl']

async function fetchHockeyOdds() {
  if (hockeyOddsCache.data && Date.now() - hockeyOddsCache.ts < HOCKEY_ODDS_TTL) {
    return hockeyOddsCache.data
  }
  if (!process.env.ODDS_API_KEY) return {}
  const allEvents = []
  for (const sport of HOCKEY_ODDS_SPORTS) {
    try {
      const events = await oddsApiGet(sport)
      if (Array.isArray(events)) allEvents.push(...events)
      console.log(`[odds-api/hockey] ${sport}: ${Array.isArray(events) ? events.length : 0} events`)
    } catch (err) {
      console.warn(`[odds-api/hockey] ${sport} failed: ${err.message}`)
    }
  }
  const lookup = buildOddsLookup(allEvents)
  hockeyOddsCache = { data: lookup, ts: Date.now() }
  console.log(`[odds-api/hockey] cached odds for ${Math.floor(Object.keys(lookup).length / 2)} matches`)
  return lookup
}

// ── API-Hockey (api-sports.io via RapidAPI) — real odds for ИИХФ WC + KHL + NHL ─
// Subscribe FREE at https://rapidapi.com/api-sports/api/api-hockey (100 req/day)
// Uses the SAME RAPIDAPI_KEY — just needs a separate free subscription on that API.
function apiHockeyGet(path) {
  const key = process.env.RAPIDAPI_KEY
  if (!key) return Promise.reject(new Error('No RAPIDAPI_KEY'))
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api-hockey.p.rapidapi.com',
      path,
      method: 'GET',
      timeout: 10000,
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': 'api-hockey.p.rapidapi.com',
        'Accept': 'application/json',
      },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.warn(`[api-hockey] ${path} → HTTP ${res.statusCode}: ${data.slice(0, 150)}`)
          reject(new Error(`api-hockey HTTP ${res.statusCode}`)); return
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

// Cache league IDs in process memory (they never change)
let _apiHockeyLeagueIds = null

async function getApiHockeyLeagueIds() {
  if (_apiHockeyLeagueIds) return _apiHockeyLeagueIds

  const HARDCODED = { iihfWC: 72, khl: 73, nhl: 57 }
  try {
    const data = await apiHockeyGet('/leagues')
    const leagues = data?.response || []
    if (!leagues.length) { _apiHockeyLeagueIds = HARDCODED; return HARDCODED }

    const findId = (nameParts) =>
      leagues.find(l => nameParts.some(p => l.name?.toLowerCase().includes(p)))?.id || null

    const iihfWC = findId(['world championship', 'iihf world']) || HARDCODED.iihfWC
    const khl    = findId(['khl', 'kontinental'])               || HARDCODED.khl
    const nhl    = leagues.find(l => l.name === 'NHL')?.id      || HARDCODED.nhl

    _apiHockeyLeagueIds = { iihfWC, khl, nhl }
    console.log(`[api-hockey] league IDs discovered: IIHF=${iihfWC} KHL=${khl} NHL=${nhl}`)
  } catch (err) {
    console.warn('[api-hockey] league discovery failed, using hardcoded:', err.message)
    _apiHockeyLeagueIds = HARDCODED
  }
  return _apiHockeyLeagueIds
}

// Parse API-Hockey /odds response → lookup map compatible with lookupOdds()
function parseApiHockeyOddsResponse(items) {
  const map = {}
  for (const item of (items || [])) {
    const home = item.game?.teams?.home?.name
    const away = item.game?.teams?.away?.name
    if (!home || !away) continue

    const buckets = { home: [], away: [] }
    for (const bm of (item.bookmakers || [])) {
      // bet id=1 = "Match Winner", but also check by name for safety
      const bet = bm.bets?.find(b =>
        b.id === 1 || b.name?.toLowerCase().includes('match winner') || b.name?.toLowerCase() === 'winner'
      )
      if (!bet) continue
      const hVal = bet.values?.find(v => v.value === 'Home')
      const aVal = bet.values?.find(v => v.value === 'Away')
      const h = parseFloat(hVal?.odd)
      const a = parseFloat(aVal?.odd)
      if (h > 1) buckets.home.push(h)
      if (a > 1) buckets.away.push(a)
    }
    if (!buckets.home.length || !buckets.away.length) continue

    const avg = arr => parseFloat((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2))
    const hOdds = avg(buckets.home)
    const aOdds = avg(buckets.away)
    const hN = _normOdds(home)
    const aN = _normOdds(away)
    if (!hN || !aN) continue

    const entry = { homeOdds: hOdds, awayOdds: aOdds, homeNorm: hN, awayNorm: aN }
    map[hN] = entry
    map[aN] = entry
  }
  return map
}

let apiHockeyOddsCache = { data: null, ts: 0 }
const API_HOCKEY_ODDS_TTL = 3 * 60 * 60 * 1000  // 3 hours

async function fetchApiHockeyOdds() {
  if (apiHockeyOddsCache.data && Date.now() - apiHockeyOddsCache.ts < API_HOCKEY_ODDS_TTL) {
    return apiHockeyOddsCache.data
  }
  if (!process.env.RAPIDAPI_KEY) return {}

  const leagueIds = await getApiHockeyLeagueIds()
  const now = new Date()
  const yr = now.getFullYear()
  const mo = now.getMonth() + 1  // 1-12
  // ИИХФ WC = current calendar year; KHL/NHL = season starting year
  const wcYear  = yr
  const klYear  = mo >= 9 ? yr : yr - 1  // KHL/NHL start in Sept/Oct

  const targets = [
    { id: leagueIds.iihfWC, season: wcYear,  label: 'IIHF WC' },
    { id: leagueIds.khl,    season: klYear,  label: 'KHL' },
    { id: leagueIds.nhl,    season: klYear,  label: 'NHL' },
  ]

  const merged = {}
  for (const { id, season, label } of targets) {
    try {
      const data = await apiHockeyGet(`/odds?league=${id}&season=${season}&bet=1`)
      const parsed = parseApiHockeyOddsResponse(data?.response || [])
      const count = Math.floor(Object.keys(parsed).length / 2)
      console.log(`[api-hockey/odds] ${label} (league=${id} season=${season}): ${count} matches`)
      Object.assign(merged, parsed)
    } catch (err) {
      console.warn(`[api-hockey/odds] ${label} failed:`, err.message)
    }
  }

  apiHockeyOddsCache = { data: merged, ts: Date.now() }
  console.log(`[api-hockey/odds] cached odds for ${Math.floor(Object.keys(merged).length / 2)} total matches`)
  return merged
}

// Fetch all available esports odds from The Odds API and cache result
async function fetchEsportsOdds() {
  if (esportsOddsCache.data && Date.now() - esportsOddsCache.ts < ESPORTS_ODDS_TTL) {
    return esportsOddsCache.data
  }
  if (!process.env.ODDS_API_KEY) return {}

  const ODDS_SPORTS = ['esports_csgo', 'esports_lol']
  const allEvents = []
  for (const sport of ODDS_SPORTS) {
    try {
      const events = await oddsApiGet(sport)
      if (Array.isArray(events)) allEvents.push(...events)
      console.log(`[odds-api] ${sport}: ${Array.isArray(events) ? events.length : 0} events`)
    } catch (err) {
      console.warn(`[odds-api] ${sport} failed: ${err.message}`)
    }
  }

  const lookup = buildOddsLookup(allEvents)
  esportsOddsCache = { data: lookup, ts: Date.now() }
  console.log(`[odds-api] cached odds for ${Object.keys(lookup).length / 2} matches`)
  return lookup
}

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

// GET /matches/esports — PandaScore + The Odds API, cached 1 hour
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
    // Fetch PandaScore matches + The Odds API odds in parallel
    const [runningRes, upcomingRes, oddsMap] = await Promise.all([
      pandascoreGet('/matches/running', {
        'page[size]': 30,
        sort: 'begin_at',
        with_odds: true,
      }).catch(err => { console.error('[matches/esports] running:', err.message); return [] }),
      pandascoreGet('/matches/upcoming', {
        'page[size]': 100,
        sort: 'begin_at',
        with_odds: true,
      }).catch(err => { console.error('[matches/esports] upcoming:', err.message); return [] }),
      fetchEsportsOdds().catch(() => {}),
    ])

    const running  = Array.isArray(runningRes)  ? runningRes  : []
    const upcoming = Array.isArray(upcomingRes) ? upcomingRes : []
    console.log(`[matches/esports] PandaScore: ${running.length} running + ${upcoming.length} upcoming, oddsEntries=${Object.keys(oddsMap || {}).length}`)

    for (const m of [...running, ...upcoming]) {
      const normalized = normalizeEsportsMatch(m)
      if (!normalized) continue
      if (games.some(g => g.home === normalized.home && g.away === normalized.away)) continue

      // Overlay odds from The Odds API if PandaScore didn't provide them
      if (!normalized.odds1x2 && oddsMap) {
        normalized.odds1x2 = lookupOdds(normalized.home, normalized.away, oddsMap)
      }

      games.push(normalized)
    }
  } catch (err) {
    console.error('[matches/esports] error:', err.message)
  }

  games.sort((a, b) => {
    if (a.isLive && !b.isLive) return -1
    if (!a.isLive && b.isLive) return 1
    return new Date(a.rawDate || 0) - new Date(b.rawDate || 0)
  })

  const oddsCount = games.filter(g => g.odds1x2).length
  console.log(`[matches/esports] total ${games.length} matches (${games.filter(g => g.isLive).length} live, ${oddsCount} with odds)`)

  if (games.length > 0) {
    esportsCache = { data: games, ts: Date.now() }
  } else {
    esportsCache = { data: [], ts: Date.now() - (ESPORTS_TTL - 15 * 60 * 1000) }
  }

  res.json({ data: games })
})

// GET /matches/team-logo/:teamId — proxy team image via AllSportsApi2 (PRO key, no Sofascore block)
// Cached 24h on client + 6h on server — logos rarely change
const logoCache = new Map()  // teamId → { buf, type, ts }
const LOGO_TTL = 6 * 60 * 60 * 1000  // 6h

router.get('/team-logo/:teamId', async (req, res) => {
  const teamId = parseInt(req.params.teamId, 10)
  if (!teamId) return res.status(400).end()

  const cached = logoCache.get(teamId)
  if (cached && Date.now() - cached.ts < LOGO_TTL) {
    res.set('Content-Type', cached.type)
    res.set('Cache-Control', 'public, max-age=86400')
    return res.send(cached.buf)
  }

  const key = process.env.RAPIDAPI_KEY
  if (!key) return res.status(503).end()

  // Try sources in order: AllSportsApi2 (authenticated, no block), then img.sofascore.com CDN
  const sources = [
    () => new Promise((resolve, reject) => {
      const opts = {
        hostname: 'allsportsapi2.p.rapidapi.com',
        path: `/api/team/${teamId}/image`,
        method: 'GET', timeout: 6000,
        headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': 'allsportsapi2.p.rapidapi.com', 'Accept': 'image/png,image/*' },
      }
      const r2 = https.request(opts, r => {
        const chunks = []
        r.on('data', c => chunks.push(c))
        r.on('end', () => {
          const ct = r.headers['content-type'] || ''
          if (r.statusCode !== 200 || !ct.startsWith('image')) { reject(new Error(`allsports ${r.statusCode}`)); return }
          resolve({ buf: Buffer.concat(chunks), type: ct })
        })
      })
      r2.on('error', reject)
      r2.on('timeout', () => { r2.destroy(); reject(new Error('timeout')) })
      r2.end()
    }),
    () => new Promise((resolve, reject) => {
      const opts = {
        hostname: 'img.sofascore.com',
        path: `/api/v1/team/${teamId}/image`,
        method: 'GET', timeout: 6000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.sofascore.com/' },
      }
      const r2 = https.request(opts, r => {
        const chunks = []
        r.on('data', c => chunks.push(c))
        r.on('end', () => {
          const ct = r.headers['content-type'] || ''
          if (r.statusCode !== 200 || !ct.startsWith('image')) { reject(new Error(`sofascore ${r.statusCode}`)); return }
          resolve({ buf: Buffer.concat(chunks), type: ct })
        })
      })
      r2.on('error', reject)
      r2.on('timeout', () => { r2.destroy(); reject(new Error('timeout')) })
      r2.end()
    }),
  ]

  for (const fetchFn of sources) {
    try {
      const imgData = await fetchFn()
      logoCache.set(teamId, { ...imgData, ts: Date.now() })
      res.set('Content-Type', imgData.type)
      res.set('Cache-Control', 'public, max-age=86400')
      return res.send(imgData.buf)
    } catch { /* try next */ }
  }
  res.status(404).end()
})

// GET /matches/hockey-cache-reset — admin: force-expire hockey cache so next request re-fetches
router.get('/hockey-cache-reset', (req, res) => {
  hockeyCache = { data: null, ts: 0 }
  hockeyOddsCache = { data: null, ts: 0 }
  apiHockeyOddsCache = { data: null, ts: 0 }
  pinnacleOddsCache = { data: null, ts: 0 }
  _apiHockeyLeagueIds = null
  _pinnacleSportId = null
  _pinnacleLeagueIds = null
  seasonIdCache.clear()
  res.json({ ok: true, message: 'All hockey caches cleared (matches + Pinnacle + API-Hockey + season IDs)' })
})

// GET /matches/hockey-debug — status only, NO API calls (quota-safe)
router.get('/hockey-debug', (req, res) => {
  const primaryKey   = process.env.RAPIDAPI_KEY    || null
  const secondaryKey = process.env.ICEHOCKEY_API_KEY || null
  res.json({
    ts: new Date().toISOString(),
    cacheStatus: {
      hockey: hockeyCache.data ? `${hockeyCache.data.length} games, age ${Math.round((Date.now() - hockeyCache.ts) / 60000)}min` : 'empty',
      hockeyTTL: '3h',
      seasonIdCache: [...seasonIdCache.entries()].map(([id, v]) => ({
        tournamentId: id, seasonId: v.seasonId, ageMin: Math.round((Date.now() - v.ts) / 60000)
      })),
    },
    keys: {
      RAPIDAPI_KEY:      primaryKey   ? primaryKey.slice(0, 8) + '...' : 'NOT SET',
      ICEHOCKEY_API_KEY: secondaryKey ? secondaryKey.slice(0, 8) + '...' : 'NOT SET',
      sameKey: primaryKey === secondaryKey,
    },
    hardcodedFallbacks: HOCKEY_TOURNAMENTS_BASE.map(t => ({ id: t.id, league: t.league, fallbackSeasonId: t.fallbackSeasonId })),
    note: 'No API calls made — quota-safe. Quota resets at midnight UTC.',
  })
})

// GET /matches/esports-debug — test PandaScore connection + inspect odds fields
router.get('/esports-debug', async (req, res) => {
  if (!process.env.PANDASCORE_TOKEN) return res.json({ error: 'PANDASCORE_TOKEN not set' })
  try {
    const data = await pandascoreGet('/matches/upcoming', { 'page[size]': 3, sort: 'begin_at', with_odds: true })
    const matches = Array.isArray(data) ? data : []
    res.json({
      ok: true,
      count: matches.length,
      sample: matches.slice(0, 2).map(m => ({
        id: m.id,
        name: m.name,
        game: m.videogame?.slug,
        opp1: m.opponents?.[0]?.opponent?.name,
        opp2: m.opponents?.[1]?.opponent?.name,
        // Inspect all odds-related fields
        winner_odds: m.winner_odds,
        odds: m.odds,
        draw: m.draw,
        allKeys: Object.keys(m),
      }))
    })
  } catch (e) {
    res.json({ error: e.message })
  }
})

module.exports = router
