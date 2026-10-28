/**
 * Usage engine contract tests (v0.2).
 *
 * Synthetic session events cover three provider/model switches, a fork's
 * inherited prefix and one subagent session; the price engine is a stub so the
 * arithmetic below is exact and readable.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsageEngine } from '../lib/usage.js'

const BASE = Date.parse('2026-10-27T00:00:00Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const PRICES = {
  'deepseek-official|deepseek-flash': {
    source: 'official-page',
    currency: 'CNY',
    unit: 'per-million-tokens',
    confidence: 'exact',
    community: false,
    fetchedAt: BASE,
    cacheHit: { idle: 0.02, peak: 0.04 },
    cacheMiss: { idle: 1, peak: 2 },
    cacheWrite: { idle: 0, peak: 0 },
    output: { idle: 4, peak: 8 },
  },
  'deepseek-official|deepseek-v4-pro': {
    source: 'official-page',
    currency: 'CNY',
    unit: 'per-million-tokens',
    confidence: 'exact',
    community: false,
    fetchedAt: BASE,
    cacheHit: { idle: 0.15, peak: 0.3 },
    cacheMiss: { idle: 4.5, peak: 9 },
    cacheWrite: { idle: 0, peak: 0 },
    output: { idle: 13.5, peak: 27 },
  },
  'openrouter|deepseek/deepseek-chat': {
    source: 'provider-catalog',
    currency: 'USD',
    unit: 'per-million-tokens',
    confidence: 'exact',
    community: false,
    fetchedAt: BASE,
    cacheHit: { idle: 0.028, peak: 0.056 },
    cacheMiss: { idle: 0.28, peak: 0.56 },
    cacheWrite: { idle: 0, peak: 0 },
    output: { idle: 0.42, peak: 0.84 },
  },
  'moonshot|kimi-k2': {
    source: 'models.dev',
    currency: 'USD',
    unit: 'per-million-tokens',
    confidence: 'community',
    community: true,
    fetchedAt: BASE,
    cacheHit: { idle: 0.02, peak: 0.02 },
    cacheMiss: { idle: 0.5, peak: 0.5 },
    cacheWrite: { idle: 0.1, peak: 0.1 },
    output: { idle: 2, peak: 2 },
  },
}

function makePricing({ peak = false } = {}) {
  return {
    async resolveModel(provider, model) {
      return PRICES[`${provider}|${model}`] ?? null
    },
    isPeak() {
      return peak
    },
    priceAt(price) {
      const bucket = peak ? 'peak' : 'idle'
      return {
        cacheHit: Number(price.cacheHit?.[bucket] ?? 0),
        cacheMiss: Number(price.cacheMiss?.[bucket] ?? 0),
        cacheWrite: Number(price.cacheWrite?.[bucket] ?? 0),
        output: Number(price.output?.[bucket] ?? 0),
      }
    },
  }
}

function makeConfig(overrides = {}) {
  return {
    statsDays: 90,
    statsCacheSec: 300,
    statsSessionLimit: 200,
    pricingTtlSec: 43200,
    statsTimeZone: 'UTC',
    // Legacy compatibility: a +8 bucketing implementation must fail the
    // non-+8 timezone assertion below.
    dayTimeZoneOffsetHours: 8,
    peakTimeZone: 'Asia/Shanghai',
    holidays: [],
    ...overrides,
  }
}

function sessionOf(events, inheritedEventCount = 0) {
  return {
    inheritedEventCount,
    snapshotEvents() {
      return events
    },
  }
}

/** Root session: 3 own steps across 3 providers, behind a 3-event fork prefix. */
function rootEvents() {
  const events = [
    // Inherited fork prefix (seq < inheritedEventCount): must never be billed.
    { seq: 0, type: 'request/header', time: BASE, data: { header: { config: { provider: 'xai', model: 'grok-4' } } } },
    { seq: 1, type: 'step/start', time: BASE, data: { turn: 1, step: 1 } },
    {
      seq: 2,
      type: 'assistant/message',
      time: BASE + 10,
      data: { turn: 1, step: 1, usage: { inputTokens: 999_999, outputTokens: 999_999 } },
    },
    // Own events.
    {
      seq: 3,
      type: 'request/header',
      time: BASE + 1000,
      data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } },
    },
    { seq: 4, type: 'step/start', time: BASE + 1000, data: { turn: 1, step: 1 } },
    {
      seq: 5,
      type: 'assistant/message',
      time: BASE + 1010,
      data: {
        turn: 1,
        step: 1,
        usage: { inputTokens: 1000, outputTokens: 500 },
        message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } },
      },
    },
    {
      seq: 6,
      type: 'request/context',
      time: BASE + 2000,
      data: { provider: 'openrouter', model: 'deepseek/deepseek-chat' },
    },
    { seq: 7, type: 'step/start', time: BASE + 2000, data: { turn: 1, step: 2 } },
    {
      seq: 8,
      type: 'assistant/message',
      time: BASE + 2010,
      data: {
        turn: 1,
        step: 2,
        usage: { inputTokens: 2000, cacheReadTokens: 1000, outputTokens: 200 },
        message: { source: { provider: 'openrouter', model: 'deepseek/deepseek-chat' } },
      },
    },
    {
      seq: 9,
      type: 'request/header',
      time: BASE + 3000,
      data: { header: { config: { provider: 'moonshot', model: 'kimi-k2' } } },
    },
    { seq: 10, type: 'step/start', time: BASE + 3000, data: { turn: 2, step: 1 } },
    {
      seq: 11,
      type: 'assistant/message',
      time: BASE + 3010,
      data: {
        turn: 2,
        step: 1,
        usage: { inputTokens: 3000, cacheWriteTokens: 500, outputTokens: 1000 },
        message: { source: { provider: 'moonshot', model: 'kimi-k2' } },
      },
    },
  ]
  return events
}

