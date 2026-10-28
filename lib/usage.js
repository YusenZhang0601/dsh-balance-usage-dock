/**
 * Session usage fold + 90-day aggregation.
 *
 * Event sources are probed in order and every layer is optional:
 *   live Session (ctx.sessions) -> sessionController.inspect()
 *   -> sessionQuery.observeSession()
 *
 * Only `assistant/message.data.usage` contributes tokens. Events inside a
 * fork's inherited prefix (`seq < inheritedEventCount`) are skipped so a fork
 * never bills its parent's history twice.
 *
 * Cost is cumulative for the whole session: every event is priced with the
 * model/provider that actually served it, so switching providers mid-session
 * never resets the total. `byModel` exposes that breakdown.
 */

import { weakestConfidence } from './pricing.js'

const DAY_MS = 24 * 60 * 60 * 1000
const CONCURRENCY = 3

export function createUsageEngine(ctx, config, pricing) {
  const cache = { at: 0, value: null, inflight: null }
  const statsZone = resolveZone(config.statsTimeZone)
  const ttlMs = config.pricingTtlSec * 1000

  async function sessionUsage(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') {
      throw httpError(400, 'A session id is required.')
    }
    const snapshot = await readSessionEvents(sessionId)
    const folded = await foldEvents(snapshot.events, snapshot.inherited)
    const children = await collectDescendantUsage(sessionId)

    const tokens = { ...folded.tokens }
    const childTokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    for (const child of children.items) addTokenBlock(childTokens, child.folded.tokens)
    if (children.items.length > 0) addTokenBlock(tokens, childTokens)

    const allCosts = mergeAmountLists([folded.costs, ...children.items.map((child) => child.folded.costs)])
    const childCosts = mergeAmountLists(children.items.map((child) => child.folded.costs))
    const allSingle = singleCostFromList(allCosts)
    const childSingle = singleCostFromList(childCosts)

    const byModel = mergeByModel([folded.byModel, ...children.items.map((child) => child.folded.byModel)])
    const confidences = [...folded.confidences, ...children.items.flatMap((child) => child.folded.confidences)]

    const lastItem = folded.items[folded.items.length - 1] ?? null
    const lastSwitch = folded.switches[folded.switches.length - 1] ?? null
    const priced = folded.pricedAll && children.pricedAll
    const firstPriced =
      folded.priceSource
        ? { source: folded.priceSource, asOf: folded.pricingAsOf, stale: folded.pricingStale }
        : (children.items.find((child) => child.folded.priceSource)?.folded ?? null)

    return {
      sessionId,
      provider: lastSwitch?.provider ?? lastItem?.provider ?? folded.lastProvider ?? null,
      model: lastSwitch?.model ?? lastItem?.model ?? folded.lastModel ?? null,
      tokens,
      cost: priced && allSingle ? roundAmount(allSingle.cost) : null,
      currency: allSingle?.currency ?? null,
      costs: allCosts.map((entry) => ({ currency: entry.currency, amount: roundAmount(entry.amount) })),
      priced,
      priceSource: firstPriced?.source ?? null,
      pricingConfidence: weakestConfidence(confidences),
      pricingAsOf: firstPriced?.asOf ?? null,
      pricingStale: Boolean(firstPriced?.stale),
      mixedProviders: new Set(byModel.map((entry) => entry.provider).filter(Boolean)).size > 1,
      turns: folded.turns,
      steps: folded.steps,
      updatedAt: Math.max(folded.updatedAt, ...children.items.map((child) => child.folded.updatedAt), 0),
      byModel,
      subagent: {
        sessions: children.items.length,
        requested: children.requested,
        unavailable: children.unavailable,
        tokens: childTokens,
        costs: childCosts.map((entry) => ({ currency: entry.currency, amount: roundAmount(entry.amount) })),
        cost: children.pricedAll && childSingle ? roundAmount(childSingle.cost) : null,
        currency: childSingle?.currency ?? null,
        priced: children.pricedAll,
      },
    }
  }

  async function collectDescendantUsage(rootSessionId) {
    const subagents = ctx.get('subagents')
    if (typeof subagents?.listDescendants !== 'function') {
      return { items: [], pricedAll: true, sessions: 0, requested: 0, unavailable: true }
    }
    let entries = []
    try {
      entries = await subagents.listDescendants(rootSessionId)
    } catch (error) {
      ctx.logger?.warn?.(`[balance-usage] subagent listing failed: ${error?.message ?? error}`)
      return { items: [], pricedAll: true, sessions: 0, requested: 0, unavailable: true }
    }
    const ids = [
      ...new Set(
        (Array.isArray(entries) ? entries : [])
          .filter((entry) => entry && entry.kind === 'child' && typeof entry.id === 'string' && entry.id && entry.id !== rootSessionId)
          .map((entry) => entry.id),
      ),
    ]
    const items = []
    await mapPool(ids, CONCURRENCY, async (id) => {
      try {
        const snapshot = await readSessionEvents(id)
        const folded = await foldEvents(snapshot.events, snapshot.inherited)
        items.push({ id, folded })
      } catch (error) {
        ctx.logger?.warn?.(`[balance-usage] subagent session ${id} could not be read: ${error?.message ?? error}`)
      }
    })
    return {
      items,
      pricedAll: items.every((entry) => entry.folded.pricedAll),
      sessions: items.length,
      requested: ids.length,
      unavailable: false,
    }
  }

  async function stats(options = {}) {
    const force = options.force === true
    if (!force && cache.value && Date.now() - cache.at < config.statsCacheSec * 1000) return cache.value
    if (cache.inflight) return cache.inflight
    cache.inflight = (async () => {
      try {
        const value = await computeStats()
        cache.value = value
        cache.at = Date.now()
        return value
      } finally {
        cache.inflight = null
      }
    })()
    return cache.inflight
  }

  async function computeStats() {
    const now = Date.now()
    const days = config.statsDays
    const todayKey = dateKey(now)
    const firstKey = dateKey(now - (days - 1) * DAY_MS)

    const sessions = await listSessions()
    const windowed = sessions.filter((entry) => entry.at >= now - days * DAY_MS)
    const limit = config.statsSessionLimit
    const selected = windowed.slice(0, limit)
    const truncated = windowed.length > selected.length

    const buckets = new Map()
    let failedSessions = 0
    let scannedSessions = 0
    let priceSource = null
    let pricingAsOf = null
    let pricingStale = false
    const confidences = []

    await mapPool(selected, CONCURRENCY, async (entry) => {
      scannedSessions++
      let folded
      try {
        const snapshot = await readSessionEvents(entry.sessionId)
        folded = await foldEvents(snapshot.events, snapshot.inherited)
      } catch {
        failedSessions++
        return
      }
      if (!priceSource && folded.priceSource) {
        priceSource = folded.priceSource
        pricingAsOf = folded.pricingAsOf
        pricingStale = folded.pricingStale
      }
      confidences.push(...folded.confidences)
      for (const item of folded.items) {
        const key = dateKey(item.time)
        if (key < firstKey || key > todayKey) continue
        const bucket = ensureBucket(buckets, key)
        const total = tokenTotal(item.usage)
        bucket.tokens += total
        bucket.sessionIds.add(entry.sessionId)
        if (item.cost != null && item.currency) addAmount(bucket.costs, item.currency, item.cost)
        if (item.model) {
          const model = bucket.models.get(item.model) ?? { tokens: 0, costs: new Map() }
          model.tokens += total
          if (item.cost != null && item.currency) addAmount(model.costs, item.currency, item.cost)
          bucket.models.set(item.model, model)
        }
      }
    })

    const daysList = []
    for (let i = days - 1; i >= 0; i--) {
      const key = dateKey(now - i * DAY_MS)
      const bucket = buckets.get(key)
      const single = bucket ? singleCost(bucket.costs) : null
      daysList.push({
        date: key,
        tokens: bucket?.tokens ?? 0,
        costs: bucket ? amountList(bucket.costs) : [],
        cost: single?.cost ?? null,
        currency: single?.currency ?? null,
        sessions: bucket ? bucket.sessionIds.size : 0,
        models: bucket
          ? Object.fromEntries(
              [...bucket.models].map(([model, value]) => {
                const modelSingle = singleCost(value.costs)
                return [
                  model,
                  {
                    tokens: value.tokens,
                    costs: amountList(value.costs),
                    cost: modelSingle?.cost ?? null,
                    currency: modelSingle?.currency ?? null,
                  },
                ]
              }),
            )
          : {},
      })
    }

    const totals = {
      today: totalsOf(daysList.slice(-1)),
      d7: totalsOf(daysList.slice(-7)),
      d30: totalsOf(daysList.slice(-30)),
      d90: totalsOf(daysList),
    }
    return {
      days: daysList,
      totals,
      priceSource,
      pricingAsOf,
      pricingStale,
      pricingConfidence: weakestConfidence(confidences),
      scannedSessions,
      failedSessions,
      truncated,
    }
  }

  // ------------------------------------------------------------------ fold

  async function foldEvents(events, inherited) {
    const starts = new Map()
    const switches = []
    const usages = []

    for (const event of events ?? []) {
      if (!event || typeof event !== 'object') continue
      const seq = Number(event.seq ?? 0)
      if (Number.isFinite(seq) && seq < inherited) continue
      const time = Number(event.time ?? 0) || 0
      if (event.type === 'step/start') {
        const data = event.data ?? {}
        if (data.turn != null && data.step != null) starts.set(`${data.turn}/${data.step}`, time)
      } else if (event.type === 'request/header') {
        const headerConfig = event.data?.header?.config
        if (headerConfig && (headerConfig.provider || headerConfig.model)) {
          switches.push({ time, provider: headerConfig.provider ?? null, model: headerConfig.model ?? null })
        }
      } else if (event.type === 'request/context') {
        const data = event.data ?? {}
        if (data.provider || data.model) {
          switches.push({ time, provider: data.provider ?? null, model: data.model ?? null })
        }
      } else if (event.type === 'assistant/message') {
        const data = event.data ?? {}
        const usage = data.usage
        if (!usage) continue
        const source = data.message?.source ?? {}
        usages.push({
          time: starts.get(`${data.turn}/${data.step}`) ?? time,
          turn: Number(data.turn ?? 0),
          step: Number(data.step ?? 0),
          provider: source.provider ?? null,
          model: source.model ?? null,
          usage,
        })
      }
    }

    switches.sort((a, b) => a.time - b.time)
    for (const item of usages) {
      if (item.provider && item.model) continue
      const at = lastSwitchAt(switches, item.time)
      item.provider = item.provider ?? at?.provider ?? null
      item.model = item.model ?? at?.model ?? null
    }

    const unique = new Map()
    for (const item of usages) {
      const key = `${item.provider ?? ''}|${item.model ?? ''}`
      if (!unique.has(key)) unique.set(key, { provider: item.provider, model: item.model })
    }
    const prices = new Map()
    await Promise.all(
      [...unique].map(async ([key, value]) => {
        prices.set(key, await safeResolve(value.provider, value.model))
      }),
    )

    const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    const costs = new Map()
    const byModel = new Map()
    const confidences = []
    const items = []
    let pricedCount = 0
    let priceSource = null
    let pricingAsOf = null
    let pricingStale = false
    let updatedAt = 0
    let lastProvider = null
    let lastModel = null

    for (const item of usages) {
      addTokens(tokens, item.usage)
      updatedAt = Math.max(updatedAt, Number(item.time) || 0)
      lastProvider = item.provider ?? lastProvider
      lastModel = item.model ?? lastModel
      const price = prices.get(`${item.provider ?? ''}|${item.model ?? ''}`) ?? null
      let cost = null
      let currency = null
      let confidence = null
      if (price) {
        const unit = pricing.priceAt(price, item.time)
        const value =
          (toNumber(item.usage.inputTokens) * unit.cacheMiss +
            toNumber(item.usage.cacheReadTokens) * unit.cacheHit +
            toNumber(item.usage.cacheWriteTokens) * unit.cacheWrite +
            toNumber(item.usage.outputTokens) * unit.output) /
          1e6
        if (Number.isFinite(value)) {
          cost = value
          currency = price.currency ?? 'CNY'
          confidence = price.confidence ?? 'community'
          pricedCount++
          addAmount(costs, currency, value)
          confidences.push(confidence)
          if (!priceSource) {
            priceSource = price.source
            pricingAsOf = price.fetchedAt ?? null
            pricingStale = Boolean(price.fetchedAt) && Date.now() - Number(price.fetchedAt) > ttlMs
          }
        }
      }
      const bucket = ensureModelBucket(byModel, item.provider, item.model)
      bucket.tokens.input += toNumber(item.usage.inputTokens)
      bucket.tokens.cacheRead += toNumber(item.usage.cacheReadTokens)
      bucket.tokens.cacheWrite += toNumber(item.usage.cacheWriteTokens)
      bucket.tokens.output += toNumber(item.usage.outputTokens)
      if (cost != null && currency) {
        addAmount(bucket.costs, currency, cost)
        if (confidence) bucket.confidences.add(confidence)
        if (!bucket.priceSource) bucket.priceSource = price.source
      } else {
        bucket.priced = false
      }
      items.push({
        time: Number(item.time) || 0,
        provider: item.provider,
        model: item.model,
        turn: item.turn,
        step: item.step,
        usage: item.usage,
        cost,
        currency,
      })
    }

    return {
      items,
      switches,
      tokens,
      costs: amountList(costs),
      byModel: modelBuckets(byModel),
      confidences,
      pricedAll: usages.length > 0 && pricedCount === usages.length,
      priceSource,
      pricingAsOf,
      pricingStale,
      turns: new Set(usages.map((item) => item.turn)).size,
      steps: usages.length,
      updatedAt,
      lastProvider,
      lastModel,
    }
  }

  async function safeResolve(provider, model) {
    if (!provider && !model) return null
    try {
      return await pricing.resolveModel(provider, model)
    } catch {
      return null
    }
  }

  // --------------------------------------------------------------- reading

  async function readSessionEvents(sessionId) {
    const sessions = ctx.get('sessions')
    if (typeof sessions?.get === 'function') {
      const live = sessions.get(sessionId)
      if (live) {
        const inherited = Number(live.inheritedEventCount ?? 0)
        const events = snapshotOf(live)
        if (Array.isArray(events)) return { events, inherited }
      }
    }

    const controller = ctx.get('sessionController')
    if (typeof controller?.inspect === 'function') {
      try {
        const inspection = await controller.inspect(sessionId)
        if (inspection && Array.isArray(inspection.events)) {
          const inherited = Number(inspection.inheritedEventCount ?? inspection.meta?.inheritedEventCount ?? 0)
          return { events: inspection.events, inherited }
        }
      } catch {
        // fall through to the query service
      }
    }

    const query = ctx.get('sessionQuery')
    if (typeof query?.observeSession === 'function') {
      let observation = null
      try {
        observation = await query.observeSession(sessionId, { projectionMode: 'none' })
        if (observation && Array.isArray(observation.events)) {
          return {
            events: observation.events,
            inherited: Number(observation.inheritedEventCount ?? 0),
          }
        }
      } catch {
        // fall through to the not-found failure below
      } finally {
        try {
          observation?.[Symbol.dispose]?.()
        } catch {
          // observation owns its lease; a failed release must not fail the read
        }
      }
    }

    throw httpError(404, `Session ${sessionId} could not be read.`)
  }

  function snapshotOf(session) {
    try {
      if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
      if (Array.isArray(session.events)) return session.events
    } catch {
      return null
    }
    return null
  }

  async function listSessions() {
    const query = ctx.get('sessionQuery')
    if (typeof query?.listSessions === 'function') {
      try {
        const records = await query.listSessions()
        if (Array.isArray(records)) {
          return dedupe(
            records.map((record) => ({
              sessionId: record?.header?.id ?? record?.session?.id ?? record?.id ?? null,
              at: Number(record?.header?.createdAt ?? record?.createdAt ?? 0),
            })),
          )
        }
      } catch (error) {
        ctx.logger?.warn?.(`[balance-usage] session listing failed: ${error?.message ?? error}`)
      }
    }
    const controller = ctx.get('sessionController')
    if (typeof controller?.list === 'function') {
      try {
        const value = await controller.list({})
        const items = Array.isArray(value) ? value : value?.items ?? []
        return dedupe(
          items.map((item) => ({
            sessionId: item?.sessionId ?? item?.id ?? null,
            at: Number(item?.updatedAt ?? item?.createdAt ?? 0),
          })),
        )
      } catch (error) {
        ctx.logger?.warn?.(`[balance-usage] session controller list failed: ${error?.message ?? error}`)
      }
    }
    return []
  }

  function dedupe(entries) {
    const seen = new Map()
    for (const entry of entries) {
      if (!entry.sessionId || !Number.isFinite(entry.at) || entry.at <= 0) continue
      const previous = seen.get(entry.sessionId)
      if (!previous || previous.at < entry.at) seen.set(entry.sessionId, entry)
    }
    return [...seen.values()].sort((a, b) => b.at - a.at)
  }

  // --------------------------------------------------------------- helpers

  function dateKey(time) {
    return zoneDateKey(statsZone, time)
  }

  function ensureBucket(map, key) {
    let bucket = map.get(key)
    if (!bucket) {
      bucket = { tokens: 0, costs: new Map(), sessionIds: new Set(), models: new Map() }
      map.set(key, bucket)
    }
    return bucket
  }

  return { sessionUsage, stats }
}

