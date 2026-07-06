const https = require('https')
const db = require('./db')

const MSK = 3 * 60 * 60 * 1000 // UTC+3

const PACKAGE_PRICES = {
  pack_test: 50, pack_100: 100, pack_300: 300, pack_600: 540, pack_1000: 800, pack_bonus: 600,
}

// ── Telegram API ──────────────────────────────────────────────────────────────
function tgPost(method, payload) {
  return new Promise((resolve) => {
    const token = process.env.TG_BOT_TOKEN
    if (!token) { resolve(null); return }
    const body = JSON.stringify(payload)
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      timeout: 10000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch { resolve(null) } })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.write(body)
    req.end()
  })
}

const REPORT_BUTTONS = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '📊 Составить отчёт', callback_data: 'report_now' }],
      [{ text: '📅 Статистика за месяц', callback_data: 'month_stats' }],
    ],
  },
}

function sendMessage(chatId, text, extra = {}) {
  return tgPost('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra })
}

// ── Register webhook with Telegram ───────────────────────────────────────────
async function registerWebhook() {
  const token = process.env.TG_BOT_TOKEN
  const host = process.env.RAILWAY_PUBLIC_DOMAIN || 'web-production-fefcd.up.railway.app'
  if (!token) { console.warn('[tgReport] TG_BOT_TOKEN not set'); return }
  const url = `https://${host}/tg-webhook`
  const result = await tgPost('setWebhook', { url, drop_pending_updates: true })
  if (result?.ok) console.log(`[tgReport] Webhook set: ${url}`)
  else console.warn('[tgReport] Webhook failed:', result?.description)
}

// ── OpenAI costs ──────────────────────────────────────────────────────────────
function fetchOpenAICost(dateFrom, dateTo) {
  return new Promise((resolve) => {
    const key = process.env.OPENAI_USAGE_KEY || process.env.OPENAI_API_KEY
    if (!key) { resolve(null); return }

    const startDate = new Date(dateFrom + 'T00:00:00Z')
    const endDate   = new Date(dateTo   + 'T00:00:00Z')
    endDate.setUTCDate(endDate.getUTCDate() + 1)  // exclusive end
    const startTime = Math.floor(startDate.getTime() / 1000)
    const endTime   = Math.floor(endDate.getTime() / 1000)

    const path = `/v1/organization/costs?start_time=${startTime}&end_time=${endTime}&limit=31&bucket_width=1d`
    const options = {
      hostname: 'api.openai.com',
      path,
      method: 'GET',
      timeout: 10000,
      headers: { 'Authorization': `Bearer ${key}` },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (res.statusCode === 200 && Array.isArray(json.data)) {
            let total = 0
            for (const bucket of json.data) {
              for (const r of (bucket.results || [])) {
                total += parseFloat(r.amount?.value) || 0
              }
            }
            resolve(total)
          } else {
            console.warn('[OpenAI cost] status:', res.statusCode, data.slice(0, 200))
            resolve(null)
          }
        } catch (e) { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.end()
  })
}

// ── Yandex Direct costs ───────────────────────────────────────────────────────
function fetchYaDirectSpend(dateFrom, dateTo) {
  return new Promise((resolve) => {
    const token = process.env.YADIRECT_TOKEN
    if (!token) { resolve(null); return }

    const report = {
      params: {
        SelectionCriteria: { DateFrom: dateFrom, DateTo: dateTo },
        FieldNames: ['Cost'],
        ReportName: `valorix_${Date.now()}`,
        ReportType: 'ACCOUNT_PERFORMANCE_REPORT',
        DateRangeType: 'CUSTOM_DATE',
        Format: 'TSV',
        IncludeVAT: 'YES',
        IncludeDiscount: 'NO',
      },
    }
    const body = JSON.stringify(report)
    const options = {
      hostname: 'api.direct.yandex.com',
      path: '/json/v5/reports',
      method: 'POST',
      timeout: 15000,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept-Language': 'ru',
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'processingMode': 'auto',
        'returnMoneyInMicros': 'false',
        'skipReportHeader': 'true',
        'skipColumnHeader': 'true',
        'skipReportSummary': 'true',
      },
    }
    const req = https.request(options, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const cost = parseFloat(data.trim().split('\n')[0])
            resolve(isNaN(cost) ? null : Math.round(cost))
          } else if (res.statusCode === 201 || res.statusCode === 202) {
            setTimeout(() => fetchYaDirectSpend(dateFrom, dateTo).then(resolve), 5000)
          } else {
            console.warn('[YaDirect] status:', res.statusCode, data.slice(0, 150))
            resolve(null)
          }
        } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.write(body)
    req.end()
  })
}

