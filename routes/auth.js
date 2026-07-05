const express = require('express')
const https = require('https')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const nodemailer = require('nodemailer')
const db = require('../db')
const { authenticate } = require('../middleware/auth')

const router = express.Router()

function makeToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' })
}

function sanitizeEmail(email) {
  return (email || '').trim().toLowerCase().slice(0, 254)
}

// ── Одноразовые / мусорные email домены ──────────────────────────────────────
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com','guerrillamail.com','guerrillamail.net','guerrillamail.org',
  'guerrillamail.biz','guerrillamail.de','guerrillamail.info','sharklasers.com',
  'grr.la','spam4.me','trashmail.com','trashmail.me','trashmail.net','trashmail.at',
  'trashmail.io','trashmail.org','yopmail.com','yopmail.fr','cool.fr.nf',
  'jetable.fr.nf','nospam.ze.tc','nomail.xl.cx','mega.zik.dj','speed.1s.fr',
  'courriel.fr.nf','moncourrier.fr.nf','monemail.fr.nf','monmail.fr.nf',
  'tempmail.com','tempmail.net','temp-mail.org','temp-mail.ru','dispostable.com',
  'throwam.com','throwam.net','mailnull.com','spamgourmet.com','mailnew.com',
  'mailexpire.com','spamex.com','spamevader.net','maildrop.cc','filzmail.com',
  'fakeinbox.com','crazymailing.com','fakemail.net','discard.email','discardmail.com',
  'spam.la','spamfree24.org','spamfree24.de','spamfree24.net','spamfree24.com',
  'hMailServer.com','10minutemail.com','10minutemail.net','20minutemail.com',
  'tempinbox.com','tempinbox.co.uk','tempr.email','discard.email',
  // Домены замеченные в абузе (из логов)
  'dustmail.net','hugeapi.net','hoangxbt.com',
  'hoangpi.net','zenithion.com','galacticrune.com',
])

function isDisposableEmail(email) {
  const domain = (email || '').split('@')[1]?.toLowerCase()
  if (!domain) return false
  // Проверяем точное совпадение и похожие паттерны
  if (DISPOSABLE_DOMAINS.has(domain)) return true
  // Подозрительные паттерны в домене
  if (/^[a-z0-9]{2,6}\.(xbt|pi|tk|ml|ga|cf|gq)$/.test(domain)) return true
  return false
}

function sanitizeString(str, max = 100) {
  return (str || '').trim().slice(0, max)
}

function createMailer() {
  if (!process.env.SMTP_USER || process.env.SMTP_USER.includes('твоя_почта')) return null
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.yandex.ru',
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: (process.env.SMTP_PASS || '').replace(/\s/g, ''), // убираем пробелы из пароля приложения
    },
  })
}


function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