// ------------------------------------------------------------------ models

function ensureModelBucket(map, provider, model) {
  const key = `${provider ?? ''}|${model ?? ''}`
  let bucket = map.get(key)
  if (!bucket) {
    bucket = {
      provider: provider ?? null,
      model: model ?? null,
      tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      costs: new Map(),
      priced: true,
      confidences: new Set(),
      priceSource: null,
    }
    map.set(key, bucket)
  }
  return bucket
}

function modelBuckets(map) {
  return [...map.values()].map((bucket) => {
    const single = singleCost(bucket.costs)
    return {
      provider: bucket.provider,
      model: bucket.model,
      tokens: bucket.tokens,
      costs: amountList(bucket.costs).map((entry) => ({ currency: entry.currency, amount: roundAmount(entry.amount) })),
      cost: single ? roundAmount(single.cost) : null,
      currency: single?.currency ?? null,
      priced: bucket.priced && Boolean(single),
      priceSource: bucket.priceSource,
      pricingConfidence: weakestConfidence([...bucket.confidences]),
    }
  })
}

function mergeByModel(lists) {
  const merged = new Map()
  for (const list of lists) {
    for (const entry of list ?? []) {
      const key = `${entry.provider ?? ''}|${entry.model ?? ''}`
      let target = merged.get(key)
      if (!target) {
        target = {
          provider: entry.provider,
          model: entry.model,
          tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
          costs: new Map(),
          priced: true,
          confidences: [],
          priceSource: null,
        }
        merged.set(key, target)
      }
      addTokenBlock(target.tokens, entry.tokens)
      for (const cost of entry.costs ?? []) {
        if (cost?.currency) target.costs.set(cost.currency, (target.costs.get(cost.currency) ?? 0) + Number(cost.amount ?? 0))
      }
      target.priced = target.priced && Boolean(entry.priced)
      if (entry.pricingConfidence) target.confidences.push(entry.pricingConfidence)
      if (!target.priceSource) target.priceSource = entry.priceSource ?? null
    }
  }
  return [...merged.values()].map((target) => {
    const single = singleCost(target.costs)
    return {
      provider: target.provider,
      model: target.model,
      tokens: target.tokens,
      costs: amountList(target.costs).map((entry) => ({ currency: entry.currency, amount: roundAmount(entry.amount) })),
      cost: single ? roundAmount(single.cost) : null,
      currency: single?.currency ?? null,
      priced: target.priced && Boolean(single),
      priceSource: target.priceSource,
      pricingConfidence: weakestConfidence(target.confidences),
    }
  })
}

