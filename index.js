import { createHandlers } from './lib/api.js'
import { registerRoute } from './lib/http.js'

const PLUGIN_NAME = 'dsh-balance-usage-dock'
const PLUGIN_VERSION = '0.2.0'

const DEFAULT_CONFIG = {
  refreshSeconds: 60,
  statsDays: 90,
  statsSessionLimit: 200,
  statsCacheSec: 300,
  dayTimeZoneOffsetHours: 8,
  peakTimeZone: 'Asia/Shanghai',
  statsTimeZone: null,
  holidays: [],
  peakWindows: [
    { start: 9, end: 12 },
    { start: 14, end: 18 },
  ],
  peakWeekdays: [1, 2, 3, 4, 5],
  pricingSources: ['provider-catalog', 'official-page', 'models.dev'],
  officialPricingUrls: [
    'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    'https://api-docs.deepseek.com/quick_start/pricing/',
  ],
  modelsDevUrl: 'https://models.dev/api.json',
  pricingTtlSec: 43200,
  priceOverrides: {},
  modelAliases: {},
  extraPriceCatalogs: [],
  providers: [],
  trustedHosts: [],
  requestTimeoutMs: 15000,
  peerTimeoutMs: 12000,
  overviewCacheSec: 15,
  sessionCacheSec: 1,
  warmup: true,
  warmupDelayMs: 1500,
  diagnosticsErrors: 20,
  clientRefresh: {
    overviewSec: 60,
    sessionRunningSec: 3,
    sessionIdleSec: 15,
    statsSec: 60,
  },
  clientRetry: {
    maxRetries: 2,
    requestTimeoutMs: 20000,
  },
}

export const inject = ['webServer']

export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  ctx.effect(() => {
    const api = createHandlers(ctx, resolved, PLUGIN_VERSION)
    const disposeRoute = registerRoute(ctx, resolved, api.handlers, api)
    let timer = null
    if (resolved.warmup) {
      timer = setTimeout(() => {
        try {
          Promise.resolve(api.warmup()).catch(() => {})
        } catch {
          // warmup is best-effort
        }
      }, resolved.warmupDelayMs)
    }
    return () => {
      if (timer !== null) clearTimeout(timer)
      disposeRoute()
    }
  })
}

export function resolveConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const merged = { ...DEFAULT_CONFIG, ...source }
  const clientRefresh = { ...DEFAULT_CONFIG.clientRefresh, ...(isObject(merged.clientRefresh) ? merged.clientRefresh : {}) }
  const clientRetry = { ...DEFAULT_CONFIG.clientRetry, ...(isObject(merged.clientRetry) ? merged.clientRetry : {}) }
  return {
    ...merged,
    pluginVersion: PLUGIN_VERSION,
    refreshSeconds: clampInt(merged.refreshSeconds, 60, 5, 86400),
    statsDays: clampInt(merged.statsDays, 90, 1, 365),
    statsSessionLimit: clampInt(merged.statsSessionLimit, 200, 1, 5000),
    statsCacheSec: clampInt(merged.statsCacheSec, 300, 0, 86400),
    dayTimeZoneOffsetHours: clampNumber(merged.dayTimeZoneOffsetHours, 8, -12, 14),
    peakTimeZone: normalizeZone(merged.peakTimeZone, DEFAULT_CONFIG.peakTimeZone),
    statsTimeZone: merged.statsTimeZone == null ? null : normalizeZone(merged.statsTimeZone, null),
    holidays: normalizeHolidays(merged.holidays),
    peakWindows: normalizePeakWindows(merged.peakWindows),
    peakWeekdays: normalizeWeekdays(merged.peakWeekdays),
    pricingSources: normalizePricingSources(merged.pricingSources),
    officialPricingUrls: normalizeUrls(merged.officialPricingUrls, DEFAULT_CONFIG.officialPricingUrls),
    modelsDevUrl: typeof merged.modelsDevUrl === 'string' ? merged.modelsDevUrl : DEFAULT_CONFIG.modelsDevUrl,
    pricingTtlSec: clampInt(merged.pricingTtlSec, 43200, 3600, 604800),
    priceOverrides: isObject(merged.priceOverrides) ? merged.priceOverrides : {},
    modelAliases: isObject(merged.modelAliases) ? merged.modelAliases : {},
    extraPriceCatalogs: normalizeExtraCatalogs(merged.extraPriceCatalogs),
    providers: Array.isArray(merged.providers) ? merged.providers.filter(isObject) : [],
    trustedHosts: Array.isArray(merged.trustedHosts) ? merged.trustedHosts.filter((h) => typeof h === 'string') : [],
    requestTimeoutMs: clampInt(merged.requestTimeoutMs, 15000, 1000, 120000),
    peerTimeoutMs: clampInt(merged.peerTimeoutMs, 12000, 1000, 120000),
    overviewCacheSec: clampInt(merged.overviewCacheSec, 15, 0, 3600),
    sessionCacheSec: clampInt(merged.sessionCacheSec, 1, 0, 600),
    warmup: merged.warmup !== false,
    warmupDelayMs: clampInt(merged.warmupDelayMs, 1500, 0, 60000),
    diagnosticsErrors: clampInt(merged.diagnosticsErrors, 20, 1, 200),
    clientRefresh: {
      overviewSec: clampInt(clientRefresh.overviewSec, 60, 5, 3600),
      sessionRunningSec: clampInt(clientRefresh.sessionRunningSec, 3, 1, 300),
      sessionIdleSec: clampInt(clientRefresh.sessionIdleSec, 15, 2, 3600),
      statsSec: clampInt(clientRefresh.statsSec, 60, 10, 3600),
    },
    clientRetry: {
      maxRetries: clampInt(clientRetry.maxRetries, 2, 0, 5),
      requestTimeoutMs: clampInt(clientRetry.requestTimeoutMs, 20000, 2000, 120000),
    },
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function normalizeZone(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date())
    return value
  } catch {
    return fallback
  }
}

