/** Route path for every read-only endpoint this plugin serves. */
export const API_PATH = '/balance-usage-api'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

const TIMEOUT = Symbol('balance-usage timeout')

/**
 * Register the plugin's single exact route on the browser HTTP carrier.
 * Returns a disposer so the registration rides the plugin's effect.
 *
 * `sink` is optional and only receives `{ recordError(code, message) }` — it
 * powers the redacted diagnostics ring and never sees request payloads.
 */
export function registerRoute(ctx, config, handlers, sink) {
  const webServer = ctx.get('webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('[balance-usage] webServer service is unavailable; the dock will stay empty')
    return () => {}
  }
  const dispose = webServer.register({
    kind: 'exact',
    path: API_PATH,
    handler: (req, res) => handleRequest(req, res, config, handlers, sink),
  })
  return () => {
    try {
      dispose?.()
    } catch {
      // already disposed by the owning effect
    }
  }
}

async function handleRequest(req, res, config, handlers, sink) {
  let responded = false
  const send = (status, body) => {
    if (responded) return
    responded = true
    sendJson(res, status, body)
  }

  const rejection = checkGuard(req, config)
  if (rejection) {
    send(rejection.status, errorBody('bad-request', rejection.message, false))
    return
  }

  let url
  try {
    url = new URL(req.url ?? '/', 'http://localhost')
  } catch {
    send(400, errorBody('bad-request', 'Malformed request URL.', false))
    return
  }

  const kind = url.searchParams.get('kind') || 'overview'
  const handler = handlers[kind]
  if (typeof handler !== 'function') {
    send(400, errorBody('bad-request', `Unknown kind "${kind}".`, false))
    return
  }

  const deadlineMs = Math.max(1000, Number(config.requestTimeoutMs) || 15000)
  let timer = null
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), deadlineMs)
  })

  let outcome
  try {
    outcome = await Promise.race([
      Promise.resolve()
        .then(() => handler({ url, params: url.searchParams }))
        .then(
          (data) => ({ ok: true, data }),
          (error) => ({ ok: false, error }),
        ),
      deadline,
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }

  if (outcome === TIMEOUT) {
    record(sink, 'unavailable', 'timeout')
    send(504, errorBody('unavailable', 'The request timed out. Please retry.', true))
    return
  }

  if (outcome.ok) {
    send(200, { ok: true, data: outcome.data === undefined ? null : outcome.data })
    return
  }

  const error = outcome.error
  const status = Number.isInteger(error?.status) ? error.status : 500
  const code = status >= 500 ? (status === 503 || status === 504 ? 'unavailable' : 'internal') : 'bad-request'
  const retryable = status >= 500
  const message = sanitizeMessage(error?.message) || (retryable ? 'The request failed. Please retry.' : 'The request was rejected.')
  record(sink, code, message)
  send(status, errorBody(code, message, retryable))
}

function record(sink, code, message) {
  try {
    sink?.recordError?.(code, message)
  } catch {
    // diagnostics must never break a response
  }
  if (code === 'internal') {
    try {
      console.warn('[balance-usage] request failed:', message)
    } catch {
      // ignore
    }
  }
}

function errorBody(code, message, retryable) {
  return { ok: false, error: { code, message, retryable: Boolean(retryable) } }
}

/**
 * Strip anything that could leak a secret or a long URL, and bound the message.
 * Messages come from adapters and Node errors; they never legitimately need a
 * query string, a credential, or more than a couple of lines.
 */
export function sanitizeMessage(value) {
  if (typeof value !== 'string' || value === '') return ''
  let text = value
    .replace(/https?:\/\/[^\s]*/gi, (match) => match.split('?')[0])
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer ***')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
  if (text.length > 240) text = `${text.slice(0, 237)}...`
  return text
}

/**
 * Loopback / same-origin fence. The route only ever returns balance and usage
 * numbers, but it still must not be readable by arbitrary pages on the LAN.
 */
export function checkGuard(req, config) {
  if (req.method !== 'GET') {
    return { status: 405, message: 'Only GET is supported.' }
  }
  const host = String(req.headers.host ?? '')
  if (!isTrustedHost(host, config)) {
    return { status: 403, message: 'Host is not trusted.' }
  }
  const site = String(req.headers['sec-fetch-site'] ?? '')
  if (site && site !== 'same-origin' && site !== 'none') {
    return { status: 403, message: 'Cross-site requests are refused.' }
  }
  const origin = String(req.headers.origin ?? '')
  if (origin) {
    let originHost = ''
    try {
      originHost = new URL(origin).host
    } catch {
      return { status: 403, message: 'Origin is malformed.' }
    }
    if (originHost.toLowerCase() !== host.toLowerCase()) {
      return { status: 403, message: 'Origin does not match the request host.' }
    }
  }
  return null
}

function isTrustedHost(hostHeader, config) {
  const host = hostHeader.toLowerCase()
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  if (name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1') return true
  return config.trustedHosts.some((trusted) => String(trusted).toLowerCase() === host)
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  try {
    res.writeHead(status, {
      ...JSON_HEADERS,
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  } catch {
    // the carrier may already be closed; nothing else to do
  }
}