function sendVerificationCode(email, code) {
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
      <h2 style="color:#1a1a2e">Подтверждение email</h2>
      <p>Введите этот код на сайте для завершения регистрации:</p>
      <div style="font-size:40px;font-weight:900;letter-spacing:8px;color:#2563eb;text-align:center;padding:24px;background:#eff6ff;border-radius:12px;margin:20px 0">
        ${code}
      </div>
      <p style="color:#94a3b8;font-size:13px">Код действует 15 минут. Если вы не регистрировались — проигнорируйте это письмо.</p>
    </div>
  `

  // Resend API (preferred)
  if (process.env.RESEND_API_KEY) {
    const body = JSON.stringify({
      from: process.env.SMTP_FROM || 'Valorix AI <noreply@valorix.ru>',
      to: [email],
      subject: 'Код подтверждения — Valorix AI',
      html,
    })
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        if (res.statusCode >= 400) console.error('Resend error:', data)
        else console.log(`Email sent to ${email} via Resend`)
      })
    })
    req.on('error', err => console.error('Resend request error:', err.message))
    req.setTimeout(10000, () => { req.destroy(); console.error('Resend timeout') })
    req.write(body)
    req.end()
    return
  }

  // Nodemailer fallback (SMTP)
  const mailer = createMailer()
  if (!mailer) {
    console.log(`[DEV] Verification code for ${email}: ${code}`)
    return
  }
  mailer.sendMail({ from: process.env.SMTP_FROM, to: email, subject: 'Код подтверждения — Valorix AI', html })
    .then(() => console.log(`Email sent to ${email} via SMTP`))
    .catch(err => console.error('SMTP error:', err.message))
}

// POST /auth/register
router.post('/register', async (req, res) => {
  const email    = sanitizeEmail(req.body.email)
  const password = sanitizeString(req.body.password, 128)
  const username = sanitizeString(req.body.username, 50)
  const ip          = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown'
  const utm_source   = sanitizeString(req.body.utm_source || '', 50)
  const utm_campaign = sanitizeString(req.body.utm_campaign || '', 100)

  if (!email || !password) {
    return res.status(400).json({ error: 'Email и пароль обязательны' })
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Пароль должен быть не менее 6 символов' })
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Неверный формат email' })
  }

  // ── Блок одноразовых email ──────────────────────────────────────────────────
  if (isDisposableEmail(email)) {
    return res.status(400).json({ error: 'Пожалуйста, используйте настоящий email адрес' })
  }

  // IP-счётчик для определения бонуса при верификации (блокировка снята)
  // логика монет: 1-я регистрация → 38, повторные → 10

  const existing = db.prepare('SELECT id, is_verified FROM users WHERE email = ?').get(email)
  if (existing) {
    if (!existing.is_verified) {
      const code = generateCode()
      const exp  = Date.now() + 15 * 60 * 1000
      db.prepare('UPDATE users SET verification_code = ?, verification_code_exp = ? WHERE id = ?').run(code, exp, existing.id)
      sendVerificationCode(email, code)
      return res.status(200).json({ needsVerification: true, email })
    }
    return res.status(409).json({ error: 'Пользователь с таким email уже существует' })
  }

  const password_hash = await bcrypt.hash(password, 12)
  const code = generateCode()
  const exp  = Date.now() + 15 * 60 * 1000

  db.prepare(
    'INSERT INTO users (email, password_hash, username, coins, is_verified, verification_code, verification_code_exp, reg_ip, utm_source, utm_campaign) VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?)'
  ).run(email, password_hash, username || email.split('@')[0], code, exp, ip, utm_source || null, utm_campaign || null)

  try { await sendVerificationCode(email, code) } catch (err) { console.error('Email error:', err.message) }

  res.status(201).json({ needsVerification: true, email })
})

// POST /auth/verify-email
router.post('/verify-email', async (req, res) => {
  const email = sanitizeEmail(req.body.email)
  const code = sanitizeString(req.body.code, 10)

  if (!email || !code) return res.status(400).json({ error: 'Email и код обязательны' })

  const user = db.prepare('SELECT *, reg_ip FROM users WHERE email = ?').get(email)
  if (!user) return res.status(400).json({ error: 'Пользователь не найден' })
  if (user.is_verified) return res.status(400).json({ error: 'Email уже подтверждён' })
  if (!user.verification_code || user.verification_code !== code) {
    return res.status(400).json({ error: 'Неверный код' })
  }
  if (Date.now() > user.verification_code_exp) {
    return res.status(400).json({ error: 'Код устарел. Запросите новый.' })
  }

  const welcomeCoins = 15

  db.prepare('UPDATE users SET is_verified = 1, coins = ?, verification_code = NULL, verification_code_exp = NULL WHERE id = ?').run(welcomeCoins, user.id)
  db.prepare('INSERT INTO coin_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(user.id, welcomeCoins, 'bonus', 'Приветственный бонус за регистрацию')

  const updated = db.prepare('SELECT id, email, username, coins, is_admin, is_blocked, is_verified FROM users WHERE id = ?').get(user.id)
  const token = makeToken(updated.id)
  res.json({ token, user: updated })
})

// POST /auth/resend-code
router.post('/resend-code', (req, res) => {
  const email = sanitizeEmail(req.body.email)
  if (!email) return res.status(400).json({ error: 'Email обязателен' })

  const user = db.prepare('SELECT id, is_verified FROM users WHERE email = ?').get(email)
  if (!user || user.is_verified) return res.json({ success: true }) // silent

  const code = generateCode()
  const exp = Date.now() + 15 * 60 * 1000
  db.prepare('UPDATE users SET verification_code = ?, verification_code_exp = ? WHERE id = ?').run(code, exp, user.id)

  sendVerificationCode(email, code)
  res.json({ success: true })
})

// POST /auth/login
router.post('/login', async (req, res) => {
  const email = sanitizeEmail(req.body.email)
  const password = sanitizeString(req.body.password, 128)

  if (!email || !password) {
    return res.status(400).json({ error: 'Email и пароль обязательны' })
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
  if (!user) {
    // Одинаковое сообщение — не раскрываем существование аккаунта
    return res.status(401).json({ error: 'Неверный email или пароль' })
  }

  if (user.is_blocked) {
    return res.status(403).json({ error: 'Аккаунт заблокирован. Обратитесь в поддержку.' })
  }

  if (!user.is_verified) {
    return res.status(403).json({ error: 'Email не подтверждён. Проверьте почту.', needsVerification: true, email: user.email })
  }

  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) {
    return res.status(401).json({ error: 'Неверный email или пароль' })
  }

  const token = makeToken(user.id)
  const { password_hash, reset_token, reset_token_exp, ...safeUser } = user

  res.json({ token, user: safeUser })
})

// GET /auth/me
router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user })
})

// GET /auth/history
router.get('/history', authenticate, (req, res) => {
  const history = db.prepare(
    'SELECT * FROM analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT 20'
  ).all(req.user.id)
  res.json({ history })
})

function sendResetEmail(email, resetUrl) {
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
      <h2 style="color:#1a1a2e">Сброс пароля</h2>
      <p>Вы запросили сброс пароля для аккаунта <b>${email}</b>.</p>
      <p>Нажмите кнопку ниже. Ссылка действует <b>1 час</b>.</p>
      <a href="${resetUrl}" style="display:inline-block;margin:20px 0;padding:12px 28px;background:#2563eb;color:white;border-radius:8px;text-decoration:none;font-weight:600">
        Сбросить пароль
      </a>
      <p style="color:#94a3b8;font-size:13px">Если вы не запрашивали сброс — просто проигнорируйте это письмо.</p>
    </div>
  `

  // Resend API (preferred — тот же что и для верификации)
  if (process.env.RESEND_API_KEY) {
    const body = JSON.stringify({
      from: process.env.SMTP_FROM || 'Valorix AI <noreply@valorix.ru>',
      to: [email],
      subject: 'Сброс пароля — Valorix AI',
      html,
    })
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        if (res.statusCode >= 400) console.error('Resend reset error:', data)
        else console.log(`Reset email sent to ${email} via Resend`)
      })
    })
    req.on('error', err => console.error('Resend reset error:', err.message))
    req.setTimeout(10000, () => { req.destroy(); console.error('Resend reset timeout') })
    req.write(body)
    req.end()
    return
  }

  // Nodemailer fallback (SMTP)
  const mailer = createMailer()
  if (!mailer) {
    console.log(`[DEV] Password reset link: ${resetUrl}`)
    return
  }
  mailer.sendMail({ from: process.env.SMTP_FROM, to: email, subject: 'Сброс пароля — Valorix AI', html })
    .then(() => console.log(`Reset email sent to ${email} via SMTP`))
    .catch(err => console.error('SMTP reset error:', err.message))
}

