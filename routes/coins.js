const express = require('express')
const https = require('https')
const crypto = require('crypto')
const { randomUUID } = require('crypto')
const db = require('../db')
const { authenticate } = require('../middleware/auth')

const router = express.Router()

const PACKAGES = [
  { id: 'pack_test', coins: 50,   price: 50,   label: '50 монет',   bonus: '' },
  { id: 'pack_100',  coins: 100,  price: 100,  label: '100 монет',  bonus: '' },
  { id: 'pack_300',  coins: 300,  price: 300,  label: '300 монет',  bonus: '' },
  { id: 'pack_600',  coins: 600,  price: 540,  label: '600 монет',  bonus: 'Скидка 10%' },
  { id: 'pack_1000', coins: 1000, price: 800,  label: '1000 монет', bonus: 'Скидка 20%' },
]

const VALID_PROMOS = { valor: 28 } // code.toLowerCase() → bonus coins

function resolvePromo(raw) {
  const code = (raw || '').trim().toLowerCase()
  const bonus = VALID_PROMOS[code]
  return bonus ? { code: code.toUpperCase(), bonus } : null
}

function yukassaRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const shopId = process.env.YUKASSA_SHOP_ID
    const secretKey = process.env.YUKASSA_SECRET_KEY
    const auth = Buffer.from(`${shopId}:${secretKey}`).toString('base64')
    const payload = body ? JSON.stringify(body) : null

    const options = {
      hostname: 'api.yookassa.ru',
      path: `/v3${path}`,
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Idempotence-Key': crypto.randomUUID(),
      },
    }
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload)

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (res.statusCode >= 400) reject(new Error(parsed.description || 'ЮКасса ошибка'))
          else resolve(parsed)
        } catch { reject(new Error('Ошибка парсинга ответа ЮКасса')) }
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// GET /coins/packages
router.get('/packages', (req, res) => {
  res.json({ packages: PACKAGES })
})

// GET /coins/balance
router.get('/balance', authenticate, (req, res) => {
  const user = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.user.id)
  res.json({ coins: user?.coins ?? 0 })
})

