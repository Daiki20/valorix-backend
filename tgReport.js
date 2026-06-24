const https = require('https')
const db = require('./db')

const MSK = 3 * 60 * 60 * 1000 // UTC+3

const PACKAGE_PRICES = {
  pack_test: 50, pack_100: 100, pack_300: 300, pack_600: 540, pack_1000: 800,
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

const REPORT_BUTTON = {
  reply_markup: { inline_keyboard: [[{ text: '📊 Составить отчёт', callback_data: 'report_now' }]] },
}

function sendMessage(chatId, text, extra = {}) {
  return tgPost('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra })
}

// ── Register webhook with Telegram ───────────────────────────────────────────
async function registerWebhook() {
  const token = process.env.TG_BOT_TOKEN
  // Use known Railway URL or env override
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
    const key = process.env.OPENAI_API_KEY
    if (!key) { resolve(null); return }

    const path = `/v1/dashboard/billing/usage?start_date=${dateFrom}&end_date=${dateTo}`
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
          if (res.statusCode === 200 && json.total_usage != null) {
            // total_usage is in cents USD
            const dollars = json.total_usage / 100
            resolve(dollars)
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

// ── Date helpers (all times in MSK) ──────────────────────────────────────────
function mskNow() {
  return new Date(Date.now() + MSK)
}

// Returns { start, end } as UTC datetime strings for SQLite
// type: 'morning' (00:00–08:00) | 'evening' (00:00–23:59) | 'now' (00:00–current)
function getMskRange(type) {
  const now = new Date()
  const msk = mskNow()
  const y = msk.getUTCFullYear(), mo = msk.getUTCMonth(), d = msk.getUTCDate()

  const todayStart = new Date(Date.UTC(y, mo, d, 0, 0, 0) - MSK)

  let end
  if (type === 'morning')      end = new Date(Date.UTC(y, mo, d, 8, 0, 0) - MSK)
  else if (type === 'evening') end = new Date(Date.UTC(y, mo, d, 23, 59, 59) - MSK)
  else                         end = now  // 'now'

  const fmt = dt => dt.toISOString().replace('T', ' ').slice(0, 19)
  return { start: fmt(todayStart), end: fmt(end) }
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

// ── Build report ──────────────────────────────────────────────────────────────
async function buildReport(type) {
  const { start, end } = getMskRange(type)

  let period
  if (type === 'morning')      period = '🌅 00:00 – 08:00'
  else if (type === 'evening') period = '🌙 итог дня 00:00 – 23:59'
  else                         period = `⚡ 00:00 – ${timeStr()}`

  const today = todayYmd()

  const [regs, analyses, expressPurchases, payments, totalUsers, openaiCost] = await Promise.all([
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
    fetchOpenAICost(today, today),
  ])

  const revenue = payments.reduce((sum, p) => sum + (PACKAGE_PRICES[p.package_id] || 0), 0)
  const aiLine = openaiCost !== null ? `$${openaiCost.toFixed(2)}` : 'нет данных'

  return [
    `🤝 <b>Отчет на ${dateStr()}</b>`,
    `<i>${period}</i>`,
    ``,
    `<b>🎰 Затраты:</b>`,
    `⚪ OpenAI (сегодня): ${aiLine}`,
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

// ── Webhook: handle incoming Telegram updates ────────────────────────────────
async function handleUpdate(update) {
  const allowedChatId = process.env.TG_CHAT_ID
  const msg = update.message
  const cb  = update.callback_query

  const fromId = String(msg?.chat?.id ?? cb?.message?.chat?.id ?? '')
  if (!allowedChatId || fromId !== allowedChatId) return  // ignore strangers

  if (msg?.text === '/start') {
    await sendMessage(allowedChatId,
      `👋 <b>Valorix — панель отчётов</b>\n\n` +
      `Автоматические отчёты:\n🌅 08:00 МСК — утренняя сводка\n🌙 23:59 МСК — итог дня\n\n` +
      `Или нажми кнопку чтобы получить отчёт прямо сейчас:`,
      REPORT_BUTTON
    )
    return
  }

  if (msg?.text === '/report' || cb?.data === 'report_now') {
    if (cb) await tgPost('answerCallbackQuery', { callback_query_id: cb.id, text: 'Собираю данные...' })
    const text = await buildReport('now')
    await sendMessage(allowedChatId, text, REPORT_BUTTON)
  }
}

// ── Scheduled reports ─────────────────────────────────────────────────────────
async function sendMorningReport() {
  console.log('[tgReport] Sending morning report...')
  try {
    const chatId = process.env.TG_CHAT_ID
    if (!chatId) return
    const text = await buildReport('morning')
    await sendMessage(chatId, text, REPORT_BUTTON)
  } catch (err) { console.error('[tgReport] Morning error:', err.message) }
}

async function sendEveningReport() {
  console.log('[tgReport] Sending evening report...')
  try {
    const chatId = process.env.TG_CHAT_ID
    if (!chatId) return
    const text = await buildReport('evening')
    await sendMessage(chatId, text, REPORT_BUTTON)
  } catch (err) { console.error('[tgReport] Evening error:', err.message) }
}

module.exports = { sendMorningReport, sendEveningReport, handleUpdate, registerWebhook, buildReport }