function normalizeHolidays(value) {
  if (!Array.isArray(value)) return []
  const dates = value.filter((entry) => typeof entry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry))
  return [...new Set(dates)].sort()
}

function normalizePeakWindows(value) {
  if (!Array.isArray(value) || value.length === 0) return DEFAULT_CONFIG.peakWindows
  const windows = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const start = clampInt(entry.start, NaN, 0, 24)
    const end = clampInt(entry.end, NaN, 0, 24)
    if (Number.isFinite(start) && Number.isFinite(end) && start < end) windows.push({ start, end })
  }
  return windows.length > 0 ? windows : DEFAULT_CONFIG.peakWindows
}

function normalizeWeekdays(value) {
  if (!Array.isArray(value)) return DEFAULT_CONFIG.peakWeekdays
  const days = [...new Set(value.map((d) => clampInt(d, NaN, 0, 6)).filter((d) => Number.isFinite(d)))].sort()
  return days.length > 0 ? days : DEFAULT_CONFIG.peakWeekdays
}

function normalizePricingSources(value) {
  const allowed = new Set(['provider-catalog', 'official-page', 'models.dev'])
  if (!Array.isArray(value)) return DEFAULT_CONFIG.pricingSources
  const sources = value.filter((v) => typeof v === 'string' && allowed.has(v))
  return sources.length > 0 ? [...new Set(sources)] : DEFAULT_CONFIG.pricingSources
}

function normalizeUrls(value, fallback) {
  if (!Array.isArray(value)) return fallback
  const urls = value.filter((v) => typeof v === 'string' && /^https?:\/\//i.test(v))
  return urls.length > 0 ? urls : fallback
}

function normalizeExtraCatalogs(value) {
  if (!Array.isArray(value)) return []
  const formats = new Set(['openrouter', 'newapi', 'modelsdev'])
  const catalogs = []
  for (const entry of value) {
    if (!isObject(entry) || typeof entry.url !== 'string' || !/^https?:\/\//i.test(entry.url)) continue
    const format = typeof entry.format === 'string' ? entry.format : 'openrouter'
    if (!formats.has(format)) continue
    catalogs.push({
      url: entry.url,
      format,
      currency: typeof entry.currency === 'string' ? entry.currency : 'USD',
      ttlSec: clampInt(entry.ttlSec, 3600, 60, 604800),
      matchPrefix: typeof entry.matchPrefix === 'string' ? entry.matchPrefix : null,
    })
  }
  return catalogs
}

export { PLUGIN_NAME, PLUGIN_VERSION, DEFAULT_CONFIG }