// ── Date helpers (MSK) ────────────────────────────────────────────────────────
function mskNow() {
  return new Date(Date.now() + MSK)
}

function getMskRange(type) {
  const now = new Date()
  const msk = mskNow()
  const y = msk.getUTCFullYear(), mo = msk.getUTCMonth(), d = msk.getUTCDate()

  let startUtc, end

  if (type === 'month') {
    startUtc = new Date(Date.UTC(y, mo, 1, 0, 0, 0) - MSK)  // 1-е число месяца 00:00 MSK
    end = now
  } else {
    startUtc = new Date(Date.UTC(y, mo, d, 0, 0, 0) - MSK)
    if (type === 'morning')      end = new Date(Date.UTC(y, mo, d, 8, 0, 0) - MSK)
    else if (type === 'evening') end = new Date(Date.UTC(y, mo, d, 23, 59, 59) - MSK)
    else                         end = now  // 'now'
  }

  const fmt = dt => dt.toISOString().replace('T', ' ').slice(0, 19)
  return { start: fmt(startUtc), end: fmt(end) }
}

function dateStr() {
  const m = mskNow()
  return `${String(m.getUTCDate()).padStart(2,'0')}.${String(m.getUTCMonth()+1).padStart(2,'0')}.${m.getUTCFullYear()}`
}

function timeStr() {
  const m = mskNow()
  return `${String(m.getUTCHours()).padStart(2,'0')}:${String(m.getUTCMinutes()).padStart(2,'0')}`
}

function todayYmd() {
  return mskNow().toISOString().slice(0, 10)
}

function monthStartYmd() {
  const m = mskNow()
  return `${m.getUTCFullYear()}-${String(m.getUTCMonth()+1).padStart(2,'0')}-01`
}

// ── Build report ──────────────────────────────────────────────────────────────
async function buildReport(type) {
  const { start, end } = getMskRange(type)
  const today = todayYmd()

  let period, costFrom, costTo, header

  if (type === 'morning') {
    period = '🌅 00:00 – 08:00'
    costFrom = costTo = today
    header = `🤝 <b>Отчет на ${dateStr()}</b>`
  } else if (type === 'evening') {
    period = '🌙 итог дня 00:00 – 23:59'
    costFrom = costTo = today
    header = `🤝 <b>Отчет на ${dateStr()}</b>`
  } else if (type === 'month') {
    const msk = mskNow()
    const monthName = msk.toLocaleString('ru-RU', { month: 'long', timeZone: 'UTC' })
    period = `📅 с 01 по ${dateStr()}`
    costFrom = monthStartYmd()
    costTo = today
    header = `📅 <b>Статистика за ${monthName} ${msk.getUTCFullYear()}</b>`
  } else {
    period = `⚡ 00:00 – ${timeStr()}`
    costFrom = costTo = today
    header = `🤝 <b>Отчет на ${dateStr()}</b>`
  }

  const [regs, analyses, expressPurchases, payments, totalUsers, openaiCost, yaSpend] = await Promise.all([
    db.prepare(`SELECT COUNT(*) as cnt FROM users WHERE created_at >= ? AND created_at <= ?`).get(start, end),
    db.prepare(`SELECT COUNT(*) as cnt FROM analyses WHERE created_at >= ? AND created_at <= ?`).get(start, end),
    db.prepare(`
      SELECT COUNT(*) as cnt FROM (
        SELECT id FROM express_purchases        WHERE created_at >= ? AND created_at <= ?
        UNION ALL
        SELECT id FROM express_purchases_high   WHERE created_at >= ? AND created_at <= ?
        UNION ALL
        SELECT id FROM express_sports_purchases WHERE created_at >= ? AND created_at <= ?
      )
    `).get(start, end, start, end, start, end),
    db.prepare(`SELECT package_id FROM pending_payments WHERE status = 'done' AND created_at >= ? AND created_at <= ?`).all(start, end),
    db.prepare(`SELECT COUNT(*) as cnt FROM users`).get(),
    fetchOpenAICost(costFrom, costTo),
    fetchYaDirectSpend(costFrom, costTo),
  ])

  const revenue = payments.reduce((sum, p) => sum + (PACKAGE_PRICES[p.package_id] || 0), 0)
  const aiLine = openaiCost !== null ? `$${openaiCost.toFixed(2)}` : 'нет данных'
  const yaLine = yaSpend !== null ? `${yaSpend} ₽` : 'нет данных'

  return [
    header,
    `<i>${period}</i>`,
    ``,
    `<b>🎰 Затраты:</b>`,
    `⚪ OpenAI: ${aiLine}`,
    `🟡 Я.Директ: ${yaLine}`,
    ``,
    `<b>💻 Отчет Valorix:</b>`,
    `🚹 Зарегистрировались: <b>${regs.cnt}</b>`,
    `📡 Анализов: <b>${analyses.cnt}</b>`,
    `🎯 Экспрессов куплено: <b>${expressPurchases.cnt}</b>`,
    `💰 Пополнений: <b>${payments.length}</b>`,
    `💲 Прибыль: <b>${revenue} ₽</b>`,
    ``,
    `👥 Всего пользователей: <b>${totalUsers.cnt}</b>`,
  ].join('\n')
}