// POST /coins/create-payment — создать платёж в ЮКассе
router.post('/create-payment', authenticate, async (req, res) => {
  const { packageId, paymentMethod, promoCode } = req.body
  const pkg = PACKAGES.find(p => p.id === packageId)
  if (!pkg) return res.status(400).json({ error: 'Неверный пакет' })

  const promo = resolvePromo(promoCode)
  const allowedMethods = ['bank_card', 'sbp', 'sberbank', 'tinkoff_bank']
  const method = allowedMethods.includes(paymentMethod) ? paymentMethod : null

  try {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173'
    const paymentBody = {
      amount: { value: pkg.price.toFixed(2), currency: 'RUB' },
      confirmation: {
        type: 'redirect',
        return_url: `${frontendUrl}/payment-return`,
      },
      capture: true,
      description: `Valorix AI — ${pkg.label}${promo ? ` + промокод ${promo.code}` : ''}`,
      metadata: {
        userId: String(req.user.id),
        coins: String(pkg.coins),
        packageId: pkg.id,
        ...(promo ? { promoCode: promo.code, promoBonus: String(promo.bonus) } : {}),
      },
    }
    if (method) paymentBody.payment_method_data = { type: method }
    const payment = await yukassaRequest('POST', '/payments', paymentBody)

    db.prepare('INSERT OR IGNORE INTO pending_payments (id, user_id, coins, package_id) VALUES (?, ?, ?, ?)')
      .run(payment.id, req.user.id, pkg.coins, pkg.id)

    res.json({
      confirmationUrl: payment.confirmation.confirmation_url,
      paymentId: payment.id,
      promoApplied: !!promo,
      promoBonus: promo ? promo.bonus : 0,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /coins/verify-payment/:paymentId — проверить статус и зачислить монеты
router.get('/verify-payment/:paymentId', authenticate, async (req, res) => {
  const { paymentId } = req.params

  // Проверяем не зачислено ли уже
  const alreadyDone = db.prepare('SELECT * FROM pending_payments WHERE id = ? AND status = ?')
    .get(paymentId, 'done')
  if (alreadyDone) {
    const user = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.user.id)
    return res.json({ status: 'already_credited', coins: user.coins })
  }

  try {
    const payment = await yukassaRequest('GET', `/payments/${paymentId}`)

    if (payment.status !== 'succeeded') {
      return res.json({ status: payment.status })
    }

    // Берём кол-во монет из нашей БД или из metadata платежа
    const pending = db.prepare('SELECT * FROM pending_payments WHERE id = ?').get(paymentId)
    const coins = pending ? pending.coins : parseInt(payment.metadata?.coins || '0', 10)
    const userId = pending ? pending.user_id : parseInt(payment.metadata?.userId || '0', 10)

    if (!coins || isNaN(coins) || coins <= 0 || isNaN(userId) || userId !== req.user.id) {
      return res.status(400).json({ error: 'Ошибка верификации платежа' })
    }

    const promoCode = payment.metadata?.promoCode || null
    const promoBonus = promoCode ? parseInt(payment.metadata?.promoBonus || '0', 10) : 0
    const totalCoins = coins + (promoBonus > 0 ? promoBonus : 0)

    db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(totalCoins, req.user.id)
    db.prepare('INSERT OR IGNORE INTO pending_payments (id, user_id, coins, package_id, status) VALUES (?, ?, ?, ?, ?)')
      .run(paymentId, req.user.id, coins, payment.metadata?.packageId || '', 'done')
    db.prepare('UPDATE pending_payments SET status = ? WHERE id = ?').run('done', paymentId)
    db.prepare('INSERT INTO coin_transactions (user_id, amount, type, description, payment_id) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, coins, 'purchase', `Пополнение ${coins} монет`, paymentId)
    if (promoBonus > 0) {
      db.prepare('INSERT INTO coin_transactions (user_id, amount, type, description, payment_id) VALUES (?, ?, ?, ?, ?)')
        .run(req.user.id, promoBonus, 'bonus', `Бонус по промокоду ${promoCode}: +${promoBonus} монет`, paymentId)
    }

    const user = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.user.id)
    res.json({ status: 'credited', coins: user?.coins ?? 0, promoBonus: promoBonus > 0 ? promoBonus : 0 })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /coins/spend — списать монеты за анализ
router.post('/spend', authenticate, (req, res) => {
  const { amount = 46, matchHome, matchAway, league, result } = req.body
  const isAdmin = req.user.is_admin === 1

  if (!isAdmin) {
    const user = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.user.id)
    if (!user || user.coins < amount) {
      return res.status(402).json({ error: 'Недостаточно монет', coins: user.coins })
    }
    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(amount, req.user.id)
    db.prepare('INSERT INTO coin_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)')
      .run(req.user.id, -amount, 'spend', `Анализ матча: ${matchHome} vs ${matchAway}`)
  }

  const insertResult = db.prepare('INSERT INTO analyses (user_id, match_home, match_away, league, result, coins_spent) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, matchHome || '', matchAway || '', league || '', JSON.stringify(result) || '', isAdmin ? 0 : amount)

  const shareToken = randomUUID()
  db.prepare('UPDATE analyses SET share_token = ? WHERE id = ?').run(shareToken, insertResult.lastInsertRowid)

  const updated = db.prepare('SELECT coins FROM users WHERE id = ?').get(req.user.id)
  res.json({ success: true, coins: updated?.coins ?? 0, shareToken })
})

// GET /coins/transactions
router.get('/transactions', authenticate, (req, res) => {
  const txs = db.prepare('SELECT * FROM coin_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id)
  res.json({ transactions: txs })
})

// POST /coins/yukassa-webhook
router.post('/yukassa-webhook', (req, res) => {
  const event = req.body
  if (event.event !== 'payment.succeeded') return res.sendStatus(200)

  const { metadata } = event.object
  if (!metadata?.userId || !metadata?.coins) return res.sendStatus(200)

  const userId = parseInt(metadata.userId, 10)
  const coins = parseInt(metadata.coins, 10)

  if (isNaN(userId) || userId <= 0 || isNaN(coins) || coins <= 0) {
    console.error('[webhook] Invalid metadata:', metadata)
    return res.sendStatus(400)
  }

  // Проверяем не зачислено ли уже (защита от двойного зачисления)
  const alreadyDone = db.prepare('SELECT id FROM pending_payments WHERE id = ? AND status = ?')
    .get(event.object.id, 'done')
  if (alreadyDone) {
    console.log(`[webhook] already credited: ${event.object.id}`)
    return res.sendStatus(200)
  }

  const promoCode = metadata.promoCode || null
  const promoBonus = promoCode ? parseInt(metadata.promoBonus || '0', 10) : 0
  const totalCoins = coins + (promoBonus > 0 ? promoBonus : 0)

  db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(totalCoins, userId)
  db.prepare('INSERT OR IGNORE INTO pending_payments (id, user_id, coins, package_id, status) VALUES (?, ?, ?, ?, ?)')
    .run(event.object.id, userId, coins, metadata.packageId || '', 'done')
  db.prepare('UPDATE pending_payments SET status = ? WHERE id = ?').run('done', event.object.id)
  db.prepare('INSERT INTO coin_transactions (user_id, amount, type, description, payment_id) VALUES (?, ?, ?, ?, ?)')
    .run(userId, coins, 'purchase', `Пополнение ${coins} монет`, event.object.id)
  if (promoBonus > 0) {
    db.prepare('INSERT INTO coin_transactions (user_id, amount, type, description, payment_id) VALUES (?, ?, ?, ?, ?)')
      .run(userId, promoBonus, 'bonus', `Бонус по промокоду ${promoCode}: +${promoBonus} монет`, event.object.id)
  }

  console.log(`[webhook] Payment: user ${userId} got ${totalCoins} coins${promoBonus > 0 ? ` (incl. promo +${promoBonus})` : ''}`)
  res.sendStatus(200)
})

module.exports = router
