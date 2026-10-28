/**
 * Runtime pricing engine — no price table is compiled into this plugin.
 *
 * Resolution order for one (provider, model):
 *   1. config.priceOverrides                     (user, highest priority)
 *   2. provider's own model-price catalog        (lib/providers.js::getProviderPrices)
 *      + config.extraPriceCatalogs               (user-configured JSON catalogs)
 *   3. official pricing page                     (DeepSeek docs, CNY / per-million-tokens)
 *   4. models.dev                                (community catalog, USD, may lag)
 *
 * The DeepSeek page publishes idle and peak prices separately, so this module
 * only needs the peak-window predicate — never a price multiplier.
 *
 * Peak windows are evaluated in `config.peakTimeZone` (DeepSeek defines them in
 * Beijing time); `config.holidays` (dates in that zone) force all-day off-peak.
 * Every resolved price carries a `confidence` label so the UI can show `≈`.
 */

const UNIT = 'per-million-tokens'
const USER_AGENT = 'dsh-balance-usage-dock/0.2.0'
const MODEL_COLUMNS = ['flash', 'pro']
const CONFIDENCE_RANK = { none: 0, community: 1, family: 2, override: 3, exact: 4 }

export function createPricingEngine(ctx, config, deps = {}) {
  const getProviderPrices = typeof deps.getProviderPrices === 'function' ? deps.getProviderPrices : async () => null
  const ttlMs = config.pricingTtlSec * 1000
  const peakZone = resolveZone(config.peakTimeZone, 'Asia/Shanghai')
  const holidaySet = new Set(Array.isArray(config.holidays) ? config.holidays : [])

  const official = { value: null, url: null, at: 0, error: null }
  const modelsDev = { value: null, at: 0, error: null }
  const providerPriceCache = new Map()
  const extraCatalogCache = new Map()
  const resolvedCache = new Map()
  let refreshing = null

  function isPeak(atMs) {
    const parts = zoneParts(peakZone, atMs)
    if (holidaySet.has(parts.date)) return false
    if (!config.peakWeekdays.includes(parts.weekday)) return false
    const hour = parts.hour + parts.minute / 60
    return config.peakWindows.some((w) => hour >= w.start && hour < w.end)
  }

  function priceAt(price, atMs) {
    if (!price) return null
    const bucket = isPeak(atMs) ? 'peak' : 'idle'
    return {
      cacheHit: Number(price.cacheHit?.[bucket] ?? 0),
      cacheMiss: Number(price.cacheMiss?.[bucket] ?? 0),
      cacheWrite: Number(price.cacheWrite?.[bucket] ?? 0),
      output: Number(price.output?.[bucket] ?? 0),
    }
  }

  async function resolveUncached(provider, model) {
    const modelId = String(model ?? '')
    const providerId = String(provider ?? '')
    const alias = aliasFor(config.modelAliases, modelId)
    const canonical = normalizeModelId(alias ?? modelId)

    const override = findOverride(config.priceOverrides, providerId, modelId, alias, canonical)
    if (override) {
      const price = normalizePriceEntry(override, 'override', { currency: 'CNY', confidence: 'override' })
      if (price) return price
    }

    for (const source of config.pricingSources) {
      if (source === 'provider-catalog') {
        const catalog = await providerCatalogFor(providerId)
        if (catalog) {
          const matched = matchModel(catalog.models, modelId, canonical)
          if (matched) {
            const price = normalizePriceEntry(matched.model, 'provider-catalog', {
              currency: catalog.currency ?? 'USD',
              url: catalog.url,
              fetchedAt: catalog.fetchedAt,
              confidence: matched.confidence,
            })
            if (price) return price
          }
        }
        for (const extra of config.extraPriceCatalogs) {
          const table = await extraCatalogFor(extra)
          if (!table) continue
          if (extra.matchPrefix && !providerId.toLowerCase().includes(extra.matchPrefix.toLowerCase())) continue
          const matched = matchModel(table.models, modelId, canonical)
          if (!matched) continue
          const price = normalizePriceEntry(matched.model, 'extra-catalog', {
            currency: table.currency ?? extra.currency ?? 'USD',
            url: table.url,
            fetchedAt: table.fetchedAt,
            confidence: matched.confidence,
          })
          if (price) return price
        }
      }
      if (source === 'official-page') {
        if (!isDeepSeekProvider(providerId)) continue
        const parsed = await ensureOfficial()
        if (!parsed) continue
        const tier = deepSeekTier(canonical, modelId)
        if (!tier) continue
        const price = officialPrice(parsed.table?.[tier.tier], tier.tier, {
          url: official.url,
          at: official.at,
          peakNote: parsed.peakNote,
          confidence: tier.confidence,
        })
        if (price) return price
      }
      if (source === 'models.dev') {
        const data = await ensureModelsDev()
        const price = priceFromModelsDev(data, providerId, modelId, canonical, {
          fetchedAt: modelsDev.at,
          url: config.modelsDevUrl,
        })
        if (price) return price
      }
    }
    return null
  }

  async function providerCatalogFor(providerId) {
    const cached = providerPriceCache.get(providerId)
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.value
    let value = null
    try {
      value = await getProviderPrices(providerId)
    } catch (error) {
      ctx.logger?.warn?.(`[balance-usage] provider price catalog failed for ${providerId}: ${error?.message ?? error}`)
      value = null
    }
    if (value) providerPriceCache.set(providerId, { value, at: Date.now() })
    return value
  }

  async function extraCatalogFor(extra) {
    const cached = extraCatalogCache.get(extra.url)
    const ttl = Math.max(60, Number(extra.ttlSec) || 3600) * 1000
    if (cached && Date.now() - cached.at < ttl) return cached.value
    let value = null
    try {
      const data = await fetchJson(extra.url, { timeoutMs: 20000 })
      value = parseExtraCatalog(data, extra, extra.url)
    } catch (error) {
      ctx.logger?.warn?.(`[balance-usage] extra price catalog failed for ${extra.url}: ${error?.message ?? error}`)
      value = null
    }
    if (value) extraCatalogCache.set(extra.url, { value, at: Date.now() })
    return value
  }

  // ---------------------------------------------------------------- sources

  async function refreshSources(force) {
    if (refreshing) return refreshing
    refreshing = (async () => {
      const tasks = []
      if (config.pricingSources.includes('official-page')) tasks.push(ensureOfficial({ force }))
      if (config.pricingSources.includes('models.dev')) tasks.push(ensureModelsDev({ force }))
      await Promise.allSettled(tasks)
      resolvedCache.clear()
      extraCatalogCache.clear()
      return buildSnapshot()
    })().finally(() => {
      refreshing = null
    })
    return refreshing
  }

  async function ensureOfficial({ force = false } = {}) {
    if (!force && official.value && Date.now() - official.at < ttlMs) return official.value
    let lastError = null
    for (const url of config.officialPricingUrls) {
      try {
        const html = await fetchText(url, 15000)
        const parsed = parseOfficialPricing(html)
        if (!parsed) {
          lastError = new Error('the pricing table did not validate')
          continue
        }
        official.value = parsed
        official.url = url
        official.at = Date.now()
        official.error = null
        return parsed
      } catch (error) {
        lastError = error
      }
    }
    official.error = lastError?.message ?? 'official pricing page is unavailable'
    return official.value
  }

  async function ensureModelsDev({ force = false } = {}) {
    if (!force && modelsDev.value && Date.now() - modelsDev.at < ttlMs) return modelsDev.value
    try {
      const data = await fetchJson(config.modelsDevUrl, { timeoutMs: 30000 })
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('models.dev returned an unexpected document')
      }
      modelsDev.value = data
      modelsDev.at = Date.now()
      modelsDev.error = null
    } catch (error) {
      modelsDev.error = error?.message ?? 'models.dev is unavailable'
    }
    return modelsDev.value
  }

  function buildSnapshot() {
    const value = official.value
    const stale = value ? Date.now() - official.at > ttlMs : false
    let warning = null
    if (!value) warning = official.error ?? 'official pricing page is unavailable'
    else if (value.warning) warning = value.warning
    const now = Date.now()
    return {
      source: value ? 'official-page' : null,
      url: value ? official.url : null,
      fetchedAt: value ? official.at : null,
      stale,
      currency: 'CNY',
      unit: UNIT,
      models: value ? { flash: value.table.flash, pro: value.table.pro } : null,
      peak: {
        windows: config.peakWindows,
        weekdays: config.peakWeekdays,
        timeZone: peakZone,
        timeZoneOffsetHours: zoneOffsetHours(peakZone, now),
        note: value?.peakNote ?? null,
        holidays: [...holidaySet],
      },
      modelsDev: {
        available: Boolean(modelsDev.value),
        fetchedAt: modelsDev.value ? modelsDev.at : null,
        error: modelsDev.error ?? null,
      },
      extraCatalogs: config.extraPriceCatalogs.map((entry) => ({ url: entry.url, format: entry.format })),
      warning,
    }
  }

  return {
    async resolveModel(provider, model) {
      const key = `${provider ?? ''}|${model ?? ''}`
      const cached = resolvedCache.get(key)
      if (cached && Date.now() - cached.at < ttlMs) return cached.value
      const value = await resolveUncached(provider, model)
      resolvedCache.set(key, { value, at: Date.now() })
      return value
    },
    async refresh({ force = false } = {}) {
      return refreshSources(force)
    },
    async snapshot() {
      if (config.pricingSources.includes('official-page')) await ensureOfficial()
      return buildSnapshot()
    },
    isPeak,
    priceAt,
    peakTimeZone: peakZone,
  }
}