// ── Allowed chat IDs (comma-separated in TG_CHAT_ID env var) ─────────────────
function getAllowedIds() {
  return (process.env.TG_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean)
}

// ── Webhook: handle incoming Telegram updates ────────────────────────────────
async function handleUpdate(update) {
  const allowedIds = getAllowedIds()
  const msg = update.message
  const cb  = update.callback_query

  const fromId = String(msg?.chat?.id ?? cb?.message?.chat?.id ?? '')
  if (!allowedIds.length || !allowedIds.includes(fromId)) return

  if (msg?.text === '/start') {
    await sendMessage(fromId,
      `👋 <b>Valorix — панель отчётов</b>\n\n` +
      `Автоматические отчёты:\n🌅 08:00 МСК — утренняя сводка\n🌙 23:59 МСК — итог дня\n\n` +
      `Выбери действие:`,
      REPORT_BUTTONS
    )
    return
  }

  if (msg?.text === '/report' || cb?.data === 'report_now') {
    if (cb) await tgPost('answerCallbackQuery', { callback_query_id: cb.id, text: 'Собираю данные...' })
    const text = await buildReport('now')
    await sendMessage(fromId, text, REPORT_BUTTONS)
    return
  }

  if (msg?.text === '/month' || cb?.data === 'month_stats') {
    if (cb) await tgPost('answerCallbackQuery', { callback_query_id: cb.id, text: 'Считаю за месяц...' })
    const text = await buildReport('month')
    await sendMessage(fromId, text, REPORT_BUTTONS)
  }
}

// ── Scheduled reports ─────────────────────────────────────────────────────────
async function sendMorningReport() {
  console.log('[tgReport] Sending morning report...')
  try {
    const ids = getAllowedIds()
    if (!ids.length) return
    const text = await buildReport('morning')
    await Promise.all(ids.map(id => sendMessage(id, text, REPORT_BUTTONS)))
  } catch (err) { console.error('[tgReport] Morning error:', err.message) }
}

async function sendEveningReport() {
  console.log('[tgReport] Sending evening report...')
  try {
    const ids = getAllowedIds()
    if (!ids.length) return
    const text = await buildReport('evening')
    await Promise.all(ids.map(id => sendMessage(id, text, REPORT_BUTTONS)))
  } catch (err) { console.error('[tgReport] Evening error:', err.message) }
}

module.exports = { sendMorningReport, sendEveningReport, handleUpdate, registerWebhook, buildReport }
