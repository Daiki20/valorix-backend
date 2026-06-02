const express = require('express')
const https = require('https')
const zlib = require('zlib')
const router = express.Router()
const db = require('../db')

const SSTATS_BASE = 'https://api.sstats.net'

let upcomingCache = { data: null, ts: 0 }
let liveCache = { data: null, ts: 0 }
let hockeyCache = { data: null, ts: 0 }
let basketballCache = { data: null, ts: 0 }
const UPCOMING_TTL   = 15 * 60 * 1000   // 15 min — football upcoming
const LIVE_TTL       =  1 * 60 * 1000   //  1 min — live scores (need freshness)
const HOCKEY_TTL     = 30 * 60 * 1000   // 30 min — schedule rarely changes intra-hour
const BASKETBALL_TTL =  6 * 60 * 60 * 1000  // 6 h

// ── Fonbet API ────────────────────────────────────────────────────────────────
// Root sport IDs in Fonbet: Футбол=1, Хоккей=2, Баскетбол=3, Теннис=4, Киберспорт=29086
const FONBET_SPORT_IDS = { football: 1, hockey: 2, basketball: 3, tennis: 4, esports: 29086 }
const FONBET_HOST = process.env.FONBET_HOST || 'line51w.bk6bba-resources.com'
const FONBET_SCOPE = '1600'
const FONBET_TTL = 4 * 60 * 1000   // 4 min — odds don't change every second

let fonbetCache = { data: null, tree: null, leagueNames: null, oddsMap: null, ts: 0 }

// ── Team logo lookup ──────────────────────────────────────────────────────────
// Strategy:
//   1. NBA teams → ESPN CDN (instant, no API, 100% reliable)
//   2. All others → Sofascore search API (free, runs in BACKGROUND — non-blocking)
//   3. Results stored in SQLite (team_logos table) — survive Railway restarts
//   4. In-memory Map is a fast L1 cache on top of SQLite

const _teamImgCache = new Map()   // name.lower → { url, ts, ok }  (L1 — memory)
const TEAM_IMG_HIT_TTL  = 7 * 24 * 60 * 60 * 1000   // 7 days for found logos
const TEAM_IMG_MISS_TTL =  4 * 60 * 60 * 1000        // 4 h for "not found" — avoids repeated Sofascore calls

// Prepared statements for logo persistence
const _logoGet  = db.prepare('SELECT url, ok, ts FROM team_logos WHERE name_key = ?')
const _logoUpsert = db.prepare(`
  INSERT INTO team_logos (name_key, url, ok, ts) VALUES (?, ?, ?, ?)
  ON CONFLICT(name_key) DO UPDATE SET url=excluded.url, ok=excluded.ok, ts=excluded.ts
`)

// On startup: load all valid logos from SQLite into memory (warm L1 instantly)
;(function loadLogosFromDB() {
  try {
    const rows = db.prepare('SELECT name_key, url, ok, ts FROM team_logos').all()
    let loaded = 0
    for (const row of rows) {
      const ttl = row.ok ? TEAM_IMG_HIT_TTL : TEAM_IMG_MISS_TTL
      if (Date.now() - row.ts < ttl) {
        _teamImgCache.set(row.name_key, { url: row.url || null, ts: row.ts, ok: !!row.ok })
        loaded++
      }
    }
    if (loaded > 0) console.log(`[logos] loaded ${loaded} team logos from SQLite`)
  } catch (e) {
    console.warn('[logos] failed to load from SQLite:', e.message)
  }
})()

// Write logo entry to both memory and SQLite
function _setLogoCache(key, url, ok) {
  const ts = Date.now()
  _teamImgCache.set(key, { url, ts, ok })
  try { _logoUpsert.run(key, url || null, ok ? 1 : 0, ts) } catch { /* non-critical */ }
}

// NBA Russian names → ESPN CDN abbreviation (instant, no API call)
const NBA_ESPN = {
  'атланта': 'atl', 'хоукс': 'atl',
  'бостон': 'bos', 'селтикс': 'bos',
  'бруклин': 'bkn', 'нетс': 'bkn',
  'шарлотт': 'cha', 'хорнетс': 'cha',
  'чикаго': 'chi', 'буллс': 'chi',
  'кливленд': 'cle', 'кавальерс': 'cle', 'кавс': 'cle',
  'даллас': 'dal', 'маверикс': 'dal',
  'денвер': 'den', 'наггетс': 'den',
  'детройт': 'det', 'пистонс': 'det',
  'голден стейт': 'gs', 'уорриорс': 'gs',
  'хьюстон': 'hou', 'рокетс': 'hou',
  'индиана': 'ind', 'пейсерс': 'ind',
  'лос-анджелес клипперс': 'lac', 'клипперс': 'lac',
  'лос-анджелес лейкерс': 'lal', 'лейкерс': 'lal',
  'мемфис': 'mem', 'гриззлис': 'mem',
  'майами': 'mia', 'хит': 'mia',
  'милуоки': 'mil', 'бакс': 'mil',
  'миннесота': 'min', 'тимбервулвс': 'min',
  'нью-орлеан': 'no', 'пеликанс': 'no',
  'нью-йорк': 'ny', 'никс': 'ny',
  'оклахома': 'okc', 'тандер': 'okc',
  'орландо': 'orl', 'мэджик': 'orl',
  'филадельфия': 'phi', '76ers': 'phi',
  'финикс': 'phx', 'санс': 'phx',
  'портленд': 'por', 'блейзерс': 'por',
  'сакраменто': 'sac', 'кингс': 'sac',
  'сан-антонио': 'sa', 'спёрс': 'sa', 'спурс': 'sa',
  'торонто': 'tor', 'рэпторс': 'tor',
  'юта': 'utah', 'джаз': 'utah',
  'вашингтон': 'wsh', 'уизардс': 'wsh',
}

function getNBALogo(name) {
  const key = (name || '').toLowerCase().trim()
  const abbr = NBA_ESPN[key] || NBA_ESPN[key.split(/[\s-]/)[0]]
  return abbr ? `https://a.espncdn.com/i/teamlogos/nba/500/${abbr}.png` : null
}

// Sofascore search (free, no key) — returns Sofascore team image CDN URL
function sofascoreSearchTeam(name) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.sofascore.com',
      path: `/api/v1/search?q=${encodeURIComponent(name)}`,
      method: 'GET',
      timeout: 6000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8',
        'Referer': 'https://www.sofascore.com/',
        'Origin': 'https://www.sofascore.com',
        'Cache-Control': 'no-cache',
      },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(null); return }
        try { resolve(JSON.parse(data)) }
        catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.end()
  })
}

