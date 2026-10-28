/**
 * Price engine contract tests (v0.2).
 *
 * The parser is tested against a trimmed copy of the live DeepSeek page; the
 * engine is fed stub fetch / stub provider catalogs so no network is needed.
 * Everything here is asserted against docs/contract-v2.md + INTERFACES.md.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPricingEngine, parseOfficialPricing } from '../lib/pricing.js'

const OFFICIAL_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
const MODELS_DEV_URL = 'https://models.dev/api.json'
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const HTML = fixture('official-pricing.html')
const CORRUPTED = fixture('official-pricing-corrupted.html')

const ctx = { logger: { warn() {} } }

function makeConfig(overrides = {}) {
  return {
    peakTimeZone: 'Asia/Shanghai',
    statsTimeZone: 'Asia/Shanghai',
    // Legacy compatibility key: keep it valid too, so the test does not depend
    // on which one the engine reads while v0.2 lands.
    dayTimeZoneOffsetHours: 8,
    holidays: [],
    peakWindows: [
      { start: 9, end: 12 },
      { start: 14, end: 18 },
    ],
    peakWeekdays: [1, 2, 3, 4, 5],
    pricingSources: ['official-page'],
    officialPricingUrls: [OFFICIAL_URL],
    modelsDevUrl: MODELS_DEV_URL,
    pricingTtlSec: 43200,
    priceOverrides: {},
    modelAliases: {},
    extraPriceCatalogs: [],
    ...overrides,
  }
}

/** Serve fixture responses for the engine's own `fetch` calls, then restore. */
async function withFetch(routes, fn) {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    const route = routes[url]
    if (!route) throw new Error(`unexpected fetch: ${url}`)
    const { body, contentType = 'application/json' } = route
    return new Response(body, { status: 200, headers: { 'content-type': contentType } })
  }
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = realFetch
  }
}

function officialRoute() {
  return {
    [OFFICIAL_URL]: { body: HTML, contentType: 'text/html; charset=utf-8' },
  }
}

/** `confidence` was added in v0.2; accept either spelling from the engine. */
function confidenceOf(price) {
  return price?.confidence ?? price?.pricingConfidence ?? null
}

const CONFIDENCES = new Set(['exact', 'family', 'community', 'override', 'none'])

// --------------------------------------------------------------- parsing

test('parseOfficialPricing: reads the trimmed official table (flash + pro, idle + peak)', () => {
  const parsed = parseOfficialPricing(HTML)
  assert.ok(parsed, 'the official table must be locatable')
  assert.equal(parsed.warning, null, 'a well-formed table must not warn')

  const { flash, pro } = parsed.table
  assert.deepEqual(flash.cacheHit, { idle: 0.02, peak: 0.04 })
  assert.deepEqual(flash.cacheMiss, { idle: 1, peak: 2 })
  assert.deepEqual(flash.output, { idle: 4, peak: 8 })
  assert.deepEqual(pro.cacheHit, { idle: 0.15, peak: 0.3 })
  assert.deepEqual(pro.cacheMiss, { idle: 4.5, peak: 9 })
  assert.deepEqual(pro.output, { idle: 13.5, peak: 27 })
})

test('parseOfficialPricing: a corrupted table degrades with a warning or returns null', () => {
  const parsed = parseOfficialPricing(CORRUPTED)
  const degraded = parsed === null || typeof parsed.warning === 'string'
  assert.ok(degraded, 'a broken peak/idle invariant must not be silently trusted')
  if (parsed) assert.ok(parsed.warning.length > 0)
})

test('parseOfficialPricing: a page without the price table returns null', () => {
  assert.equal(parseOfficialPricing('<html><body><table><tr><td>no pricing here</td></tr></table></body></html>'), null)
  assert.equal(parseOfficialPricing('<html><body>empty</body></html>'), null)
})

// --------------------------------------------------------------- peak/idle

test('priceAt: peak at 2026-10-28T10:00+08:00 and 02:00Z, idle at 12:30+08:00', async () => {
  await withFetch(officialRoute(), async () => {
    const engine = createPricingEngine(ctx, makeConfig())
    const price = await engine.resolveModel('deepseek-official', 'deepseek-flash')
    assert.ok(price, 'official price must resolve for deepseek-flash')
    assert.equal(price.source, 'official-page')
    assert.equal(price.currency, 'CNY')
    assert.equal(price.unit, 'per-million-tokens')

    const peak = engine.priceAt(price, Date.parse('2026-10-28T10:00:00+08:00'))
    assert.deepEqual(peak, { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 0, output: 8 })

    const idle = engine.priceAt(price, Date.parse('2026-10-28T12:30:00+08:00'))
    assert.deepEqual(idle, { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 0, output: 4 })

    // Same instant, given as UTC epoch milliseconds.
    const utcPeak = engine.priceAt(price, Date.parse('2026-10-28T02:00:00Z'))
    assert.deepEqual(utcPeak, peak)

    // Weekend and the daily 12:00-14:00 gap are off-peak.
    assert.deepEqual(engine.priceAt(price, Date.parse('2026-10-31T10:00:00+08:00')), idle)
  })
})

