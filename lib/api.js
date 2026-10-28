import { createPricingEngine } from './pricing.js'
import { createUsageEngine } from './usage.js'

/**
 * Handler map for `/balance-usage-api`. Each handler returns the `data` payload;
 * throwing `{ status, message }` produces the documented error envelope.
 *
 * `lib/providers.js` is loaded lazily so the plugin stays loadable (dock + ping)
 * while that module is being authored or temporarily missing.
 */
export function createHandlers(ctx, config, version) {
  let providers = null
  let pricing = null
  let usage = null

  const overviewCache = { value: null, at: 0, inflight: null }
  const sessionCache = new Map()
  const errors = []

  function recordError(code, message) {
    errors.push({ code: String(code ?? 'internal'), message: String(message ?? '').slice(0, 240), at: Date.now() })
    const limit = Math.max(1, Number(config.diagnosticsErrors) || 20)
    while (errors.length > limit) errors.shift()
  }

  async function engines() {
    if (!providers) {
      providers = await loadProviders()
      pricing = createPricingEngine(ctx, config, { getProviderPrices: providers.getProviderPrices })
      usage = createUsageEngine(ctx, config, pricing)
    }
    return { providers, pricing, usage }
  }

  async function loadProviders() {
    try {
      const module = await import('./providers.js')
      if (typeof module.createProvidersEngine === 'function') {
        return module.createProvidersEngine(ctx, config)
      }
      ctx.logger?.warn?.('[balance-usage] ./providers.js does not export createProvidersEngine')
    } catch (error) {
      ctx.logger?.warn?.(`[balance-usage] provider engine unavailable: ${error?.message ?? error}`)
    }
    return {
      async overview() {
        return { fetchedAt: Date.now(), active: null, providers: [], unavailable: true, degraded: true }
      },
      async getProviderPrices() {
        return null
      },
      routes() {
        return []
      },
    }
  }

  async function overview(force) {
    const ttlMs = Math.max(0, Number(config.overviewCacheSec) || 0) * 1000
    if (!force && overviewCache.value && Date.now() - overviewCache.at < ttlMs) {
      return overviewCache.value
    }
    if (overviewCache.inflight) return overviewCache.inflight
    overviewCache.inflight = (async () => {
      try {
        const { providers: engine } = await engines()
        const value = await engine.overview()
        overviewCache.value = value
        overviewCache.at = Date.now()
        return value
      } finally {
        overviewCache.inflight = null
      }
    })()
    return overviewCache.inflight
  }

  async function sessionUsage(sessionId, force) {
    const ttlMs = Math.max(0, Number(config.sessionCacheSec) || 0) * 1000
    const cached = sessionCache.get(sessionId)
    if (!force && cached?.value && Date.now() - cached.at < ttlMs) return cached.value
    if (cached?.inflight) return cached.inflight
    const entry = { value: cached?.value ?? null, at: cached?.at ?? 0, inflight: null }
    sessionCache.set(sessionId, entry)
    entry.inflight = (async () => {
      try {
        const { usage: engine } = await engines()
        const value = await engine.sessionUsage(sessionId)
        entry.value = value
        entry.at = Date.now()
        return value
      } finally {
        entry.inflight = null
      }
    })()
    return entry.inflight
  }

  const handlers = {
    ping() {
      return {
        plugin: 'dsh-balance-usage-dock',
        version,
        time: Date.now(),
        profile: process.env.DSH_PROFILE ?? null,
      }
    },

    config() {
      return {
        pluginVersion: version,
        refresh: {
          overviewSec: config.clientRefresh.overviewSec,
          sessionRunningSec: config.clientRefresh.sessionRunningSec,
          sessionIdleSec: config.clientRefresh.sessionIdleSec,
          statsSec: config.clientRefresh.statsSec,
        },
        retry: {
          maxRetries: config.clientRetry.maxRetries,
          requestTimeoutMs: config.clientRetry.requestTimeoutMs,
        },
        heatmapDays: config.statsDays,
      }
    },

    async diagnostics() {
      const { pricing: engine } = await engines()
      const capabilities = {
        webServer: has(ctx, 'webServer', 'register'),
        credentials: has(ctx, 'credentials', 'resolve'),
        llm: has(ctx, 'llm', 'listProviders'),
        sessionQuery: has(ctx, 'sessionQuery', 'listSessions'),
        sessionController: has(ctx, 'sessionController', 'inspect'),
        subagents: has(ctx, 'subagents', 'listDescendants'),
        modelDirectories: null,
      }
      let price = null
      try {
        price = await engine.snapshot()
      } catch {
        price = null
      }
      let providerStats = null
      try {
        const snapshot = overviewCache.value ?? (await overview(false))
        const byStatus = {}
        for (const provider of snapshot?.providers ?? []) {
          const key = String(provider?.status ?? 'unknown')
          byStatus[key] = (byStatus[key] ?? 0) + 1
        }
        providerStats = { total: snapshot?.providers?.length ?? 0, byStatus }
      } catch {
        providerStats = null
      }
      return {
        plugin: 'dsh-balance-usage-dock',
        version,
        dshProfile: process.env.DSH_PROFILE ?? null,
        capabilities,
        price: price
          ? {
              source: price.source ?? null,
              fetchedAt: price.fetchedAt ?? null,
              stale: Boolean(price.stale),
              warning: price.warning ?? null,
              sources: config.pricingSources,
            }
          : null,
        providers: providerStats,
        errors: errors.slice(-Math.max(1, Number(config.diagnosticsErrors) || 20)),
        config: {
          refreshSeconds: config.refreshSeconds,
          statsDays: config.statsDays,
          statsSessionLimit: config.statsSessionLimit,
          pricingTtlSec: config.pricingTtlSec,
          peakTimeZone: config.peakTimeZone,
          statsTimeZone: config.statsTimeZone,
          holidays: config.holidays.length,
          pricingSources: config.pricingSources,
          extraPriceCatalogs: config.extraPriceCatalogs.length,
          providersConfigured: config.providers.length,
          warmup: config.warmup,
        },
        generatedAt: Date.now(),
      }
    },

    async overview({ params }) {
      return overview(params.get('refresh') === '1')
    },

    async session({ params }) {
      const sessionId = params.get('session')
      if (!sessionId) throw badRequest('A session id is required.')
      return sessionUsage(sessionId, params.get('refresh') === '1')
    },

    async stats({ params }) {
      const { usage: engine } = await engines()
      return engine.stats({ force: params.get('refresh') === '1' })
    },

    async pricing({ params }) {
      const { pricing: engine } = await engines()
      if (params.get('refresh') === '1') {
        return engine.refresh({ force: true })
      }
      return engine.snapshot()
    },
  }

  async function warmup() {
    try {
      await Promise.allSettled([
        overview(false),
        handlers.stats({ params: new URLSearchParams() }),
        handlers.pricing({ params: new URLSearchParams() }),
      ])
    } catch {
      // best effort
    }
  }

  return { handlers, warmup, recordError }
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 })
}

function has(ctx, service, method) {
  try {
    const value = ctx.get(service)
    return Boolean(value && typeof value[method] === 'function')
  } catch {
    return false
  }
}
