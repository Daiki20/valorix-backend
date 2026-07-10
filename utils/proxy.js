const { HttpsProxyAgent } = require('https-proxy-agent')

// Set PROXY_URL=http://user:pass@host:port in Railway env vars
const PROXY_URL = process.env.PROXY_URL

// Russian/internal hosts that should NOT go through the proxy
const NO_PROXY_HOSTS = new Set([
  'api.direct.yandex.com',
  'fonbet.ru',
  'www.fonbet.ru',
  'localhost',
  '127.0.0.1',
])

let _agent = null

function getProxyAgent(hostname) {
  if (!PROXY_URL) return undefined
  if (hostname && NO_PROXY_HOSTS.has(hostname)) return undefined
  if (!_agent) _agent = new HttpsProxyAgent(PROXY_URL)
  return _agent
}

module.exports = { getProxyAgent }