// Lookup logo for ONE team name — NBA instant, others via Sofascore
async function lookupTeamImg(name, isNBA = false) {
  if (!name) return null
  const key = name.toLowerCase().trim()

  // L1: memory cache
  const cached = _teamImgCache.get(key)
  const ttl = cached?.ok ? TEAM_IMG_HIT_TTL : TEAM_IMG_MISS_TTL
  if (cached && Date.now() - cached.ts < ttl) return cached.url

  // L2: SQLite (in case memory was cleared but DB has it)
  if (!cached) {
    try {
      const row = _logoGet.get(key)
      if (row) {
        const rowTtl = row.ok ? TEAM_IMG_HIT_TTL : TEAM_IMG_MISS_TTL
        if (Date.now() - row.ts < rowTtl) {
          _teamImgCache.set(key, { url: row.url || null, ts: row.ts, ok: !!row.ok })
          return row.url || null
        }
      }
    } catch { /* non-critical */ }
  }

  // NBA: use ESPN CDN instantly (no network call)
  if (isNBA) {
    const url = getNBALogo(name)
    _setLogoCache(key, url, !!url)
    return url
  }

  // Others: Sofascore search
  try {
    const data = await sofascoreSearchTeam(name)
    const teams = data?.teams || []
    if (!teams.length) { _setLogoCache(key, null, false); return null }
    const team = teams.find(t => t.id) || teams[0]
    if (!team?.id) { _setLogoCache(key, null, false); return null }
    const url = `/matches/team-img/${team.id}`
    _setLogoCache(key, url, true)
    return url
  } catch {
    _setLogoCache(key, null, false)
    return null
  }
}

// Warm logo cache for a list of team names — NON-BLOCKING (fire and forget)
// isNBA flag to use ESPN CDN for basketball teams
function warmLogoCache(names, isNBA = false) {
  const unique = [...new Set((names || []).filter(Boolean))]
  const uncached = unique.filter(n => {
    const key = n.toLowerCase().trim()
    const c = _teamImgCache.get(key)
    if (!c) return true
    const ttl = c.ok ? TEAM_IMG_HIT_TTL : TEAM_IMG_MISS_TTL
    return Date.now() - c.ts >= ttl
  })
  if (!uncached.length) return
  // Process in batches of 3 with small delay to avoid rate limiting
  ;(async () => {
    for (let i = 0; i < uncached.length; i += 3) {
      const batch = uncached.slice(i, i + 3)
      await Promise.all(batch.map(n => lookupTeamImg(n, isNBA).catch(() => null)))
      if (i + 3 < uncached.length) await new Promise(r => setTimeout(r, 200))
    }
  })().catch(() => {})  // swallow all errors — this is background work
}

function fonbetFetch() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: FONBET_HOST,
      path: `/events/list?lang=ru&scopeMarket=${FONBET_SCOPE}&version=0`,
      method: 'GET',
      timeout: 12000,
      headers: { 'Accept-Encoding': 'gzip', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    }
    const req = https.request(options, res => {
      const enc = res.headers['content-encoding']
      let stream = res
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip())
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate())
      else if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress())
      let data = ''
      stream.on('data', c => data += c)
      stream.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('Fonbet JSON parse error')) }
      })
      stream.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Fonbet timeout')) })
    req.end()
  })
}

function buildFonbetSportTree(sports) {
  const memo = {}
  function findRoot(id) {
    if (memo[id] !== undefined) return memo[id]
    const s = sports.find(x => x.id === id)
    if (!s || !s.parentId) { memo[id] = id; return id }
    const r = findRoot(s.parentId)
    memo[id] = r; return r
  }
  const tree = {}
  sports.forEach(s => { tree[s.id] = findRoot(s.id) })
  return tree
}

async function getFonbetData() {
  if (fonbetCache.data && Date.now() - fonbetCache.ts < FONBET_TTL) return fonbetCache
  const data = await fonbetFetch()
  const tree = buildFonbetSportTree(data.sports || [])
  const leagueNames = {}
  ;(data.sports || []).forEach(s => { leagueNames[s.id] = s.name })
  // f=921=П1, f=922=Ничья, f=923=П2
  const oddsMap = {}
  for (const cf of (data.customFactors || [])) {
    const factors = {}
    for (const f of (cf.factors || [])) factors[f.f] = f.v
    if (factors[921] || factors[923]) {
      oddsMap[cf.e] = { home: factors[921] || null, draw: factors[922] || null, away: factors[923] || null }
    }
  }
  fonbetCache = { data, tree, leagueNames, oddsMap, ts: Date.now() }
  console.log(`[fonbet] cached ${(data.events||[]).length} events, ${Object.keys(oddsMap).length} with odds`)
  return fonbetCache
}