export function weakestConfidence(values) {
  let weakest = null
  for (const value of values ?? []) {
    if (!value) continue
    const label = typeof value === 'string' ? value : value.confidence
    if (!label) continue
    if (weakest === null || (CONFIDENCE_RANK[label] ?? 0) < (CONFIDENCE_RANK[weakest] ?? 0)) weakest = label
  }
  return weakest ?? 'none'
}

// ------------------------------------------------------------- official page

/**
 * Parse the DeepSeek "模型 & 价格" table. Returns null when the table cannot be
 * located at all; returns a table plus `warning` when located but failing the
 * peak/idle invariant. Prices stay in CNY per 1M tokens, exactly as published.
 */
export function parseOfficialPricing(html) {
  const rows = extractRows(html)
  if (rows.length === 0) return null

  let start = -1
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].some((cell) => /^价格/.test(cell))) {
      start = i
      break
    }
  }
  if (start < 0) return null

  let columnOrder = MODEL_COLUMNS
  for (let i = 0; i < start; i++) {
    const flashIndex = rows[i].findIndex((cell) => /deepseek[-\s]*flash/i.test(cell))
    const proIndex = rows[i].findIndex((cell) => /v4[-\s]*pro/i.test(cell))
    if (flashIndex >= 0 && proIndex >= 0 && flashIndex !== proIndex) {
      columnOrder = flashIndex < proIndex ? ['flash', 'pro'] : ['pro', 'flash']
      break
    }
  }

  const table = {
    flash: { cacheHit: {}, cacheMiss: {}, output: {} },
    pro: { cacheHit: {}, cacheMiss: {}, output: {} },
  }
  let bucket = null
  for (let i = start; i < rows.length; i++) {
    const cells = rows[i]
    const joined = cells.join(' | ')
    if (/并发限制/.test(joined)) break
    if (/缓存命中/.test(joined)) bucket = 'cacheHit'
    else if (/缓存未命中/.test(joined)) bucket = 'cacheMiss'
    else if (/tokens\s*输出/.test(joined)) bucket = 'output'
    if (!bucket) continue
    const periodCell = cells.findIndex((cell) => cell === '空闲时段' || cell === '高峰时段')
    if (periodCell < 0) continue
    const period = cells[periodCell] === '空闲时段' ? 'idle' : 'peak'
    const numbers = []
    for (let c = periodCell + 1; c < cells.length; c++) {
      const match = /^([\d.]+)\s*元$/.exec(cells[c])
      if (match) numbers.push(Number(match[1]))
    }
    for (let index = 0; index < Math.min(numbers.length, columnOrder.length); index++) {
      const model = columnOrder[index]
      if (!model) continue
      table[model][bucket][period] = numbers[index]
    }
  }

  const validation = validateOfficialTable(table)
  return {
    table,
    peakNote: extractPeakNote(html),
    warning: validation.ok ? null : validation.reason,
  }
}