// -------------------------------------------------------------------- time

function resolveZone(zone) {
  const candidates = []
  if (typeof zone === 'string' && zone.trim()) candidates.push(zone)
  try {
    candidates.push(Intl.DateTimeFormat().resolvedOptions().timeZone)
  } catch {
    // ignore
  }
  candidates.push('UTC')
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date())
      return candidate
    } catch {
      // try next
    }
  }
  return 'UTC'
}

function zoneDateKey(zone, time) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(Number(time) || 0))
    const map = {}
    for (const part of parts) map[part.type] = part.value
    if (map.year && map.month && map.day) return `${map.year}-${map.month}-${map.day}`
  } catch {
    // fall through to UTC
  }
  return new Date(Number(time) || 0).toISOString().slice(0, 10)
}

// ------------------------------------------------------------------ helpers

function lastSwitchAt(switches, time) {
  let found = null
  for (const entry of switches) {
    if (entry.time <= time) found = entry
    else break
  }
  return found
}

function tokenTotal(usage) {
  return (
    toNumber(usage?.inputTokens) +
    toNumber(usage?.cacheReadTokens) +
    toNumber(usage?.cacheWriteTokens) +
    toNumber(usage?.outputTokens)
  )
}

function addTokens(target, usage) {
  target.input += toNumber(usage?.inputTokens)
  target.cacheRead += toNumber(usage?.cacheReadTokens)
  target.cacheWrite += toNumber(usage?.cacheWriteTokens)
  target.output += toNumber(usage?.outputTokens)
}