// ── League importance score (higher = shown first) ───────────────────────────
function getLeagueScore(sport, leagueName) {
  const l = (leagueName || '').toLowerCase()

  // Youth / amateur / regional — always bottom regardless of sport
  if (/\bдо\s*(16|17|18|19|20|21|23)\b|u(16|17|18|19|20|21|23)\b|молодёж|юнош|любит|аматор|amateur|женщ|women|female/.test(l)) return 20

  if (sport === 'football') {
    if (/лига чемпионов|champions league|лч ucl/.test(l))               return 1000
    if (/лига европы|europa league|лe uel/.test(l))                     return 950
    if (/конференц.лига|conference league/.test(l))                      return 900
    if (/англия.*премьер|premier league|апл/.test(l))                    return 850
    if (/испания.*ла лига|la liga|примера дивизион/.test(l))             return 840
    if (/германия.*бундеслига[^2]|бундеслига[^2]/.test(l))              return 830
    if (/италия.*серия а[^б]|serie a/.test(l))                           return 820
    if (/франция.*лига 1|ligue 1/.test(l))                               return 810
    if (/россия.*рпл|рпл|российская премьер|tnf|тинькофф рпл/.test(l))  return 800
    if (/португалия.*примейра|primeira liga/.test(l))                    return 780
    if (/нидерланды.*эредивизи|eredivisie/.test(l))                      return 760
    if (/турция.*суперлига|süper lig|турецкая суперлига/.test(l))        return 750
    if (/бельгия|шотландия.*прем|греция.*суперлига/.test(l))             return 720
    if (/украина.*прем|португалия.*куп|копа дель рей|кубок/.test(l))    return 700
    if (/бразилия.*серия а|серия а.*бразил|brasileirao/.test(l))        return 680
    if (/аргентина.*примера|аргентина.*лига/.test(l))                    return 660
    if (/млс|mls|лига мекс|liga mx/.test(l))                             return 600
    if (/бундеслига 2|серия б|лига 2|чемпионшип/.test(l))               return 400
    if (/третья|3.* дивизион|третий/.test(l))                            return 200
    return 50   // unknown league — no data in sstats.net, will be filtered out
  }

  if (sport === 'hockey') {
    if (/нхл|nhl/.test(l))                                               return 1000
    if (/чемпионат мира|iihf world/.test(l))                             return 950
    if (/кхл/.test(l))                                                    return 900
    if (/вхл/.test(l))                                                    return 700
    if (/мхл/.test(l))                                                    return 600
    if (/ahl|ахл/.test(l))                                               return 500
    return 400
  }

  if (sport === 'basketball') {
    if (/нба|nba/.test(l))                                               return 1000
    if (/евролига|euroleague/.test(l))                                   return 950
    if (/еврокубок|eurocup/.test(l))                                     return 900
    if (/втб|vtb|единая лига/.test(l))                                   return 800
    if (/acb|испания.*баскет/.test(l))                                   return 750
    if (/bbl|германия.*баскет/.test(l))                                  return 700
    if (/pro a|франция.*баскет/.test(l))                                 return 680
    return 500
  }

  if (['cs2', 'dota2', 'lol', 'valorant'].includes(sport)) {
    if (/major|world championship|the international|мировой чемп/.test(l)) return 1000
    if (/pro league|blast premier|esl pro|pgl|iem|vct masters/.test(l))    return 900
    if (/regional|esl challenger|tier.*1|vpn prime/.test(l))               return 700
    if (/qualifier|open|tier.*2/.test(l))                                   return 400
    return 600
  }

  if (sport === 'tennis') {
    if (/grand slam|ролан гаррос|wimbledon|уимблдон|us open|australian|австралийский/.test(l)) return 1000
    if (/masters.*1000|мастерс|monte.carlo|мадрид|рим|торонто|цинциннати|шанхай|париж/.test(l)) return 900
    if (/atp.*500|500/.test(l))                                            return 800
    if (/atp.*250|250/.test(l))                                            return 700
    if (/challenger/.test(l))                                              return 500
    if (/itf/.test(l))                                                     return 300
    return 600
  }

  return 500
}

// ── League data coverage filter ───────────────────────────────────────────────
// Returns false for leagues where we have NO statistical data → these matches
// are hidden so AI cannot hallucinate made-up stats for them.
function hasDataCoverage(sport, leagueName) {
  const l = (leagueName || '').toLowerCase()

  if (sport === 'basketball') {
    // BallDontLie only has NBA — remove WNBA, Euroleague, VTB, EuroCup, etc.
    // Important: exclude WNBA first — "wnba" contains "nba" so must check before NBA match
    if (/wnba|внба|\(ж\)|женщ/i.test(l)) return false
    return /нба|nba/.test(l)
  }

  if (sport === 'hockey') {
    // Keep NHL (BallDontLie) and KHL (AllSports has decent data)
    return /нхл|nhl|кхл/.test(l)
  }

  if (sport === 'tennis') {
    // Remove WTA / women's tours — BallDontLie only has ATP players
    if (/\(ж\)|wta|женщ|women|female/.test(l)) return false
    return true
  }

  // Football: only show leagues explicitly known to sstats.net (score > 50)
  // Score 50 = catch-all unknown leagues (Bolivia, etc.) — no data there
  if (sport === 'football') {
    return getLeagueScore('football', leagueName) > 50
  }

  // Esports: AllSports covers major tournaments
  return true
}

function detectEsportType(leagueName) {
  const l = (leagueName || '').toLowerCase()
  if (l.includes('cs2') || l.includes('counter-strike')) return 'cs2'
  if (l.includes('dota')) return 'dota2'
  if (l.includes('league of legends') || l.includes(' lol')) return 'lol'
  if (l.includes('valorant')) return 'valorant'
  return 'cs2'
}

function fonbetFormatDate(startTime) {
  try {
    const d = new Date(startTime * 1000)
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' }) +
      ' · ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })
  } catch { return '' }
}

async function getFonbetSportEvents(rootSportId, limit = 20) {
  const { data, tree, leagueNames, oddsMap } = await getFonbetData()
  const sportName = Object.keys(FONBET_SPORT_IDS).find(k => FONBET_SPORT_IDS[k] === rootSportId) || 'other'

  const events = (data.events || [])
    .filter(e => e.level === 1 && e.team1 && e.team2 && tree[e.sportId] === rootSportId)
    .map(e => {
      const league = leagueNames[e.sportId] || ''
      const sport = rootSportId === 29086 ? detectEsportType(league) : sportName
      return {
        id: `fonbet_${e.id}`,
        fonbetId: e.id,
        home: e.team1, away: e.team2,
        league, sport,
        date: fonbetFormatDate(e.startTime),
        rawDate: new Date(e.startTime * 1000).toISOString(),
        isLive: e.place === 'live',
        odds1x2: oddsMap[e.id] || null,
      }
    })
    .filter(e => e.odds1x2)
    .filter(e => hasDataCoverage(e.sport, e.league))
    .sort((a, b) => {
      const sa = getLeagueScore(a.sport, a.league)
      const sb = getLeagueScore(b.sport, b.league)
      if (sa !== sb) return sb - sa
      return new Date(a.rawDate) - new Date(b.rawDate)
    })
    .slice(0, limit)

  // ── Enrich with logos ────────────────────────────────────────────────────────
  const isNBA = rootSportId === FONBET_SPORT_IDS.basketball
  const allTeamNames = events.flatMap(ev => [ev.home, ev.away])

  // For NBA: logos are instant (ESPN CDN map) — attach synchronously
  if (isNBA) {
    for (const ev of events) {
      ev.homeImg = getNBALogo(ev.home) || null
      ev.awayImg = getNBALogo(ev.away) || null
    }
  } else {
    // For non-NBA: attach already-cached logos, warm cache in background for the rest
    for (const ev of events) {
      const hEntry = _teamImgCache.get((ev.home || '').toLowerCase().trim())
      const aEntry = _teamImgCache.get((ev.away || '').toLowerCase().trim())
      const now = Date.now()
      ev.homeImg = (hEntry?.ok && now - hEntry.ts < TEAM_IMG_HIT_TTL) ? hEntry.url : null
      ev.awayImg = (aEntry?.ok && now - aEntry.ts < TEAM_IMG_HIT_TTL) ? aEntry.url : null
    }
    // Start background warm-up (non-blocking, won't delay response)
    warmLogoCache(allTeamNames, false)
  }

  return events
}