function validateOfficialTable(table) {
  for (const model of MODEL_COLUMNS) {
    for (const bucket of ['cacheHit', 'cacheMiss', 'output']) {
      const idle = table[model]?.[bucket]?.idle
      const peak = table[model]?.[bucket]?.peak
      if (!Number.isFinite(idle) || !Number.isFinite(peak)) {
        return { ok: false, reason: `missing ${model}/${bucket} price` }
      }
      if (Math.abs(peak - 2 * idle) > Math.max(0.000001, idle * 0.01)) {
        return { ok: false, reason: `${model}/${bucket} peak price is not twice the idle price` }
      }
    }
  }
  return { ok: true }
}

function extractPeakNote(html) {
  const match = /北京时间[^。]{0,160}/.exec(plainText(html))
  return match ? match[0].trim() : null
}

function extractRows(html) {
  const rows = []
  const rowRe = /<tr[\s\S]*?<\/tr>/gi
  let rowMatch
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const cells = []
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
    let cellMatch
    while ((cellMatch = cellRe.exec(rowMatch[0])) !== null) cells.push(plainText(cellMatch[1]))
    if (cells.length > 0) rows.push(cells)
  }
  return rows
}

function plainText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

// --------------------------------------------------------------- models.dev

function priceFromModelsDev(data, providerId, modelId, canonical, meta) {
  if (!data || typeof data !== 'object') return null
  const candidates = []
  for (const key of modelsDevProviderKeys(providerId)) {
    const entry = data[key]
    if (entry && typeof entry === 'object' && entry.models) candidates.push(entry)
  }
  if (candidates.length === 0) {
    for (const entry of Object.values(data)) {
      if (entry && typeof entry === 'object' && entry.models) candidates.push(entry)
    }
  }
  const matched = matchModelsDevModel(candidates, modelId, canonical)
  const cost = matched?.model?.cost
  if (!cost || typeof cost !== 'object') return null
  const cacheMiss = numberOrNull(cost.input)
  const output = numberOrNull(cost.output)
  if (cacheMiss === null && output === null) return null
  return {
    source: 'models.dev',
    currency: 'USD',
    unit: UNIT,
    fetchedAt: meta?.fetchedAt ?? null,
    url: meta?.url ?? null,
    community: true,
    mapped: true,
    confidence: 'community',
    cacheHit: flatPair(numberOrNull(cost.cache_read) ?? 0),
    cacheMiss: flatPair(cacheMiss ?? 0),
    cacheWrite: flatPair(numberOrNull(cost.cache_write) ?? 0),
    output: flatPair(output ?? 0),
  }
}