test('isPeak: a US peakTimeZone moves the same instant into the peak window', async () => {
  await withFetch(officialRoute(), async () => {
    const shanghai = createPricingEngine(ctx, makeConfig())
    const newYork = createPricingEngine(
      ctx,
      makeConfig({ peakTimeZone: 'America/New_York', dayTimeZoneOffsetHours: -5 }),
    )
    // 19:00Z = 15:00 New York (peak) = 03:00 next day Shanghai (idle).
    const instant = Date.parse('2026-10-28T19:00:00Z')
    assert.equal(newYork.isPeak(instant), true, 'New York 15:00 is inside 14:00-18:00')
    assert.equal(shanghai.isPeak(instant), false, 'Shanghai 03:00 is outside every peak window')

    // 14:00Z = 10:00 New York (peak); Shanghai 22:00 (idle).
    assert.equal(newYork.isPeak(Date.parse('2026-10-28T14:00:00Z')), true)
    assert.equal(shanghai.isPeak(Date.parse('2026-10-28T14:00:00Z')), false)
  })
})

test('isPeak: config.holidays forces a weekday all-day off-peak', async () => {
  await withFetch(officialRoute(), async () => {
    const engine = createPricingEngine(ctx, makeConfig({ holidays: ['2026-10-28'] }))
    const price = await engine.resolveModel('deepseek-official', 'deepseek-flash')
    const holidayNoon = Date.parse('2026-10-28T10:00:00+08:00')
    assert.equal(engine.isPeak(holidayNoon), false, 'a configured holiday is off-peak all day')
    assert.deepEqual(engine.priceAt(price, holidayNoon), {
      cacheHit: 0.02,
      cacheMiss: 1,
      cacheWrite: 0,
      output: 4,
    })
    assert.equal(engine.isPeak(Date.parse('2026-10-29T10:00:00+08:00')), true, 'the next day is a peak weekday')
  })
})

// --------------------------------------------------------------- overrides

test('priceOverrides: highest priority, and confidence is "override"', async () => {
  const override = {
    currency: 'CNY',
    cacheHit: { idle: 0.01, peak: 0.02 },
    cacheMiss: { idle: 0.5, peak: 1 },
    cacheWrite: { idle: 0, peak: 0 },
    output: { idle: 2, peak: 4 },
  }
  const engine = createPricingEngine(
    ctx,
    makeConfig({
      priceOverrides: { 'deepseek-official/deepseek-flash': override },
      pricingSources: ['provider-catalog', 'official-page'],
    }),
    {
      getProviderPrices: async () => ({
        source: 'provider-catalog',
        url: 'fixture://catalog',
        fetchedAt: Date.now(),
        currency: 'USD',
        unit: 'per-million-tokens',
        models: [{ match: 'deepseek-flash', cacheHit: 0.001, cacheMiss: 0.01, cacheWrite: 0, output: 0.02 }],
      }),
    },
  )
  const price = await engine.resolveModel('deepseek-official', 'deepseek-flash')
  assert.ok(price)
  assert.equal(price.source, 'override')
  assert.equal(price.currency, 'CNY')
  assert.equal(confidenceOf(price), 'override')
  assert.deepEqual(engine.priceAt(price, Date.parse('2026-10-28T12:30:00+08:00')), {
    cacheHit: 0.01,
    cacheMiss: 0.5,
    cacheWrite: 0,
    output: 2,
  })
})

// --------------------------------------------------------------- catalogs

test('provider-catalog beats official-page when both are enabled', async () => {
  let fetched = 0
  const engine = createPricingEngine(
    ctx,
    makeConfig({ pricingSources: ['provider-catalog', 'official-page'] }),
    {
      getProviderPrices: async () => {
        return {
          source: 'provider-catalog',
          url: 'fixture://catalog',
          fetchedAt: Date.now(),
          currency: 'USD',
          unit: 'per-million-tokens',
          models: [{ match: 'deepseek-flash', cacheHit: 0.028, cacheMiss: 0.28, cacheWrite: 0, output: 0.42 }],
        }
      },
    },
  )
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetched += 1
    throw new Error('official page must not be fetched when the provider catalog matches')
  }
  try {
    const price = await engine.resolveModel('deepseek-official', 'deepseek-flash')
    assert.ok(price)
    assert.equal(price.source, 'provider-catalog')
    assert.equal(price.currency, 'USD')
    assert.deepEqual(engine.priceAt(price, Date.parse('2026-10-28T12:30:00+08:00')), {
      cacheHit: 0.028,
      cacheMiss: 0.28,
      cacheWrite: 0,
      output: 0.42,
    })
    assert.ok(CONFIDENCES.has(confidenceOf(price)), `unexpected confidence: ${confidenceOf(price)}`)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(fetched, 0)
})

