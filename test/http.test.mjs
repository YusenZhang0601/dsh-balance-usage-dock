/**
 * HTTP route contract tests (v0.2).
 *
 * No real server: registerRoute is given a fake webServer carrier and the
 * registered handler is driven with fake req/res objects.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { checkGuard, registerRoute } from '../lib/http.js'

const HOST = '127.0.0.1:55976'
const PATH = '/balance-usage-api'

function makeConfig(overrides = {}) {
  return { trustedHosts: [], requestTimeoutMs: 60, ...overrides }
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    chunks: [],
    ended: false,
  }
  res.writeHead = (status, headers) => {
    res.statusCode = status
    for (const [key, value] of Object.entries(headers ?? {})) res.headers[String(key).toLowerCase()] = value
    return res
  }
  res.setHeader = (key, value) => {
    res.headers[String(key).toLowerCase()] = value
  }
  res.write = (chunk) => {
    res.chunks.push(String(chunk))
    return true
  }
  res.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) res.chunks.push(String(chunk))
    res.ended = true
    return res
  }
  res.text = () => res.chunks.join('')
  res.json = () => JSON.parse(res.text())
  return res
}

function headerOf(res, name) {
  return res.headers[name.toLowerCase()]
}

function makeReq({ method = 'GET', url = `${PATH}?kind=ping`, host = HOST, headers = {} } = {}) {
  return { method, url, headers: { host, ...headers } }
}

function register(handlers, config = makeConfig()) {
  let registration = null
  const ctx = {
    get(name) {
      if (name !== 'webServer') return null
      return {
        register(options) {
          registration = options
          return () => {}
        },
      }
    },
    logger: { warn() {} },
  }
  const dispose = registerRoute(ctx, config, handlers)
  return {
    dispose,
    config,
    registration,
    handler: registration?.handler,
  }
}

async function call(route, req) {
  const res = makeRes()
  let timer = null
  try {
    const guard = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('timed out waiting for a response (request deadline is not enforced)')),
        2000,
      )
    })
    await Promise.race([Promise.resolve(route.handler(req, res)), guard])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
  assert.ok(res.ended, 'the handler must finish the response')
  return res
}

const PING = { ping: async () => ({ plugin: 'dsh-balance-usage-dock', version: '0.2.0' }) }

// ------------------------------------------------------------- registration

test('registerRoute: registers the exact read-only route and returns a disposer', () => {
  const route = register(PING)
  assert.ok(route.registration, 'webServer.register must be called')
  assert.equal(route.registration.path, PATH)
  assert.equal(route.registration.kind, 'exact')
  assert.equal(typeof route.registration.handler, 'function')
  assert.equal(typeof route.dispose, 'function')
  assert.doesNotThrow(() => route.dispose())
})

test('registerRoute: a missing webServer service degrades to a no-op disposer', () => {
  const ctx = { get: () => null, logger: { warn() {} } }
  const dispose = registerRoute(ctx, makeConfig(), PING)
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
})

// ------------------------------------------------------------------- guard

test('checkGuard: same-origin loopback GET passes', () => {
  assert.equal(checkGuard(makeReq(), makeConfig()), null)
  assert.equal(
    checkGuard(makeReq({ headers: { origin: `http://${HOST}` } }), makeConfig()),
    null,
  )
  assert.equal(
    checkGuard(makeReq({ headers: { 'sec-fetch-site': 'same-origin', origin: `http://${HOST}` } }), makeConfig()),
    null,
  )
})

test('checkGuard: rejects non-GET, foreign Host, foreign Origin and cross-site fetch', () => {
  const config = makeConfig()
  const method = checkGuard(makeReq({ method: 'POST' }), config)
  assert.ok(method, 'POST must be rejected')
  assert.equal(method.status, 405)

  const host = checkGuard(makeReq({ host: '192.168.1.9:55976' }), config)
  assert.ok(host, 'a LAN Host must be rejected')
  assert.equal(host.status, 403)

  const origin = checkGuard(makeReq({ headers: { origin: 'http://evil.example' } }), config)
  assert.ok(origin, 'a foreign Origin must be rejected')
  assert.equal(origin.status, 403)

  const site = checkGuard(makeReq({ headers: { 'sec-fetch-site': 'cross-site' } }), config)
  assert.ok(site, 'Sec-Fetch-Site: cross-site must be rejected')
  assert.equal(site.status, 403)

  const malformed = checkGuard(makeReq({ headers: { origin: 'not a url' } }), config)
  assert.ok(malformed, 'a malformed Origin must be rejected')
  assert.equal(malformed.status, 403)
})

test('checkGuard: config.trustedHosts allows an explicit extra host', () => {
  const config = makeConfig({ trustedHosts: ['192.168.1.9:55976'] })
  assert.equal(checkGuard(makeReq({ host: '192.168.1.9:55976' }), config), null)
})

test('route: a rejected request is a bad-request envelope with no data', async () => {
  const route = register(PING)
  const res = await call(route, makeReq({ host: 'evil.example' }))
  assert.ok([400, 403].includes(res.statusCode), `guard status must be 400|403, got ${res.statusCode}`)
  const body = res.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'bad-request')
  assert.equal(headerOf(res, 'cache-control'), 'no-store')
})

// ------------------------------------------------------------- envelopes

test('route: success envelope wraps the handler data and sends no-store', async () => {
  const route = register(PING)
  const res = await call(route, makeReq())
  assert.equal(res.statusCode, 200)
  assert.equal(headerOf(res, 'cache-control'), 'no-store')
  assert.match(String(headerOf(res, 'content-type')), /application\/json/)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.data, { plugin: 'dsh-balance-usage-dock', version: '0.2.0' })
})

test('route: an unknown kind is HTTP 400 bad-request, not retryable', async () => {
  const route = register(PING)
  const res = await call(route, makeReq({ url: `${PATH}?kind=nope` }))
  assert.equal(res.statusCode, 400)
  const body = res.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'bad-request')
  assert.equal(body.error.retryable, false)
  assert.match(body.error.message, /nope/)
})

test('route: a handler throw becomes HTTP 500 internal + retryable', async () => {
  const route = register({
    ping: () => {
      throw new Error('kaboom')
    },
  })
  const res = await call(route, makeReq())
  assert.equal(res.statusCode, 500)
  const body = res.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'internal')
  assert.equal(body.error.retryable, true)
})

test('route: a thrown {status: 400} is bad-request and not retryable', async () => {
  const route = register({
    session: () => {
      throw Object.assign(new Error('A session id is required.'), { status: 400 })
    },
  })
  const res = await call(route, makeReq({ url: `${PATH}?kind=session` }))
  assert.equal(res.statusCode, 400)
  const body = res.json()
  assert.equal(body.error.code, 'bad-request')
  assert.equal(body.error.retryable, false)
})

test('route: an upstream 503 is code "unavailable" and retryable', async () => {
  const route = register({
    overview: () => {
      throw Object.assign(new Error('upstream unavailable'), { status: 503 })
    },
  })
  const res = await call(route, makeReq({ url: `${PATH}?kind=overview` }))
  assert.equal(res.statusCode, 503)
  const body = res.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'unavailable')
  assert.equal(body.error.retryable, true)
})

test('route: a handler that never settles is cut off by requestTimeoutMs as unavailable', async () => {
  const route = register(
    {
      overview: () => new Promise(() => {}),
    },
    makeConfig({ requestTimeoutMs: 40 }),
  )
  const res = await call(route, makeReq({ url: `${PATH}?kind=overview` }))
  assert.ok([503, 504].includes(res.statusCode), `deadline must answer 503|504, got ${res.statusCode}`)
  const body = res.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'unavailable')
  assert.equal(body.error.retryable, true)
})