function modelsDevProviderKeys(providerId) {
  const id = String(providerId).toLowerCase()
  if (/deepseek/.test(id)) return ['deepseek']
  if (/moonshot/.test(id)) return ['moonshotai', 'moonshot']
  if (/openrouter/.test(id)) return ['openrouter']
  if (/zai|bigmodel/.test(id)) return ['zai']
  if (/minimax/.test(id)) return ['minimax', 'minimax-cn-coding-plan']
  if (/xai/.test(id)) return ['xai']
  if (/vercel/.test(id)) return ['vercel']
  return [id]
}

function matchModelsDevModel(providers, modelId, canonical) {
  const wanted = canonical || normalizeModelId(modelId)
  if (!wanted) return null
  const aliases = [wanted]
  if (wanted.includes('/')) aliases.push(wanted.split('/').pop())
  for (const provider of providers) {
    const models = provider.models ?? {}
    for (const alias of aliases) {
      if (models[alias]) return { model: models[alias], confidence: 'community' }
      const hit = Object.entries(models).find(([key]) => normalizeModelId(key) === alias)
      if (hit) return { model: hit[1], confidence: 'community' }
    }
  }
  let best = null
  for (const provider of providers) {
    for (const [key, value] of Object.entries(provider.models ?? {})) {
      const normalized = normalizeModelId(key)
      if (!normalized) continue
      if (normalized.includes(wanted) || wanted.includes(normalized)) {
        if (!best || normalized.length > best.length) best = { length: normalized.length, model: value }
      }
    }
  }
  return best ? { model: best.model, confidence: 'community' } : null
}