function addTokenBlock(target, block) {
  target.input += toNumber(block?.input)
  target.cacheRead += toNumber(block?.cacheRead)
  target.cacheWrite += toNumber(block?.cacheWrite)
  target.output += toNumber(block?.output)
}

function addAmount(map, currency, amount) {
  if (!currency || !Number.isFinite(amount)) return
  if (amount === 0 && map.size > 0) return
  map.set(currency, (map.get(currency) ?? 0) + amount)
}

function amountList(map) {
  return [...map].map(([currency, amount]) => ({ currency, amount }))
}

function mergeAmountLists(lists) {
  const merged = new Map()
  for (const list of lists) {
    for (const entry of list ?? []) {
      if (!entry?.currency) continue
      merged.set(entry.currency, (merged.get(entry.currency) ?? 0) + Number(entry.amount ?? 0))
    }
  }
  return amountList(merged)
}

function singleCost(map) {
  if (!(map instanceof Map) || map.size !== 1) return null
  const [currency, amount] = [...map][0]
  return { cost: roundAmount(amount), currency }
}

function singleCostFromList(list) {
  const entries = Array.isArray(list) ? list : []
  if (entries.length === 1) return { cost: roundAmount(entries[0].amount), currency: entries[0].currency }
  const nonZero = entries.filter((entry) => entry.amount !== 0)
  if (nonZero.length === 1) return { cost: roundAmount(nonZero[0].amount), currency: nonZero[0].currency }
  return null
}

function totalsOf(days) {
  let tokens = 0
  const costs = new Map()
  for (const day of days) {
    tokens += day.tokens
    for (const entry of day.costs) costs.set(entry.currency, (costs.get(entry.currency) ?? 0) + entry.amount)
  }
  const single = singleCost(costs)
  return { tokens, costs: amountList(costs), cost: single?.cost ?? null, currency: single?.currency ?? null }
}

function roundAmount(value) {
  return Math.round(Number(value) * 1e6) / 1e6
}

function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

async function mapPool(items, limit, worker) {
  let index = 0
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (index < items.length) {
      const current = items[index++]
      await worker(current)
    }
  })
  await Promise.all(runners)
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}