/** Subagent session: one deepseek-pro step. */
function childEvents() {
  return [
    {
      seq: 0,
      type: 'request/header',
      time: BASE + 5000,
      data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } },
    },
    { seq: 1, type: 'step/start', time: BASE + 5000, data: { turn: 1, step: 1 } },
    {
      seq: 2,
      type: 'assistant/message',
      time: BASE + 5010,
      data: {
        turn: 1,
        step: 1,
        usage: { inputTokens: 1000, outputTokens: 100 },
        message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
      },
    },
  ]
}

function makeCtx({ sessions, descendants, listSessions }) {
  return {
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions.get(id) ?? null }
      if (name === 'subagents') {
        if (!descendants) return null
        return {
          async listDescendants() {
            return descendants.map((id) => ({ id, kind: 'child' }))
          },
        }
      }
      if (name === 'sessionQuery') return listSessions ? { listSessions } : null
      return null
    },
    logger: { warn() {} },
  }
}

function amountOf(list, currency) {
  const entry = (list ?? []).find((item) => item.currency === currency)
  return entry ? Number(entry.amount) : 0
}

function assertClose(actual, expected, message) {
  assert.ok(Math.abs(Number(actual) - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`)
}

// ------------------------------------------------------------- session fold

test('sessionUsage: cumulative tokens/costs + byModel across 3 providers and a fork prefix', async () => {
  const sessions = new Map()
  sessions.set('root', sessionOf(rootEvents(), 3))
  sessions.set('child-1', sessionOf(childEvents(), 0))
  const ctx = makeCtx({ sessions, descendants: ['root', 'child-1'] })
  const engine = createUsageEngine(ctx, makeConfig(), makePricing())

  const payload = await engine.sessionUsage('root')

  // Whole turn tree tokens: own 6000/1000/500/1700 + child 1000/0/0/100.
  assert.deepEqual(payload.tokens, { input: 7000, cacheRead: 1000, cacheWrite: 500, output: 1800 })

  // Fork prefix is skipped: xai/grok-4 tokens never appear in any bucket.
  assert.equal(payload.tokens.input, 7000)

  // Per-currency costs (whole tree).
  assertClose(amountOf(payload.costs, 'CNY'), 0.00885, 'CNY costs')
  assertClose(amountOf(payload.costs, 'USD'), 0.004222, 'USD costs')

  // byModel is additive: amounts per currency sum to the top-level costs.
  assert.ok(Array.isArray(payload.byModel), 'v0.2 adds byModel')
  const byModel = payload.byModel
  assert.equal(byModel.length, 4, 'three root models + one subagent model')
  assertClose(byModel.reduce((sum, row) => sum + amountOf(row.costs, 'CNY'), 0), 0.00885, 'byModel CNY sum')
  assertClose(byModel.reduce((sum, row) => sum + amountOf(row.costs, 'USD'), 0), 0.004222, 'byModel USD sum')

  const flash = byModel.find((row) => row.model === 'deepseek-flash')
  assert.ok(flash, 'deepseek-flash must be present in byModel')
  assert.equal(flash.provider, 'deepseek-official')
  assert.deepEqual(flash.tokens, { input: 1000, cacheRead: 0, cacheWrite: 0, output: 500 })
  assertClose(amountOf(flash.costs, 'CNY'), 0.003, 'flash cost')

  const relay = byModel.find((row) => row.model === 'deepseek/deepseek-chat')
  assert.ok(relay, 'openrouter model must be present')
  assertClose(amountOf(relay.costs, 'USD'), 0.000672, 'relay cost')

  const moonshot = byModel.find((row) => row.model === 'kimi-k2')
  assert.ok(moonshot, 'moonshot model must be present')
  assertClose(amountOf(moonshot.costs, 'USD'), 0.00355, 'kimi cost')

  const pro = byModel.find((row) => row.model === 'deepseek-v4-pro')
  assert.ok(pro, 'the subagent model must be part of the session breakdown')
  assertClose(amountOf(pro.costs, 'CNY'), 0.00585, 'pro cost')

  assert.equal(payload.priced, true)
  assert.equal(payload.mixedProviders, true, 'three distinct providers with priced events')
  assert.equal(payload.pricingConfidence, 'community', 'weakest confidence used is models.dev')
  assert.ok(['exact', 'family', 'community', 'override', 'none'].includes(payload.pricingConfidence))
  assert.ok(['official-page', 'provider-catalog', 'extra-catalog', 'models.dev', 'override', 'none'].includes(payload.priceSource))
  assert.equal(payload.provider, 'moonshot')
  assert.equal(payload.model, 'kimi-k2')

  // Subagent rollup isolates the child session.
  assert.equal(payload.subagent.sessions, 1)
  assert.equal(payload.subagent.requested, 1)
  assert.equal(payload.subagent.unavailable, false)
  assert.deepEqual(payload.subagent.tokens, { input: 1000, cacheRead: 0, cacheWrite: 0, output: 100 })
  assertClose(amountOf(payload.subagent.costs, 'CNY'), 0.00585, 'subagent CNY costs')
  assert.equal(payload.subagent.priced, true)
})

test('sessionUsage: inherited fork events are skipped even when they carry usage', async () => {
  const sessions = new Map()
  sessions.set('fork', sessionOf(rootEvents(), 3))
  const ctx = makeCtx({ sessions, descendants: null })
  const engine = createUsageEngine(ctx, makeConfig(), makePricing())
  const payload = await engine.sessionUsage('fork')
  assert.equal(payload.tokens.input, 6000, 'only seq >= 3 contributes tokens')
  assert.ok(!(payload.byModel ?? []).some((row) => row.model === 'grok-4'), 'the fork prefix model must not appear')
})

test('sessionUsage: missing subagents service degrades to parent-only, not a throw', async () => {
  const sessions = new Map()
  sessions.set('root', sessionOf(rootEvents(), 3))
  const ctx = makeCtx({ sessions, descendants: null })
  const engine = createUsageEngine(ctx, makeConfig(), makePricing())
  const payload = await engine.sessionUsage('root')
  assert.equal(payload.priced, true)
  assert.equal(payload.subagent.unavailable, true)
  assert.equal(payload.subagent.sessions, 0)
  assert.equal(payload.subagent.requested, 0)
  assert.deepEqual(payload.subagent.tokens, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
})

// ------------------------------------------------------------------- stats

test('stats: daily buckets use config.statsTimeZone (UTC here), not a hard-coded +8', async () => {
  const now = Date.now()
  const date = new Date(now)
  const todayUtcStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  // 22:00Z on the previous UTC day: UTC bucket = yesterday, +8 bucket = today.
  const eventTime = todayUtcStart - 2 * HOUR
  const utcKey = new Date(eventTime).toISOString().slice(0, 10)
  const plus8Key = new Date(eventTime + 8 * HOUR).toISOString().slice(0, 10)
  assert.notEqual(utcKey, plus8Key, 'fixture must distinguish UTC from +8 bucketing')

  const usage = { inputTokens: 100, cacheReadTokens: 50, outputTokens: 25 }
  const events = [
    {
      seq: 0,
      type: 'request/header',
      time: eventTime,
      data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } },
    },
    { seq: 1, type: 'step/start', time: eventTime, data: { turn: 1, step: 1 } },
    {
      seq: 2,
      type: 'assistant/message',
      time: eventTime,
      data: {
        turn: 1,
        step: 1,
        usage,
        message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } },
      },
    },
  ]
  const sessions = new Map([['s1', sessionOf(events, 0)]])
  const ctx = makeCtx({
    sessions,
    descendants: null,
    listSessions: async () => [{ header: { id: 's1', createdAt: now - 60_000 } }],
  })
  const engine = createUsageEngine(ctx, makeConfig(), makePricing())
  const payload = await engine.stats({ force: true })

  assert.equal(payload.days.length, 90)
  const bucket = payload.days.find((day) => day.date === utcKey)
  assert.ok(bucket, `a bucket for the UTC day ${utcKey} must exist`)
  assert.equal(bucket.tokens, 175, 'the event lands on its UTC date')
  assert.ok(Array.isArray(bucket.costs))
  assertClose(amountOf(bucket.costs, 'CNY'), (100 * 1 + 50 * 0.02 + 25 * 4) / 1e6, 'bucket cost')
  assert.equal(payload.scannedSessions, 1)
  assert.equal(payload.failedSessions, 0)
  assert.ok(payload.totals?.today, 'totals.today is part of the frozen payload')
})

test('stats: a refresh/force call bypasses the short server cache', async () => {
  const now = Date.now()
  const mkEvents = (provider, model) => [
    {
      seq: 0,
      type: 'request/header',
      time: now - 60_000,
      data: { header: { config: { provider, model } } },
    },
    { seq: 1, type: 'step/start', time: now - 60_000, data: { turn: 1, step: 1 } },
    {
      seq: 2,
      type: 'assistant/message',
      time: now - 60_000,
      data: {
        turn: 1,
        step: 1,
        usage: { inputTokens: 10, outputTokens: 10 },
        message: { source: { provider, model } },
      },
    },
  ]
  const sessions = new Map([['s1', sessionOf(mkEvents('deepseek-official', 'deepseek-flash'), 0)]])
  const listed = [{ header: { id: 's1', createdAt: now - 60_000 } }]
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions.get(id) ?? null }
      if (name === 'sessionQuery') return { listSessions: async () => listed.slice() }
      return null
    },
    logger: { warn() {} },
  }
  const engine = createUsageEngine(ctx, makeConfig({ statsCacheSec: 300 }), makePricing())

  const first = await engine.stats()
  assert.equal(first.scannedSessions, 1)

  sessions.set('s2', sessionOf(mkEvents('moonshot', 'kimi-k2'), 0))
  listed.push({ header: { id: 's2', createdAt: now - 30_000 } })

  const cached = await engine.stats()
  assert.equal(cached.scannedSessions, 1, 'a repeat within statsCacheSec must reuse the cache')

  const forced = await engine.stats({ force: true })
  assert.equal(forced.scannedSessions, 2, 'kind=stats&refresh=1 must bypass the cache')
})