// ---------------------------------------------------------------- catalogs

export function normalizeModelId(value) {
  let text = String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/^[a-z0-9._-]+\//, '')
    .replace(/:[a-z0-9_-]+$/g, '')
    .replace(/-(\d{3,4})$/g, '')
    .replace(/-(\d{4})[-.]?\d{2}[-.]?\d{2}$/g, '')
  for (let i = 0; i < 4; i++) {
    const next = text.replace(/-(free|beta|preview|experimental|exp|vision|latest|instruct|thinking)$/g, '')
    if (next === text) break
    text = next
  }
  return text.replace(/-+/g, '-').replace(/^-|-$/g, '')
}

function aliasFor(aliases, modelId) {
  if (!aliases || typeof aliases !== 'object') return null
  const canonical = normalizeModelId(modelId)
  for (const [key, value] of Object.entries(aliases)) {
    if (typeof value !== 'string' || !value) continue
    if (normalizeModelId(key) === canonical) return value
  }
  return null
}

function deepSeekTier(canonical, rawModel) {
  const value = `${canonical} ${String(rawModel ?? '').toLowerCase()}`
  if (/\bpro\b|v4-pro|v4pro/.test(value)) {
    return { tier: 'pro', confidence: 'exact' }
  }
  if (/flash/.test(value)) return { tier: 'flash', confidence: 'exact' }
  if (/\bchat\b|reasoner/.test(value)) return { tier: 'flash', confidence: 'family' }
  return null
}

// ---------------------------------------------------------------- overrides

function findOverride(overrides, providerId, modelId, alias, canonical) {
  if (!overrides || typeof overrides !== 'object') return null
  const exactKeys = [`${providerId}/${modelId}`, modelId, alias, canonical]
  for (const key of exactKeys) {
    if (key && Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key]
  }
  const search = canonical || normalizeModelId(modelId)
  const keys = Object.keys(overrides)
    .filter((key) => !key.includes('/'))
    .sort((a, b) => b.length - a.length)
  for (const key of keys) {
    const normalizedKey = normalizeModelId(key)
    if (normalizedKey && search.includes(normalizedKey)) return overrides[key]
  }
  return null
}