// GET /matches/football — Fonbet football (Line + Live with odds)
router.get('/football', async (req, res) => {
  try {
    const games = await getFonbetSportEvents(FONBET_SPORT_IDS.football, 20)
    console.log(`[matches/football] Fonbet: ${games.length} games`)
    res.json({ data: games })
  } catch (err) {
    console.error('[matches/football]', err.message)
    res.json({ data: [] })
  }
})

// GET /matches/esports — Fonbet esports (CS2, Dota2, LoL, Valorant)
router.get('/esports', async (req, res) => {
  try {
    const games = await getFonbetSportEvents(FONBET_SPORT_IDS.esports, 20)
    console.log(`[matches/esports] Fonbet: ${games.length} games`)
    res.json({ data: games })
  } catch (err) {
    console.error('[matches/esports]', err.message)
    res.json({ data: [] })
  }
})

// GET /matches/tennis — Fonbet tennis
router.get('/tennis', async (req, res) => {
  try {
    const games = await getFonbetSportEvents(FONBET_SPORT_IDS.tennis, 20)
    console.log(`[matches/tennis] Fonbet: ${games.length} games`)
    res.json({ data: games })
  } catch (err) {
    console.error('[matches/tennis]', err.message)
    res.json({ data: [] })
  }
})

// GET /matches/basketball-fonbet — Fonbet basketball (EuroLeague, VTB, NBA etc)
router.get('/basketball-fonbet', async (req, res) => {
  try {
    const games = await getFonbetSportEvents(FONBET_SPORT_IDS.basketball, 20)
    console.log(`[matches/basketball-fonbet] Fonbet: ${games.length} games`)
    res.json({ data: games })
  } catch (err) {
    console.error('[matches/basketball-fonbet]', err.message)
    res.json({ data: [] })
  }
})

// GET /matches/hockey-fonbet — Fonbet hockey odds (all leagues incl. IIHF, КХЛ, НХЛ, ВХЛ)
// Returns ALL hockey events with odds1x2 — no data-coverage filter (used only for odds display)
router.get('/hockey-fonbet', async (req, res) => {
  try {
    const { data, tree, leagueNames, oddsMap } = await getFonbetData()
    const rootSportId = FONBET_SPORT_IDS.hockey

    const games = (data.events || [])
      .filter(e => e.level === 1 && e.team1 && e.team2 && tree[e.sportId] === rootSportId)
      .map(e => ({
        id: `fonbet_${e.id}`,
        fonbetId: e.id,
        home: e.team1, away: e.team2,
        league: leagueNames[e.sportId] || '',
        date: fonbetFormatDate(e.startTime),
        rawDate: new Date(e.startTime * 1000).toISOString(),
        isLive: e.place === 'live',
        odds1x2: oddsMap[e.id] || null,
      }))
      .filter(e => e.odds1x2)
      .sort((a, b) => new Date(a.rawDate) - new Date(b.rawDate))
      .slice(0, 60)

    console.log(`[matches/hockey-fonbet] Fonbet all-leagues: ${games.length} games`)
    res.json({ data: games })
  } catch (err) {
    console.error('[matches/hockey-fonbet]', err.message)
    res.json({ data: [] })
  }
})

// GET /matches/live-all — all Fonbet live matches across all sports
router.get('/live-all', async (req, res) => {
  try {
    const { data, tree, leagueNames, oddsMap } = await getFonbetData()
    const KNOWN_ROOT_IDS = new Set(Object.values(FONBET_SPORT_IDS))
    const sportKeyMap = Object.fromEntries(Object.entries(FONBET_SPORT_IDS).map(([k, v]) => [v, k]))

    const liveEvents = (data.events || [])
      .filter(e => e.level === 1 && e.team1 && e.team2 && e.place === 'live')
      .filter(e => KNOWN_ROOT_IDS.has(tree[e.sportId]))
      .map(e => {
        const rootId = tree[e.sportId]
        const league = leagueNames[e.sportId] || ''
        const sport = rootId === FONBET_SPORT_IDS.esports ? detectEsportType(league) : (sportKeyMap[rootId] || 'other')
        return {
          id: `fonbet_live_${e.id}`,
          fonbetId: e.id,
          home: e.team1, away: e.team2,
          league, sport,
          date: fonbetFormatDate(e.startTime),
          rawDate: new Date(e.startTime * 1000).toISOString(),
          isLive: true,
          odds1x2: oddsMap[e.id] || null,
        }
      })
      .filter(e => hasDataCoverage(e.sport, e.league))
      .sort((a, b) => {
        const sa = getLeagueScore(a.sport, a.league)
        const sb = getLeagueScore(b.sport, b.league)
        if (sa !== sb) return sb - sa
        return new Date(a.rawDate) - new Date(b.rawDate)
      })
      .slice(0, 60)

    // Enrich with logos (NBA instant, others from cache + background warm)
    const now = Date.now()
    for (const ev of liveEvents) {
      if (ev.sport === 'basketball') {
        ev.homeImg = getNBALogo(ev.home) || null
        ev.awayImg = getNBALogo(ev.away) || null
      } else {
        const hEntry = _teamImgCache.get((ev.home || '').toLowerCase().trim())
        const aEntry = _teamImgCache.get((ev.away || '').toLowerCase().trim())
        ev.homeImg = (hEntry?.ok && now - hEntry.ts < TEAM_IMG_HIT_TTL) ? hEntry.url : null
        ev.awayImg = (aEntry?.ok && now - aEntry.ts < TEAM_IMG_HIT_TTL) ? aEntry.url : null
      }
    }
    // Background logo warm-up for non-basketball teams
    const nonNBANames = liveEvents.filter(e => e.sport !== 'basketball').flatMap(e => [e.home, e.away])
    warmLogoCache(nonNBANames, false)

    console.log(`[matches/live-all] ${liveEvents.length} live events`)
    res.json({ data: liveEvents })
  } catch (err) {
    console.error('[matches/live-all]', err.message)
    res.json({ data: [] })
  }
})

// GET /matches/team-logo?name=Arsenal — logo via Sofascore search (free, cached 24h)
router.get('/team-logo', async (req, res) => {
  const name = (req.query.name || '').trim()
  if (!name) return res.json({ url: null })
  const url = await lookupTeamImg(name)
  return res.json({ url })
})

