const https = require('https')
const db = require('./db')

// Package prices (coins → rubles)
const PACKAGE_PRICES = {
  pack_test: 50, pack_100: 100, pack_300: 300, pack_600: 540, pack_1000: 800,
}

// Fetch Yandex Direct spend for a date range (YYYY-MM-DD)
function fetchYaDirectSpend(dateFrom, dateTo) {
  return new Promise((resolve) => {
    const token = process.env.YADIRECT_TOKEN
    if (!token) { resolve(null); return }

    const report = {
      params: {
        SelectionCriteria: { DateFrom: dateFrom, DateTo: dateTo },
        FieldNames: ['Cost'],
        ReportName: `valorix_report_${Date.now()}`,
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
            // TSV: one line with cost value
            const cost = parseFloat(data.trim().split('\n')[0])
            resolve(isNaN(cost) ? null : Math.round(cost))
          } else if (res.statusCode === 201 || res.statusCode === 202) {
            // Report queued — retry once after 3s
            setTimeout(() => fetchYaDirectSpend(dateFrom, dateTo).then(resolve), 3000)
          } else {
            console.warn('[tgReport] YaDirect status:', res.statusCode, data.slice(0, 200))
            resolve(null)
          }
        } catch (e) { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.write(body)
    req.end()
  })
}

function sendTelegramMessage(text) {
  const token = process.env.TG_BOT_TOKEN
  const chatId = process.env.TG_CHAT_ID
  if (!token || !chatId) {
    console.warn('[tgReport] TG_BOT_TOKEN or TG_CHAT_ID not set — skipping')
    return
  }

  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }
  const req = https.request(options, res => {
    let data = ''
    res.on('data', c => data += c)
    res.on('end', () => {
      const parsed = JSON.parse(data)
      if (!parsed.ok) console.error('[tgReport] Telegram error:', parsed.description)
      else console.log('[tgReport] Message sent ✓')
    })
  })
  req.on('error', err => console.error('[tgReport] Request error:', err.message))
  req.write(body)
  req.end()
}

// Returns date range in SQLite format (UTC) for MSK day
// type: 'yesterday' | 'today'
function getMskRange(type) {
  const now = new Date()
  const mskOffset = 3 * 60 * 60 * 1000 // UTC+3

  const mskNow = new Date(now.getTime() + mskOffset)

  let start, end
  if (type === 'yesterday') {
    const yesterday = new Date(mskNow)
    yesterday.setDate(yesterday.getDate() - 1)
    start = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate(), 0, 0, 0) - mskOffset)
    end   = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate(), 23, 59, 59) - mskOffset)
  } else {
    // today so far
    start = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate(), 0, 0, 0) - mskOffset)
    end   = now
  }

  const fmt = d => d.toISOString().replace('T', ' ').slice(0, 19)
  return { start: fmt(start), end: fmt(end) }
}

function formatDate(type) {
  const mskNow = new Date(Date.now() + 3 * 60 * 60 * 1000)
  if (type === 'yesterday') {
    const y = new Date(mskNow)
    y.setDate(y.getDate() - 1)
    return `${String(y.getUTCDate()).padStart(2,'0')}.${String(y.getUTCMonth()+1).padStart(2,'0')}.${y.getUTCFullYear()}`
  }
  return `${String(mskNow.getUTCDate()).padStart(2,'0')}.${String(mskNow.getUTCMonth()+1).padStart(2,'0')}.${mskNow.getUTCFullYear()}`
}

async function buildReport(rangeType) {
  const { start, end } = getMskRange(rangeType)
  const dateLabel = formatDate(rangeType)
  const period = rangeType === 'yesterday' ? 'за вчера' : 'за сегодня'

  // Date strings for Yandex Direct (YYYY-MM-DD in MSK)
  const mskOffset = 3 * 60 * 60 * 1000
  const startMsk = new Date(new Date(start).getTime() + mskOffset)
  const endMsk   = new Date(new Date(end).getTime() + mskOffset)
  const yaDateFrom = startMsk.toISOString().slice(0, 10)
  const yaDateTo   = endMsk.toISOString().slice(0, 10)

  // Parallel: DB queries + Yandex Direct API
  const [regs, analyses, expressPurchases, payments, totalUsers, yaSpend] = await Promise.all([
    db.prepare(`SELECT COUNT(*) as cnt FROM users WHERE created_at >= ? AND created_at <= ?`).get(start, end),
    db.prepare(`SELECT COUNT(*) as cnt FROM analyses WHERE created_at >= ? AND created_at <= ?`).get(start, end),
    db.prepare(`
      SELECT COUNT(*) as cnt FROM (
        SELECT id FROM express_purchases WHERE created_at >= ? AND created_at <= ?
        UNION ALL
        SELECT id FROM express_purchases_high WHERE created_at >= ? AND created_at <= ?
        UNION ALL
        SELECT id FROM express_sports_purchases WHERE created_at >= ? AND created_at <= ?
      )
    `).get(start, end, start, end, start, end),
    db.prepare(`SELECT package_id FROM pending_payments WHERE status = 'done' AND created_at >= ? AND created_at <= ?`).all(start, end),
    db.prepare(`SELECT COUNT(*) as cnt FROM users`).get(),
    fetchYaDirectSpend(yaDateFrom, yaDateTo),
  ])

  const revenue = payments.reduce((sum, p) => sum + (PACKAGE_PRICES[p.package_id] || 0), 0)
  const paymentCount = payments.length
  const yaDirectCost = yaSpend !== null ? `${yaSpend} ₽` : 'нет данных'

  const lines = [
    `🤝 <b>Отчет на ${dateLabel} (${period})</b>`,
    ``,
    `<b>🎰 Затраты:</b>`,
    `🟡 Я.Директ: ${yaDirectCost}`,
    ``,
    `<b>💻 Отчет Valorix:</b>`,
    `🚹 Зарегистрировались: <b>${regs.cnt}</b>`,
    `📡 Анализов: <b>${analyses.cnt}</b>`,
    `🎯 Экспрессов куплено: <b>${expressPurchases.cnt}</b>`,
    `💰 Пополнений: <b>${paymentCount}</b>`,
    `💲 Прибыль: <b>${revenue} ₽</b>`,
    ``,
    `👥 Всего пользователей: <b>${totalUsers.cnt}</b>`,
  ]

  return lines.join('\n')
}

async function sendMorningReport() {
  console.log('[tgReport] Sending morning report (yesterday stats)...')
  try {
    const text = await buildReport('yesterday')
    sendTelegramMessage(text)
  } catch (err) {
    console.error('[tgReport] Error building morning report:', err.message)
  }
}

async function sendEveningReport() {
  console.log('[tgReport] Sending evening report (today stats)...')
  try {
    const text = await buildReport('today')
    sendTelegramMessage(text)
  } catch (err) {
    console.error('[tgReport] Error building evening report:', err.message)
  }
}

module.exports = { sendMorningReport, sendEveningReport }