function normalizePriceEntry(entry, source, options) {
  if (entry == null) return null
  const currency = typeof entry === 'object' && typeof entry.currency === 'string' ? entry.currency : options.currency ?? 'CNY'
  if (typeof entry === 'number' && Number.isFinite(entry)) {
    return flatPrice({ cacheHit: 0, cacheMiss: entry, cacheWrite: 0, output: 0 }, source, {
      ...options,
      currency,
      confidence: options.confidence ?? 'override',
    })
  }
  if (typeof entry !== 'object') return null
  const cacheHit = readBucket(entry.cacheHit ?? entry.cache_hit)
  const cacheMiss = readBucket(entry.cacheMiss ?? entry.cache_miss ?? entry.input)
  const cacheWrite = readBucket(entry.cacheWrite ?? entry.cache_write) ?? flatPair(0)
  const output = readBucket(entry.output)
  if (!cacheMiss || !output) return null
  return {
    source,
    currency,
    unit: UNIT,
    fetchedAt: options.fetchedAt ?? null,
    url: options.url ?? null,
    community: Boolean(options.community),
    mapped: false,
    confidence: options.confidence ?? 'exact',
    cacheHit: cacheHit ?? flatPair(0),
    cacheMiss,
    cacheWrite,
    output,
  }
}

function officialPrice(tierTable, tier, officialState) {
  if (!tierTable) return null
  const cacheHit = readBucket(tierTable.cacheHit)
  const cacheMiss = readBucket(tierTable.cacheMiss)
  const output = readBucket(tierTable.output)
  if (!cacheHit || !cacheMiss || !output) return null
  return {
    source: 'official-page',
    currency: 'CNY',
    unit: UNIT,
    fetchedAt: officialState.at ?? null,
    url: officialState.url ?? null,
    community: false,
    mapped: true,
    tier,
    confidence: officialState.confidence ?? 'exact',
    cacheHit,
    cacheMiss,
    cacheWrite: flatPair(0),
    output,
    peakNote: officialState.peakNote ?? null,
  }
}