// POST /auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const email = sanitizeEmail(req.body.email)
  if (!email) return res.status(400).json({ error: 'Укажите email' })

  // Всегда отвечаем успехом — не раскрываем существование аккаунта
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
  if (!user) return res.json({ success: true })

  const token = crypto.randomBytes(32).toString('hex')
  const exp = Date.now() + 60 * 60 * 1000 // 1 час

  db.prepare('UPDATE users SET reset_token = ?, reset_token_exp = ? WHERE id = ?').run(token, exp, user.id)

  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`
  sendResetEmail(email, resetUrl)

  res.json({ success: true })
})

// POST /auth/reset-password
router.post('/reset-password', async (req, res) => {
  const { token } = req.body
  const password = sanitizeString(req.body.password, 128)

  if (!token || !password) return res.status(400).json({ error: 'Токен и пароль обязательны' })
  if (password.length < 6) return res.status(400).json({ error: 'Пароль должен быть не менее 6 символов' })

  const user = db.prepare('SELECT id, reset_token_exp FROM users WHERE reset_token = ?').get(token)
  if (!user) return res.status(400).json({ error: 'Ссылка недействительна или уже использована' })
  if (Date.now() > user.reset_token_exp) return res.status(400).json({ error: 'Ссылка устарела. Запросите новую.' })

  const password_hash = await bcrypt.hash(password, 12)
  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_exp = NULL WHERE id = ?')
    .run(password_hash, user.id)

  res.json({ success: true })
})

module.exports = router