test('modelAliases: a normalized id maps onto the provider catalog entry', async () => {
  const deps = {
    getProviderPrices: async () => ({
      source: 'provider-catalog',
      url: 'fixture://catalog',
      fetchedAt: Date.now(),
      currency: 'USD',
      unit: 'per-million-tokens',
      models: [{ match: 'deepseek/deepseek-chat', cacheHit: 0.028, cacheMiss: 0.28, cacheWrite: 0, output: 0.42 }],
    }),
  }
  const plain = createPricingEngine(
    ctx,
    makeConfig({ pricingSources: ['provider-catalog'], officialPricingUrls: [] }),
    deps,
  )
  assert.equal(
    await plain.resolveModel('my-relay', 'my-relay/fast'),
    null,
    'without an alias the relay model id must not match the catalog',
  )

  const aliased = createPricingEngine(
    ctx,
    makeConfig({
      pricingSources: ['provider-catalog'],
      officialPricingUrls: [],
      modelAliases: { 'my-relay/fast': 'deepseek/deepseek-chat' },
    }),
    deps,
  )
  const price = await aliased.resolveModel('my-relay', 'my-relay/fast')
  assert.ok(price, 'the alias must reach the provider catalog entry')
  assert.equal(price.source, 'provider-catalog')
  assert.equal(price.currency, 'USD')
  assert.ok(CONFIDENCES.has(confidenceOf(price)), `unexpected confidence: ${confidenceOf(price)}`)
})

test('official-page: versioned DeepSeek ids normalize to flash/pro tiers', async () => {
  await withFetch(officialRoute(), async () => {
    const engine = createPricingEngine(ctx, makeConfig())
    const flash = await engine.resolveModel('deepseek-official', 'deepseek-flash')
    assert.ok(flash)
    assert.equal(confidenceOf(flash), 'exact', 'a direct official model match is exact')

    const versioned = await engine.resolveModel('deepseek-official', 'deepseek-v4.1-flash-1017')
    assert.ok(versioned, 'a versioned flash id must still resolve on the official page')
    assert.ok(
      ['exact', 'family'].includes(confidenceOf(versioned)),
      `versioned id confidence must be exact|family, got ${confidenceOf(versioned)}`,
    )

    const pro = await engine.resolveModel('deepseek-official', 'deepseek-v4-pro')
    assert.ok(pro)
    assert.deepEqual(engine.priceAt(pro, Date.parse('2026-10-28T12:30:00+08:00')), {
      cacheHit: 0.15,
      cacheMiss: 4.5,
      cacheWrite: 0,
      output: 13.5,
    })
  })
})

test('models.dev: community fallback is USD, marked community, confidence "community"', async () => {
  const data = JSON.stringify({
    deepseek: {
      models: {
        'deepseek-flash': { cost: { input: 0.28, output: 0.42, cache_read: 0.028 } },
      },
    },
  })
  await withFetch(
    { [MODELS_DEV_URL]: { body: data } },
    async () => {
      const engine = createPricingEngine(
        ctx,
        makeConfig({ pricingSources: ['models.dev'], officialPricingUrls: [] }),
      )
      const price = await engine.resolveModel('deepseek-official', 'deepseek-flash')
      assert.ok(price, 'models.dev price must resolve')
      assert.equal(price.source, 'models.dev')
      assert.equal(price.currency, 'USD')
      assert.equal(price.community, true)
      assert.equal(confidenceOf(price), 'community')
      assert.deepEqual(engine.priceAt(price, Date.parse('2026-10-28T12:30:00+08:00')), {
        cacheHit: 0.028,
        cacheMiss: 0.28,
        cacheWrite: 0,
        output: 0.42,
      })
    },
  )
})

test('snapshot: kind=pricing payload carries the IANA peak zone and keeps the offset', async () => {
  await withFetch(officialRoute(), async () => {
    const engine = createPricingEngine(ctx, makeConfig())
    const snapshot = await engine.snapshot()
    assert.equal(snapshot.source, 'official-page')
    assert.equal(snapshot.currency, 'CNY')
    assert.equal(snapshot.unit, 'per-million-tokens')
    assert.equal(snapshot.warning, null)
    assert.equal(snapshot.stale, false)
    assert.deepEqual(snapshot.models.flash.cacheMiss, { idle: 1, peak: 2 })
    assert.ok(snapshot.peak, 'snapshot.peak is part of the frozen payload')
    assert.equal(snapshot.peak.timeZone, 'Asia/Shanghai', 'v0.2 replaced the offset with an IANA zone')
    assert.equal(snapshot.peak.timeZoneOffsetHours, 8, 'the offset is kept for back-compat')
  })
})