function readBucket(value) {
  if (value == null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return flatPair(value)
  if (typeof value !== 'object') return null
  const idle = numberOrNull(value.idle ?? value.offPeak ?? value.offpeak ?? value.base)
  const peak = numberOrNull(value.peak ?? value.high ?? value.peakPrice)
  if (idle === null && peak === null) return null
  const resolvedIdle = idle ?? peak
  return { idle: resolvedIdle, peak: peak ?? resolvedIdle }
}

function flatPair(value) {
  return { idle: value, peak: value }
}

function flatPrice(buckets, source, options) {
  return {
    source,
    currency: options.currency ?? 'CNY',
    unit: UNIT,
    fetchedAt: options.fetchedAt ?? null,
    url: options.url ?? null,
    community: Boolean(options.community),
    mapped: false,
    confidence: options.confidence ?? 'override',
    cacheHit: flatPair(buckets.cacheHit),
    cacheMiss: flatPair(buckets.cacheMiss),
    cacheWrite: flatPair(buckets.cacheWrite),
    output: flatPair(buckets.output),
  }
}

function matchModel(models, rawModelId, canonical) {
  if (!Array.isArray(models) || models.length === 0) return null
  const wantedRaw = String(rawModelId ?? '').toLowerCase()
  const wanted = canonical || normalizeModelId(rawModelId)
  let best = null
  for (const model of models) {
    const patternRaw = String(model?.match ?? '').toLowerCase()
    if (!patternRaw) continue
    const pattern = normalizeModelId(patternRaw)
    if (wantedRaw === patternRaw || wanted === pattern) return { model, confidence: 'exact' }
    if ((wanted && pattern && (wanted.includes(pattern) || pattern.includes(wanted))) || (wantedRaw && patternRaw.includes(wantedRaw))) {
      const score = pattern.length
      if (!best || score > best.score) best = { score, model, confidence: 'family' }
    }
  }
  return best ? { model: best.model, confidence: best.confidence } : null
}

// ----------------------------------------------------------- extra catalogs

function parseExtraCatalog(data, extra, url) {
  const fetchedAt = Date.now()
  if (!data || typeof data !== 'object') return null
  let models = []
  if (extra.format === 'openrouter') {
    const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : []
    for (const entry of list) {
      const id = entry?.id ?? entry?.name
      const pricing = entry?.pricing
      if (!id || !pricing || typeof pricing !== 'object') continue
      const prompt = numberOrNull(pricing.prompt)
      const completion = numberOrNull(pricing.completion)
      if (prompt === null && completion === null) continue
      models.push({
        match: String(id),
        cacheHit: (numberOrNull(pricing.input_cache_read) ?? 0) * 1e6,
        cacheMiss: (prompt ?? 0) * 1e6,
        cacheWrite: 0,
        output: (completion ?? 0) * 1e6,
      })
    }
    return models.length > 0 ? { url, fetchedAt, currency: 'USD', models } : null
  }
  if (extra.format === 'newapi') {
    const list = Array.isArray(data.data) ? data.data : []
    for (const entry of list) {
      const name = entry?.model_name
      const ratio = numberOrNull(entry?.model_ratio)
      if (!name || ratio === null) continue
      const completionRatio = numberOrNull(entry?.completion_ratio) ?? ratio
      models.push({
        match: String(name),
        cacheHit: (numberOrNull(entry?.cache_ratio) ?? 0) * 2,
        cacheMiss: ratio * 2,
        cacheWrite: 0,
        output: completionRatio * 2,
      })
    }
    return models.length > 0 ? { url, fetchedAt, currency: 'USD', models } : null
  }
  // modelsdev-shaped document: { provider: { models: { id: { cost } } } }
  for (const provider of Object.values(data)) {
    if (!provider || typeof provider !== 'object' || !provider.models) continue
    for (const [id, model] of Object.entries(provider.models)) {
      const cost = model?.cost
      if (!cost || typeof cost !== 'object') continue
      models.push({
        match: String(id),
        cacheHit: numberOrNull(cost.cache_read) ?? 0,
        cacheMiss: numberOrNull(cost.input) ?? 0,
        cacheWrite: numberOrNull(cost.cache_write) ?? 0,
        output: numberOrNull(cost.output) ?? 0,
      })
    }
  }
  return models.length > 0 ? { url, fetchedAt, currency: 'USD', models } : null
}

// ------------------------------------------------------------------ zones

function resolveZone(zone, fallback) {
  if (typeof zone === 'string' && zone.trim()) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date())
      return zone
    } catch {
      // fall through
    }
  }
  return fallback
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function zoneParts(zone, atMs) {
  const date = new Date(Number(atMs) || 0)
  let parts = []
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)
  } catch {
    parts = []
  }
  const map = {}
  for (const part of parts) map[part.type] = part.value
  const year = map.year ?? String(date.getUTCFullYear())
  const month = map.month ?? String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = map.day ?? String(date.getUTCDate()).padStart(2, '0')
  const hour = Number(map.hour ?? date.getUTCHours()) % 24
  const minute = Number(map.minute ?? date.getUTCMinutes())
  return {
    date: `${year}-${month}-${day}`,
    weekday: WEEKDAYS[map.weekday] ?? date.getUTCDay(),
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0,
  }
}

function zoneOffsetHours(zone, atMs) {
  try {
    const text = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(new Date(Number(atMs) || 0))
      .find((part) => part.type === 'timeZoneName')?.value
    const match = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(text ?? '')
    if (!match) return null
    const sign = match[1] === '-' ? -1 : 1
    return sign * (Number(match[2]) + (Number(match[3] ?? 0) / 60))
  } catch {
    return null
  }
}

// -------------------------------------------------------------------- misc

function isDeepSeekProvider(providerId) {
  return /deepseek/i.test(String(providerId))
}

function numberOrNull(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// -------------------------------------------------------------------- http

async function fetchText(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { accept: 'text/html,*/*', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return response.text()
}

async function fetchJson(url, { timeoutMs = 20000 } = {}) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return response.json()
}