// GET /matches/team-img/:teamId — proxy Sofascore team image (avoids CORS)
router.get('/team-img/:teamId', (req, res) => {
  const teamId = Number(req.params.teamId)
  if (!teamId) return res.status(400).end()

  const options = {
    hostname: 'api.sofascore.com',
    path: `/api/v1/team/${teamId}/image`,
    method: 'GET',
    timeout: 6000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.sofascore.com/',
      'Origin': 'https://www.sofascore.com',
    },
  }
  const proxyReq = https.request(options, proxyRes => {
    if (proxyRes.statusCode !== 200) { res.status(404).end(); return }
    res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'image/png')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    proxyRes.pipe(res)
  })
  proxyReq.on('error', () => res.status(502).end())
  proxyReq.on('timeout', () => { proxyReq.destroy(); res.status(504).end() })
  proxyReq.end()
})

// GET /matches/fonbet-cache-reset — clear Fonbet cache
router.get('/fonbet-cache-reset', (req, res) => {
  fonbetCache = { data: null, tree: null, leagueNames: null, oddsMap: null, ts: 0 }
  _teamImgCache.clear()
  res.json({ ok: true, message: 'Fonbet + logo cache cleared' })
})

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
  1, 4, 5,              // FIFA World Cup / UEFA Euro / Nations League
  667,                  // Международные товарищеские матчи (сборные)
  2, 3, 848,            // UCL / UEL / UECL
  39, 140, 135, 78, 61, // PL / La Liga / Serie A / Bundesliga / Ligue 1
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
  // ?force=1 clears cache immediately (for debugging / manual refresh)
  if (req.query.force === '1') { hockeyCache = { data: null, ts: 0 }; seasonIdCache.clear() }
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

    // Fetch matches: IceHockeyApi → AllSportsApi2 (legacy) → AllSportsApi2 (v1) → Sofascore direct
    // Note: IceHockeyApi covers MHL/VHL/KHL well. AllSports v1-path covers ИИХФ WC.
    async function fetchTournamentMatches(t) {
      const legacyPath = `/api/tournament/${t.id}/season/${t.seasonId}/matches/next/0`
      const v1Path     = `/api/v1/unique-tournament/${t.id}/season/${t.seasonId}/events/next/0`
      const sofaPath   = `/api/v1/unique-tournament/${t.id}/season/${t.seasonId}/events/next/0`

      const sources = [
        ['icehockeyapi',     () => iceHockeyGet(legacyPath)],
        ['allsportsapi2',    () => allSportsGetPath(legacyPath)],
        ['allsportsapi2/v1', () => allSportsGetPath(v1Path)],      // Sofascore v1 path on AllSports
        ['sofascore',        () => sofascoreGet(sofaPath)],         // direct, free, no quota
      ]

      for (const [label, fetchFn] of sources) {
        try {
          const data = await fetchFn()
          // AllSports / Sofascore use { events: [...] }; IceHockeyApi may nest under data
          const evts = data?.events || data?.data?.events || []
          const isLast = label === 'sofascore'
          if (evts.length > 0 || isLast) {
            console.log(`[matches/hockey] T=${t.id} "${t.league}" s=${t.seasonId} via ${label}: ${evts.length} events`)
            return { ...t, events: evts }
          }
          console.log(`[matches/hockey] T=${t.id} "${t.league}" via ${label}: 0 events — trying next source`)
        } catch (err) {
          console.warn(`[matches/hockey] ${label} T=${t.id} failed: ${err.message.slice(0, 100)}`)
        }
      }
      console.warn(`[matches/hockey] T=${t.id} "${t.league}": all sources exhausted — 0 events`)
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
  // Strategy: MERGE all sources. Pinnacle covers ИИХФ WC; The Odds API covers NHL.
  // Pinnacle sometimes returns unrelated leagues (Australian IHL etc.) when ИИХФ games
  // go live — so we always run The Odds API in parallel for NHL coverage.
  if (games.length > 0) {
    let oddsMap = {}

    // 1. The Odds API — always run first as base layer (reliable NHL data)
    if (process.env.ODDS_API_KEY) {
      try {
        const oddsApiMap = await fetchHockeyOdds()
        Object.assign(oddsMap, oddsApiMap)
        if (Object.keys(oddsApiMap).length) console.log(`[matches/hockey] Odds API base: ${Math.floor(Object.keys(oddsApiMap).length/2)} matches`)
      } catch (err) {
        console.warn('[matches/hockey] odds-api failed:', err.message)
      }
    }

    // 2. Pinnacle — merge on top (covers ИИХФ WC with sharp odds, overrides Odds API)
    if (process.env.RAPIDAPI_KEY) {
      try {
        const pinnacleMap = await fetchPinnacleHockeyOdds()
        Object.assign(oddsMap, pinnacleMap)
        if (Object.keys(pinnacleMap).length) console.log(`[matches/hockey] Pinnacle layer: ${Math.floor(Object.keys(pinnacleMap).length/2)} matches`)
      } catch (err) {
        console.warn('[matches/hockey] pinnacle odds failed:', err.message)
      }
    }

    // 3. API-Hockey — only if both above returned nothing
    if (!Object.keys(oddsMap).length && process.env.RAPIDAPI_KEY) {
      try {
        const apiHockeyMap = await fetchApiHockeyOdds()
        Object.assign(oddsMap, apiHockeyMap)
        if (Object.keys(apiHockeyMap).length) console.log('[matches/hockey] using API-Hockey as last resort')
      } catch (err) {
        console.warn('[matches/hockey] api-hockey fallback failed:', err.message)
      }
    }

    if (Object.keys(oddsMap).length) {
      let oddsOverlaid = 0
      let noMatchLog = 0

      // Log a sample of normalized oddsMap keys so we can verify coverage
      const mapSample = Object.keys(oddsMap).filter((_, i) => i % 2 === 0).slice(0, 12).join(', ')
      console.log(`[odds/map] ${Math.floor(Object.keys(oddsMap).length / 2)} entries — sample: ${mapSample}`)

      for (const game of games) {
        const odds = lookupOdds(game.homeEn || game.home, game.awayEn || game.away, oddsMap)
        if (odds) {
          game.odds1x2 = odds
          oddsOverlaid++
        } else if (noMatchLog < 10) {
          const rawH = game.homeEn || game.home
          const rawA = game.awayEn || game.away
          const hN = normalizeTeamName(rawH)
          const aN = normalizeTeamName(rawA)
          console.log('[MATCH CHECK]', JSON.stringify({
            gameHome: hN,
            gameAway: aN,
            rawHome: rawH,
            rawAway: rawA,
            availableOdds: Object.keys(oddsMap).filter((_, i) => i % 2 === 0).slice(0, 20),
          }))
          noMatchLog++
        }
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

// ── The Odds API (the-odds-api.com) ──────────────────────────────────────────
// Free: 500 req/month.  Register at https://the-odds-api.com → add ODDS_API_KEY to Railway.
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

// ── National team canonical aliases (applied to normalized English names) ────
// Direction: KEY = local/alternate form → VALUE = Pinnacle canonical form.
// Pinnacle is authoritative: if Pinnacle says "United States", canonical = "unitedstates".
// Local APIs that say "USA" must alias TO "unitedstates", not the other way around.
const TEAM_ALIASES = {
  // USA — Pinnacle uses "United States"
  'usa':                            'unitedstates',
  'unitedstatesofamerica':          'unitedstates',
  'us':                             'unitedstates',
  // Czech Republic — Pinnacle uses "Czech Republic"
  'czechia':                        'czechrepublic',
  'cze':                            'czechrepublic',
  // Great Britain — Pinnacle uses "Britain" / "Great Britain" (check logs)
  'greatbritain':                   'britain',
  'unitedkingdom':                  'britain',
  'gbr':                            'britain',
  'gb':                             'britain',
  // Korea — Pinnacle uses "South Korea"
  'korea':                          'southkorea',
  'korearep':                       'southkorea',
  'republicofkorea':                'southkorea',
  'kor':                            'southkorea',
  // DPRK
  'northkorea':                     'dprkorea',
  'democraticpeoplesrepublicofkorea': 'dprkorea',
  // Belarus / Russia
  'belorussia':                     'belarus',
  'byelorussia':                    'belarus',
  'russianfederation':              'russia',
  // Slovakia
  'slovakrepublic':                 'slovakia',
  // Switzerland
  'swiss':                          'switzerland',
  // Loko Yaroslavl short form (substring match helper)
  'lokoyaroslavl':                  'loko',
}

// ── Cyrillic → Latin transliteration (BGN/PCGN, common in sports databases) ────
const _CYR = {
  'а':'a',  'б':'b',  'в':'v',  'г':'g',  'д':'d',
  'е':'e',  'ё':'yo', 'ж':'zh', 'з':'z',  'и':'i',
  'й':'y',  'к':'k',  'л':'l',  'м':'m',  'н':'n',
  'о':'o',  'п':'p',  'р':'r',  'с':'s',  'т':'t',
  'у':'u',  'ф':'f',  'х':'kh', 'ц':'ts', 'ч':'ch',
  'ш':'sh', 'щ':'shch','ъ':'', 'ы':'y',  'ь':'',
  'э':'e',  'ю':'yu', 'я':'ya',
}
const _translit = str => str.toLowerCase().split('').map(c =>
  _CYR[c] !== undefined ? _CYR[c] : (c.match(/[a-z0-9]/) ? c : '')
).join('')

// ── Russian → English canonical team name aliases ────────────────────────────
// Key  = Russian name, lowercase, all spaces/hyphens/dots removed.
// Value = canonical English form used to match against Pinnacle/OddsAPI.
// Rule: value must be a SHORT form so substring matching catches full Pinnacle names.
//   e.g. 'lokomotiv' matches both 'lokomotivyaroslavl' and 'lokomotivjaroslavl'.
const HOCKEY_TEAM_ALIASES = {
  // ── KHL ──────────────────────────────────────────────────────────────────────
  'цска': 'cska',           'цскамосква': 'cska',
  'ска': 'ska',             'скаспб': 'ska',    'скасанктпетербург': 'ska',
  'динамо': 'dynamo',       'динамомосква': 'dynamo',
  'динамоминск': 'dynamominsk',
  'динаморига': 'dynamoriga',
  'спартак': 'spartak',     'спартакмосква': 'spartak',
  'локомотив': 'lokomotiv', 'локомотивярославль': 'lokomotiv',
  'авангард': 'avangard',   'авангардомск': 'avangard',
  'металлург': 'metallurg',
  'металлургмагнитогорск': 'metallurg',
  'металлургмг': 'metallurg',
  'акбарс': 'akbars',       'акбарсказань': 'akbars',
  'салаватюлаев': 'salavatyulaev',                    // fixed: was Cyrillic «у»
  'нефтехимик': 'neftekhimik',
  'нефтехимикнижнекамск': 'neftekhimik',
  'трактор': 'traktor',     'тракторчелябинск': 'traktor',
  'барыс': 'barys',         'барысастана': 'barys',   'барыснурсултан': 'barys',
  'северсталь': 'severstal','северстальчерепловец': 'severstal',
  'автомобилист': 'avtomobilist', 'автомобилистекатеринбург': 'avtomobilist',
  'витязь': 'vityaz',       'витязьподольск': 'vityaz',
  'торпедо': 'torpedo',     'торпедонн': 'torpedo',   'торпедонижнийновгород': 'torpedo',
  'амур': 'amur',           'амурхабаровск': 'amur',
  'сибирь': 'sibir',        'сибирьновосибирск': 'sibir',
  'куньлунь': 'kunlun',     'куньлуньредстар': 'kunlun',
  'адмирал': 'admiral',     'адмиралвладивосток': 'admiral',
  'лада': 'lada',           'ладатольятти': 'lada',

  // ── VHL ──────────────────────────────────────────────────────────────────────
  'химик': 'khimik',        'химиквоскресенск': 'khimik',
  'югра': 'yugra',          'юграхантымансийск': 'yugra',
  'рубин': 'rubin',         'рубинтюмень': 'rubin',
  'молот': 'molot',         'молотприкамье': 'molot',
  'ижсталь': 'izhstal',     'ижстальижевск': 'izhstal',
  'буран': 'buran',         'буранворонеж': 'buran',
  'зауралье': 'zauralye',   'зауральекурган': 'zauralye',
  'горняк': 'gornyak',      'горняккузбасс': 'gornyak',   'горняк-угмк': 'gornyak',
  'кристалл': 'kristall',   'кристаллсаратов': 'kristall',
  'омскиехоккеисты': 'omsk',
  'торос': 'toros',         'торосснефть': 'toros',       'торосснефтьнижнекамск': 'toros',
  'дизель': 'dizel',        'дизельпенза': 'dizel',
  'сокол': 'sokol',         'соколкрасноярск': 'sokol',
  'южныйурал': 'yuzhnyyural', 'южныйуралорск': 'yuzhnyyural',
  'шахтер': 'shakhter',     'шахтерсолигорск': 'shakhter',
  'нефтяник': 'neftyanik',  'нефтяникалметьевск': 'neftyanik',
  'буревестник': 'burevestnik',
  'крылья': 'krylja',       'крыльясоветов': 'krylja',
  'зеленоградскиемедведи': 'zelenograd',
  'металлурговской': 'metallurgovskoy',

  // ── MHL ──────────────────────────────────────────────────────────────────────
  // Key rule: short form so 'loko' matches 'lokomotivyaroslavl' via substring
  'локо': 'loko',           'локоярославль': 'loko',   // NOT 'lokoyaroslavl' — loko⊂lokomotiv
  'краснаяармия': 'redarmy', 'краснаяармиямосква': 'redarmy',
  'стальныелисы': 'steelfoxes',
  'гренадеры': 'grenadery',
  'атланты': 'atlants',     'атлантымытищи': 'atlants',
  'мхкдинамо': 'dynamo',    'мхкдинамомосква': 'dynamo',
  'мхкцска': 'cska',
  'мхкска': 'ska',          'мхкскаспб': 'ska',
  'спартакмхк': 'spartak',
  'белыемедведи': 'belyemedvedi', 'белыемедведичелябинск': 'belyemedvedi',
  'снежныебарсы': 'snezhnyebarsy',
  'юрмала': 'jurmala',
  'рубин': 'rubin',  // also MHL
  'алмаз': 'almaz',         'алмазчереповец': 'almaz',
  'стальныелисы': 'steelfoxes',
  'капитан': 'kapitan',
}

// Normalize a hockey team name for odds matching.
// Pipeline:
//   1. Full Russian key  → alias map → canonical English
//   2. First Russian word → alias map → canonical English
//   3. Any Cyrillic      → transliterate to Latin
//   4. English           → _normOdds (strip non-alphanumeric)
function normalizeTeamName(name) {
  if (!name) return ''
  // Build key: lowercase, strip spaces / hyphens / dots / brackets / quotes
  const cyrKey = name.toLowerCase().replace(/[\s\-\.«»"'\/\(\)]/g, '')
  // 1. Full key in alias map
  if (HOCKEY_TEAM_ALIASES[cyrKey]) return HOCKEY_TEAM_ALIASES[cyrKey]
  // 2. First word only (handles "Химик Воскресенск" → "химик")
  const firstWord = cyrKey.split(/[^а-яёa-z0-9]/)[0]
  if (firstWord && HOCKEY_TEAM_ALIASES[firstWord]) return HOCKEY_TEAM_ALIASES[firstWord]
  // 3. Has Cyrillic → transliterate (fallback for unknown clubs)
  if (/[а-яё]/.test(cyrKey)) return _translit(cyrKey) || _normOdds(name)
  // 4. English → normalize, then apply team aliases (local variant → Pinnacle canonical)
  const normed = _normOdds(name)
  return TEAM_ALIASES[normed] || normed
}

// Build lookup: normalizedTeamName → { homeOdds, awayOdds, homeNorm, awayNorm }
function buildOddsLookup(events) {
  const map = {}
  for (const ev of events) {
    const prices = extractOddsApiOdds(ev)
    if (!prices) continue
    const hOdds = prices[ev.home_team]
    const aOdds = prices[ev.away_team]
    if (!hOdds || !aOdds) continue
    const hN = normalizeTeamName(ev.home_team)
    const aN = normalizeTeamName(ev.away_team)
    const entry = { homeOdds: hOdds, awayOdds: aOdds, homeNorm: hN, awayNorm: aN }
    map[hN] = entry
    map[aN] = entry
  }
  return map
}

// Match team names against odds lookup; return odds1x2 or null
// IMPORTANT: requires BOTH teams to match the same entry to prevent false positives
function lookupOdds(psHome, psAway, oddsMap) {
  if (!oddsMap || !Object.keys(oddsMap).length) return null
  // normalizeTeamName handles Russian KHL/MHL/VHL names via alias map;
  // falls through to _normOdds for English (NHL, IIHF) names
  const hN = normalizeTeamName(psHome)
  const aN = normalizeTeamName(psAway)
  if (!hN || !aN) return null

  // 1. Both teams exact match → same entry = perfect
  const entryH = oddsMap[hN]
  const entryA = oddsMap[aN]
  let entry = (entryH && entryA && entryH === entryA) ? entryH : null

  // 2. Substring fallback — but BOTH teams must match the same entry
  if (!entry) {
    const seen = new Set()
    for (const e of Object.values(oddsMap)) {
      if (seen.has(e)) continue
      seen.add(e)
      const hFwd = e.homeNorm.includes(hN) || hN.includes(e.homeNorm)
      const aFwd = e.awayNorm.includes(aN) || aN.includes(e.awayNorm)
      const hRev = e.homeNorm.includes(aN) || aN.includes(e.homeNorm)
      const aRev = e.awayNorm.includes(hN) || hN.includes(e.awayNorm)
      if ((hFwd && aFwd) || (hRev && aRev)) { entry = e; break }
    }
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
  // sport_id=4 = Hockey in pinnacle-betting-odds.p.rapidapi.com wrapper
  // Confirmed from /kit/v1/sports: 1:Soccer|2:Tennis|3:Basketball|4:Hockey|5:Volleyball
  _pinnacleSportId = 4
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

    // Extract moneyline odds
    // Pinnacle wrapper stores odds in item.periods.num_N.money_line
    // Hockey uses description="Regulation Time" (number=6); fallback to first period
    let hOdds = null, aOdds = null
    const findPeriodMl = () => {
      const periods = Object.values(item.periods || {})
      if (!periods.length) return null
      // Priority: Regulation Time period (standard 3-period hockey result)
      const regTime = periods.find(p => p.description === 'Regulation Time')
      if (regTime?.money_line) return regTime.money_line
      // Fallback: first period with money_line
      for (const p of periods) {
        if (p.money_line) return p.money_line
      }
      // Last resort: first period (money_line may be null — checked below)
      return periods[0]?.money_line ?? null
    }
    const ml = item.money_line ?? item.moneyline ?? findPeriodMl()
           ?? item.odds?.moneyline ?? item.markets?.moneyline
    if (ml) {
      hOdds = parseFloat(ml.home ?? ml.homeOdds ?? ml[home])
      aOdds = parseFloat(ml.away ?? ml.awayOdds ?? ml[away])
    }
    // Also try direct home/away odds on the item
    if (!hOdds) hOdds = parseFloat(item.homeOdds ?? item.home_odds)
    if (!aOdds) aOdds = parseFloat(item.awayOdds ?? item.away_odds)

    if (!hOdds || !aOdds || hOdds < 1 || aOdds < 1) continue

    const hN = normalizeTeamName(home)
    const aN = normalizeTeamName(away)
    if (!hN || !aN) continue

    const entry = { homeOdds: hOdds, awayOdds: aOdds, homeNorm: hN, awayNorm: aN }
    map[hN] = entry
    map[aN] = entry
  }
  return map
}

let pinnacleOddsCache = { data: null, ts: 0 }
const PINNACLE_ODDS_TTL = 2 * 60 * 60 * 1000  // 2 hours — IIHF/NHL odds change frequently

async function fetchPinnacleHockeyOdds() {
  if (pinnacleOddsCache.data && Date.now() - pinnacleOddsCache.ts < PINNACLE_ODDS_TTL) {
    return pinnacleOddsCache.data
  }
  if (!process.env.RAPIDAPI_KEY) return {}

  const sportId = await getPinnacleHockeySportId()
  const merged = {}

  // Fetch ALL hockey prematch events in one request (no league_id filter).
  // Per-league queries are unreliable: when a league has no active prematch events,
  // Pinnacle falls back to returning Australian IHL data for every league query.
  // One all-sport request is also cheaper (1 API call vs 3).
  try {
    const data = await pinnacleGet(
      `/kit/v1/markets?sport_id=${sportId}&is_have_odds=true&event_type=prematch`
    )
    const items = data?.events ?? data?.markets ?? data?.data ?? (Array.isArray(data) ? data : [])
    console.log(`[pinnacle/odds] all hockey prematch: ${items.length} raw events`)

    // Debug: log which leagues are present in the response so we can verify coverage
    if (items.length) {
      const leagueCounts = {}
      for (const item of items) {
        const lid = item.league_id ?? item.leagueId ?? '?'
        const lname = item.league_name ?? item.leagueName ?? item.league ?? String(lid)
        const key = `${lname}(${lid})`
        leagueCounts[key] = (leagueCounts[key] || 0) + 1
      }
      console.log('[pinnacle/odds] available leagues:', Object.entries(leagueCounts)
        .map(([k, n]) => `${k}×${n}`).join(' | '))
    } else {
      console.log('[pinnacle/odds] no prematch events returned — all games may be live or Pinnacle quota exceeded')
    }

    // Full team name dump so we can see exactly what Pinnacle returns before normalization
    if (items.length) {
      console.log('[PINNACLE FULL]', JSON.stringify(
        items.slice(0, 30).map(e => ({
          home: e.home ?? e.home_team ?? e.teams?.home?.name ?? e.homeTeam ?? '?',
          away: e.away ?? e.away_team ?? e.teams?.away?.name ?? e.awayTeam ?? '?',
        }))
      ))
    }

    const parsed = parsePinnacleMarkets(items)
    Object.assign(merged, parsed)
  } catch (err) {
    console.warn('[pinnacle/odds] all-hockey fetch failed:', err.message)
  }

  // Log sample for format debugging
  const keys = Object.keys(merged)
  if (keys.length) {
    // Show first 5 team names so we can verify what leagues are included
    const sample5 = keys.slice(0, 10).filter((_, i) => i % 2 === 0).join(', ')
    console.log(`[pinnacle/odds] sample teams: ${sample5}`)
    console.log(`[pinnacle/odds] sample entry: ${keys[0]} → ${JSON.stringify(merged[keys[0]])}`)
  }

  pinnacleOddsCache = { data: merged, ts: Date.now() }
  console.log(`[pinnacle/odds] cached ${Math.floor(keys.length / 2)} total matches`)
  return merged
}

// ── Hockey odds (The Odds API) ────────────────────────────────────────────────
// Sport keys to try — some may return 0 events or 404 when season is over (caught gracefully).
// KHL returns 0 events May–Aug (off-season); IIHF key validated when WC is live.
let hockeyOddsCache = { data: null, ts: 0 }
const HOCKEY_ODDS_TTL = 6 * 60 * 60 * 1000   // 6 hours — conserves monthly quota
const HOCKEY_ODDS_SPORTS = [
  'icehockey_nhl',   // NHL playoffs (Apr–Jun) — confirmed working
  'icehockey_khl',   // KHL — off-season May–Aug, returns 0 events (expected)
  // IIHF WC: icehockey_world_championship and icehockey_iihf_worlds both return
  // HTTP 404 — TheOddsAPI doesn't carry IIHF. Use Pinnacle (league 1599) instead.
]

async function fetchHockeyOdds() {
  if (hockeyOddsCache.data && Date.now() - hockeyOddsCache.ts < HOCKEY_ODDS_TTL) {
    return hockeyOddsCache.data
  }
  if (!process.env.ODDS_API_KEY) return {}
  const allEvents = []
  for (const sport of HOCKEY_ODDS_SPORTS) {
    try {
      const events = await oddsApiGet(sport)
      const count = Array.isArray(events) ? events.length : 0
      if (count > 0) allEvents.push(...events)
      // Only log non-zero or explicitly-failing sports to reduce noise
      if (count > 0) console.log(`[odds-api/hockey] ${sport}: ${count} events`)
      else           console.log(`[odds-api/hockey] ${sport}: 0 events (off-season or key not found)`)
    } catch (err) {
      // 404/422/unknown sport = key doesn't exist for this plan; skip silently
      const isUnknown = err.message?.includes('404') || err.message?.includes('422')
        || err.message?.includes('unknown sport') || err.message?.includes('Sport not available')
      if (isUnknown) {
        console.log(`[odds-api/hockey] ${sport}: key not found — ${err.message.slice(0, 80)}`)
      } else {
        console.warn(`[odds-api/hockey] ${sport} failed: ${err.message}`)
      }
    }
  }
  const lookup = buildOddsLookup(allEvents)
  const matchCount = Math.floor(Object.keys(lookup).length / 2)
  hockeyOddsCache = { data: lookup, ts: Date.now() }
  console.log(`[odds-api/hockey] cached odds for ${matchCount} matches total`)
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
    const hN = normalizeTeamName(home)
    const aN = normalizeTeamName(away)
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

module.exports = router
