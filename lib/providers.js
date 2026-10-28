/**
 * Provider discovery + the `?kind=overview` engine.
 *
 * Discovery has three layers, strongest first:
 *
 *   1. `ctx.get('llm').listProviders()`        — routes with a live adapter
 *      `ctx.get('llm').listConfigurableProviders()` — route -> settings namespace
 *      `ctx.get('configEditor').entries()`      — the route's `{baseURL, apiKeyEnv}`
 *        from `section.providers[routeId]` of the entry whose `options.id`
 *        equals the route's settings namespace.
 *   2. `defaultBaseURL` / `nativeAuth.env` / `displayName` declared by the
 *      configurable-provider directory (live host metadata).
 *   3. `KNOWN_ROUTES` below, a frozen snapshot for when the shape is unavailable.
 *
 * `config.providers` entries are manual overrides: same-id wins over a detected
 * route, and `enabled: false` removes it.
 *
 * Shapes are frozen by README.md ("HTTP 契约") and INTERFACES.md.
 */

import {
  adapterFor,
  fetchJson,
  fetchNewApiCatalog,
  fetchOpenRouterCatalog,
  isNewApiRelayCandidate,
  isRetryableError,
  originOf,
} from './adapters.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RESULT_CACHE_TTL_MS = 30_000
const PRICE_CACHE_TTL_MS = 300_000
const DEFAULT_PEER_TIMEOUT_MS = 12_000
const DEFAULT_OVERVIEW_CACHE_SEC = 15
const UNSUPPORTED_MESSAGE = 'no balance API for this provider'
const TIMEOUT_MESSAGE = 'timed out'

/** Sentinel resolved by `withTimeout`, so a timed-out query is never cached. */
const TIMED_OUT = Symbol('timed-out')

/**
 * Built-in route table. Values are a last-resort snapshot of the host catalog;
 * live configuration always wins. `null` means "this route needs no such value".
 */
export const KNOWN_ROUTES = {
  'deepseek-official': { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', displayName: 'DeepSeek' },
  'deepseek-account': { baseURL: null, apiKeyEnv: null, displayName: 'DeepSeek Account' },
  'kimi-coding': { baseURL: 'https://api.kimi.com/coding', apiKeyEnv: 'KIMI_API_KEY', displayName: 'Kimi Coding' },
  'moonshotai-cn': { baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY', displayName: 'Moonshot (CN)' },
  'moonshotai': { baseURL: 'https://api.moonshot.ai/v1', apiKeyEnv: 'MOONSHOT_API_KEY', displayName: 'Moonshot' },
  'openrouter': { baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', displayName: 'OpenRouter' },
  'xai': { baseURL: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY', displayName: 'xAI' },
  'vercel-ai-gateway': {
    baseURL: 'https://ai-gateway.vercel.sh',
    apiKeyEnv: 'AI_GATEWAY_API_KEY',
    displayName: 'Vercel AI Gateway',
  },
  'zai': { baseURL: 'https://api.z.ai/api/coding/paas/v4', apiKeyEnv: 'ZAI_API_KEY', displayName: 'Z.ai' },
  'zai-coding-cn': {
    baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
    apiKeyEnv: 'ZAI_CODING_CN_API_KEY',
    displayName: 'Z.ai (CN)',
  },
  'minimax': { baseURL: 'https://api.minimax.io/anthropic', apiKeyEnv: 'MINIMAX_API_KEY', displayName: 'MiniMax' },
  'minimax-cn': {
    baseURL: 'https://api.minimaxi.com/anthropic',
    apiKeyEnv: 'MINIMAX_CN_API_KEY',
    displayName: 'MiniMax (CN)',
  },
  'opencode': { baseURL: 'https://opencode.ai/api', apiKeyEnv: 'OPENCODE_API_KEY', displayName: 'OpenCode' },
  'opencode-go': { baseURL: 'https://opencode.ai/api', apiKeyEnv: 'OPENCODE_API_KEY', displayName: 'OpenCode Go' },
  'openai': { baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', displayName: 'OpenAI' },
  'anthropic': { baseURL: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', displayName: 'Anthropic' },
  'github-copilot': {
    baseURL: 'https://api.individual.githubcopilot.com',
    apiKeyEnv: 'COPILOT_GITHUB_TOKEN',
    displayName: 'GitHub Copilot',
  },
  'openai-codex': { baseURL: 'https://chatgpt.com/backend-api', apiKeyEnv: null, displayName: 'OpenAI Codex' },
  'ark-agent-plan': {
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyEnv: 'ARK_API_KEY',
    displayName: 'Volcengine Ark (Agent Plan)',
  },
  'ark-coding-plan': {
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyEnv: 'ARK_API_KEY',
    displayName: 'Volcengine Ark (Coding Plan)',
  },
}

/** Route id -> kind, applied before URL heuristics. */
const ROUTE_ID_KINDS = {
  'deepseek-official': 'deepseek',
  'deepseek-account': 'deepseek-account',
  'kimi-coding': 'kimi-coding',
  'moonshotai': 'moonshot',
  'moonshotai-cn': 'moonshot',
  'openrouter': 'openrouter',
  'xai': 'xai',
  'vercel-ai-gateway': 'vercel-ai-gateway',
  'zai': 'zai',
  'zai-coding-cn': 'zai',
  'minimax': 'minimax',
  'minimax-cn': 'minimax',
  'opencode': 'opencode',
  'opencode-go': 'opencode',
  'openai': 'openai',
  'anthropic': 'anthropic',
  'github-copilot': 'github-copilot',
  'openai-codex': 'openai-codex',
  'ark-agent-plan': 'volcengine-ark-agent',
  'ark-coding-plan': 'volcengine-ark-coding',
}

/**
 * URL heuristics, first match wins. Order matters: `deepseek-account` before
 * `deepseek`, `openai-codex` before `openai`.
 */
const BASEURL_KIND_RULES = [
  [/platform\.deepseek\.com/i, 'deepseek-account'],
  [/(^|[./])api\.deepseek\.com/i, 'deepseek'],
  [/kimi\.com\/coding/i, 'kimi-coding'],
  [/openrouter\.ai/i, 'openrouter'],
  [/(^|[./])x\.ai/i, 'xai'],
  [/ai-gateway\.vercel\.sh/i, 'vercel-ai-gateway'],
  [/(^|[./])z\.ai/i, 'zai'],
  [/bigmodel\.cn/i, 'zai'],
  [/minimax/i, 'minimax'],
  [/moonshot\.ai/i, 'moonshot'],
  [/moonshot\.cn/i, 'moonshot'],
  [/opencode\.ai/i, 'opencode'],
  [/githubcopilot\.com/i, 'github-copilot'],
  [/chatgpt\.com\/backend-api/i, 'openai-codex'],
  [/(^|[./])anthropic\.com/i, 'anthropic'],
  [/(^|[./])api\.openai\.com/i, 'openai'],
  [/volces\.com|volcengine/i, 'volcengine-ark-agent'],
]

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function safeGet(ctx, name) {
  try {
    return ctx?.get?.(name) ?? null
  } catch {
    return null
  }
}

/** Call one optional service method; any failure degrades to null. */
function callService(ctx, serviceName, method) {
  const service = safeGet(ctx, serviceName)
  if (!service || typeof service[method] !== 'function') return null
  try {
    return service[method]()
  } catch {
    return null
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

function readPositiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function readNonNegativeNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/** Any absolute URL's query string, which may carry a token or a signature. */
const URL_QUERY_PATTERN = /([a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi

function stripQueryStrings(text) {
  return text.replace(URL_QUERY_PATTERN, '$1')
}

/** Adapter-authored message, safe to return: query strings stripped and bounded. */
function sanitizeMessage(value, limit = 160) {
  if (typeof value !== 'string' || value === '') return null
  const cleaned = stripQueryStrings(value).replace(/\s+/g, ' ').trim()
  return cleaned === '' ? null : cleaned.slice(0, limit)
}

/**
 * Failure text safe for a response or a log: `HTTP <status>` for a provider
 * response, a fixed phrase for transport/deadline failures, and a sanitized
 * message otherwise. Never includes headers, bodies, credential values or
 * account details.
 */
function safeErrorMessage(error) {
  const status = Number(error?.status)
  if (Number.isInteger(status) && status >= 400) return `HTTP ${status}`
  if (error?.timedOut === true || error?.name === 'TimeoutError') return TIMEOUT_MESSAGE
  if (error?.aborted === true) return 'aborted'
  if (error?.transient === true) return 'network error'
  return sanitizeMessage(error?.message, 120) ?? 'request failed'
}

/**
 * Race one query against its own deadline. The timer is always cleared, so a
 * fast provider leaves nothing behind, and `onTimeout()` resolves instead of
 * rejecting so callers keep their single settlement path.
 */
async function withTimeout(promise, timeoutMs, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  let timer = null
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), timeoutMs)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * Unwrap a reactive ref: a config section may be a signal-like object whose
 * value is read through `.get()`. Plain objects are returned unchanged.
 */
function unwrapRef(value) {
  let current = value
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== 'object') break
    const getter = current.get
    if (typeof getter !== 'function') break
    try {
      current = getter.call(current)
    } catch {
      return null
    }
  }
  return current
}

function hasUsableBaseURL(baseURL) {
  return originOf(baseURL) !== ''
}

function emptyFragment() {
  return { balances: null, usages: null, spend: null }
}

function manualRouteEnabled(entry) {
  return entry?.enabled !== false
}

// ---------------------------------------------------------------------------
// Kind classification
// ---------------------------------------------------------------------------

/**
 * Classify one route into an adapter `kind`.
 * `explicit` (a manual `config.providers[].kind`) always wins.
 */
export function classifyKind(routeId, baseURL, explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const id = typeof routeId === 'string' ? routeId.toLowerCase() : ''
  if (id !== '' && Object.prototype.hasOwnProperty.call(ROUTE_ID_KINDS, id)) return ROUTE_ID_KINDS[id]
  const url = typeof baseURL === 'string' ? baseURL : ''
  for (const [pattern, kind] of BASEURL_KIND_RULES) {
    if (pattern.test(url)) return kind
  }
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Build the provider engine.
 *
 * @param {object} ctx Cordis host context (`ctx.get(...)` service accessor).
 * @param {object} config resolved plugin config.
 * @returns {{overview: () => Promise<object>, getProviderPrices: (id: string) => Promise<object|null>, routes: () => Array<object>}}
 */
export function createProvidersEngine(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {}
  const resultCache = new Map()
  const priceCache = new Map()
  const warned = new Set()
  const peerTimeoutMs = readPositiveNumber(settings.peerTimeoutMs, DEFAULT_PEER_TIMEOUT_MS)
  const overviewCacheMs =
    readNonNegativeNumber(settings.overviewCacheSec, DEFAULT_OVERVIEW_CACHE_SEC) * 1000
  /** Whole-overview cache: `{at, payload}`. */
  let overviewCache = null
  /** Shared in-flight overview so concurrent calls do the work once. */
  let overviewInFlight = null

  function warnOnce(key, message) {
    if (warned.has(key)) return
    warned.add(key)
    try {
      ctx.logger?.warn?.(`[balance-usage] ${message}`)
    } catch {
      // logging must never break a response
    }
  }

  // -- credential access ----------------------------------------------------

  async function resolveCredential(ref) {
    if (typeof ref !== 'string' || ref === '') return { ok: false, ref: null, value: null }
    let value
    const credentials = safeGet(ctx, 'credentials')
    if (credentials && typeof credentials.resolve === 'function') {
      try {
        const hit = await credentials.resolve(ref)
        value = typeof hit === 'string' ? hit : hit?.value
      } catch {
        value = undefined
      }
    }
    if (typeof value !== 'string' || value === '') {
      const fromEnv = process.env?.[ref]
      if (typeof fromEnv === 'string' && fromEnv !== '') value = fromEnv
    }
    return {
      ok: typeof value === 'string' && value !== '',
      ref,
      value: typeof value === 'string' && value !== '' ? value : null,
    }
  }

  // -- config reading -------------------------------------------------------

  /**
   * Map settings namespace -> resolved plugin config, read duck-typed from the
   * Loader entries. `entry.options.id` is the settings namespace (the host's
   * own convention), and `entry.fiber.config` is the resolved section.
   */
  function collectConfigSections() {
    const sections = new Map()
    const editor = safeGet(ctx, 'configEditor')
    if (!editor || typeof editor.entries !== 'function') return sections
    let entries = []
    try {
      const value = editor.entries()
      if (Array.isArray(value)) entries = value
    } catch {
      return sections
    }
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      const resolved = unwrapRef(entry.fiber?.config ?? entry.config ?? entry.options?.config)
      if (!resolved || typeof resolved !== 'object') continue
      const candidates = []
      if (typeof entry.options?.id === 'string' && entry.options.id !== '') candidates.push(entry.options.id)
      try {
        if (typeof entry.id === 'string' && entry.id !== '') candidates.push(entry.id)
      } catch {
        // some Loader entries throw while detached from their parent group
      }
      for (const id of candidates) {
        if (!sections.has(id)) sections.set(id, resolved)
      }
    }
    return sections
  }

  /**
   * Resolve `{baseURL, apiKeyEnv, displayName}` for one route.
   *
   * Two host conventions exist, and both are duck-typed here:
   *
   *   - multi-provider adapters (pi-ai): `section.providers[routeId] = {...}`
   *   - single-provider adapters (llm-deepseek-api-key): the section itself is
   *     the profile, and each field may be a reactive ref read through `.get()`
   */
  function readProfile(sections, settingsNs, routeId) {
    if (typeof settingsNs !== 'string' || settingsNs === '') return null
    const section = sections.get(settingsNs)
    if (!section || typeof section !== 'object') return null
    const providers = unwrapRef(section.providers)
    if (providers && typeof providers === 'object') {
      const nested = unwrapRef(providers[routeId])
      if (nested && typeof nested === 'object') return readProfileFields(nested)
    }
    const flat = readProfileFields(section)
    return flat.baseURL || flat.apiKeyEnv || flat.displayName ? flat : null
  }

  /** Read one profile's fields, unwrapping a reactive ref per field. */
  function readProfileFields(node) {
    return {
      baseURL: firstString(unwrapRef(node.baseURL)),
      apiKeyEnv: firstString(unwrapRef(node.apiKeyEnv)),
      displayName: firstString(unwrapRef(node.displayName)),
    }
  }

  // -- route resolution -----------------------------------------------------

  function buildDetectedRoutes(sections) {
    const registered = asArray(callService(ctx, 'llm', 'listProviders'))
    const declaredList = asArray(callService(ctx, 'llm', 'listConfigurableProviders'))
    const declaredById = new Map()
    for (const declared of declaredList) {
      const id = firstString(declared?.provider)
      if (id) declaredById.set(id, declared)
    }
    const routes = []
    const seen = new Set()
    for (const provider of registered) {
      const id = firstString(provider?.id)
      if (!id || seen.has(id)) continue
      seen.add(id)
      const declared = declaredById.get(id) ?? null
      const settingsNs = firstString(declared?.settingsNs) ?? id
      const profile = readProfile(sections, settingsNs, id)
      const known = KNOWN_ROUTES[id] ?? {}
      const nativeAuthEnv = Array.isArray(declared?.nativeAuth?.env) ? declared.nativeAuth.env[0] : null
      const baseURL = firstString(profile?.baseURL, declared?.defaultBaseURL, known.baseURL)
      const apiKeyEnv = firstString(profile?.apiKeyEnv, nativeAuthEnv, known.apiKeyEnv)
      const displayName = firstString(
        profile?.displayName,
        declared?.displayName,
        provider?.name,
        known.displayName,
        id,
      )
      routes.push({
        id,
        displayName,
        baseURL,
        apiKeyEnv,
        kind: classifyKind(id, baseURL),
        source: 'detected',
      })
    }
    return routes
  }

  function applyManualRoutes(routes) {
    const manual = new Map()
    for (const entry of asArray(settings.providers)) {
      if (!entry || typeof entry !== 'object') continue
      const id = firstString(entry.id)
      if (id && !manual.has(id)) manual.set(id, entry)
    }
    const merged = []
    for (const route of routes) {
      const override = manual.get(route.id)
      if (!override) {
        merged.push(route)
        continue
      }
      manual.delete(route.id)
      if (!manualRouteEnabled(override)) continue
      merged.push({
        ...route,
        displayName: firstString(override.displayName, route.displayName),
        baseURL: firstString(override.baseURL, route.baseURL),
        apiKeyEnv: firstString(override.apiKeyEnv, route.apiKeyEnv),
        kind: classifyKind(route.id, firstString(override.baseURL, route.baseURL), override.kind),
        source: 'manual',
      })
    }
    for (const [id, entry] of manual) {
      if (!manualRouteEnabled(entry)) continue
      const baseURL = firstString(entry.baseURL, KNOWN_ROUTES[id]?.baseURL)
      merged.push({
        id,
        displayName: firstString(entry.displayName, KNOWN_ROUTES[id]?.displayName, id),
        baseURL,
        apiKeyEnv: firstString(entry.apiKeyEnv, KNOWN_ROUTES[id]?.apiKeyEnv),
        kind: classifyKind(id, baseURL, entry.kind),
        source: 'manual',
      })
    }
    return merged
  }

  function resolveRoutes() {
    try {
      const sections = collectConfigSections()
      return applyManualRoutes(buildDetectedRoutes(sections))
    } catch (error) {
      warnOnce('routes', `provider discovery failed: ${safeErrorMessage(error)}`)
      return []
    }
  }

  // -- per-provider query ---------------------------------------------------

  function baseFragment(status, message) {
    return { status, message: message ?? null, retryable: false, ...emptyFragment() }
  }

  function normalizeFragment(fragment) {
    const source = fragment && typeof fragment === 'object' ? fragment : {}
    const status = typeof source.status === 'string' && source.status !== '' ? source.status : 'ok'
    return {
      status,
      message: sanitizeMessage(source.message),
      retryable: source.retryable === true,
      balances: Array.isArray(source.balances) ? source.balances : null,
      usages: Array.isArray(source.usages) ? source.usages : null,
      spend: source.spend && typeof source.spend === 'object' ? source.spend : null,
    }
  }

  async function queryRoute(route, now) {
    const adapter = adapterFor(route.kind)
    if (!adapter) return baseFragment('unsupported', UNSUPPORTED_MESSAGE)
    if (adapter.requiresBaseURL !== false && !hasUsableBaseURL(route.baseURL)) {
      return baseFragment('unsupported', UNSUPPORTED_MESSAGE)
    }

    let apiKey
    if (adapter.requiresCredential !== false) {
      const ref = typeof route.apiKeyEnv === 'string' && route.apiKeyEnv !== '' ? route.apiKeyEnv : null
      const resolved = await resolveCredential(ref)
      if (!resolved.ok) {
        return baseFragment('missing-credential', `missing credential ${ref ?? route.id}`)
      }
      apiKey = resolved.value
    }

    try {
      // `resolveCredential` lets multi-slot adapters (Volcengine AK/SK) probe
      // several refs with the same store-then-env fallback used here.
      const fragment = await adapter.query({ ctx, route, apiKey, now, fetchJson, resolveCredential })
      return normalizeFragment(fragment)
    } catch (error) {
      if (adapter.adminKey === true && (error?.status === 401 || error?.status === 403)) {
        return baseFragment('missing-authorization', `provider rejected the admin key (HTTP ${error.status})`)
      }
      throw error
    }
  }

  function timeoutFragment() {
    return {
      status: 'error',
      message: TIMEOUT_MESSAGE,
      retryable: true,
      balances: null,
      usages: null,
      spend: null,
      at: Date.now(),
    }
  }

  /** Never rejects: every adapter failure becomes a classified row fragment. */
  async function runRoute(route, now) {
    try {
      const fragment = await queryRoute(route, now)
      return { ...fragment, at: Date.now() }
    } catch (error) {
      const message = safeErrorMessage(error)
      warnOnce(`${route.id}@${Math.floor(now / RESULT_CACHE_TTL_MS)}`, `provider ${route.id} failed: ${message}`)
      return { ...baseFragment('error', message), retryable: isRetryableError(error), at: Date.now() }
    }
  }

  /** 30s cached fragment, or one fresh query bounded by `peerTimeoutMs`. */
  async function routeOutcome(route, now) {
    const cached = resultCache.get(route.id)
    if (cached && now - cached.at < RESULT_CACHE_TTL_MS) {
      return { fragment: cached.fragment, stale: true }
    }
    const outcome = await withTimeout(runRoute(route, now), peerTimeoutMs, () => TIMED_OUT)
    if (outcome === TIMED_OUT) return { fragment: timeoutFragment(), stale: false }
    resultCache.set(route.id, { at: outcome.at, fragment: outcome })
    return { fragment: outcome, stale: false }
  }

  // -- public surface -------------------------------------------------------

  function readActiveProviderId() {
    const selection = (() => {
      const service = safeGet(ctx, 'agentDefaultModel')
      if (!service || typeof service.currentSelection !== 'function') return null
      try {
        return service.currentSelection()
      } catch {
        return null
      }
    })()
    return firstString(selection?.provider)
  }

  function compareRows(a, b) {
    if (a.active !== b.active) return a.active ? -1 : 1
    return String(a.displayName ?? a.id).localeCompare(String(b.displayName ?? b.id))
  }

  /** One full discovery + bounded per-provider pass. */
  async function computeOverview() {
    const startedAt = Date.now()
    const active = readActiveProviderId()
    const routes = resolveRoutes()
    const providers = await Promise.all(
      routes.map(async (route) => {
        const { fragment, stale } = await routeOutcome(route, startedAt)
        return {
          id: route.id,
          displayName: route.displayName,
          kind: route.kind,
          status: fragment.status,
          message: fragment.message,
          retryable: fragment.retryable === true,
          balances: fragment.balances,
          usages: fragment.usages,
          spend: fragment.spend,
          active: route.id === active,
          fetchedAt: fragment.at,
          stale,
        }
      }),
    )
    providers.sort(compareRows)
    const failed = providers.filter((row) => row.status === 'error').length
    const usable = providers.filter((row) => row.status === 'ok').length
    return {
      fetchedAt: Date.now(),
      active,
      degraded: failed > 0 && usable > 0,
      providers,
    }
  }

  /** Never rejects: a failed price fetch is simply "no catalog". */
  async function loadPriceCatalog(providerRouteId) {
    try {
      const route = resolveRoutes().find((entry) => entry.id === providerRouteId) ?? null
      if (!route) return null
      if (route.kind === 'openrouter') {
        const catalog = await fetchOpenRouterCatalog({ route, fetchJson, now: Date.now() })
        if (catalog) return catalog
      }
      if (isNewApiRelayCandidate(route.baseURL)) {
        return await fetchNewApiCatalog({ route, fetchJson, now: Date.now() })
      }
      return null
    } catch (error) {
      const message = safeErrorMessage(error)
      warnOnce(
        `prices:${providerRouteId}@${Math.floor(Date.now() / PRICE_CACHE_TTL_MS)}`,
        `price catalog for ${providerRouteId} failed: ${message}`,
      )
      return null
    }
  }

  return {
    async overview() {
      const now = Date.now()
      if (overviewCache && overviewCacheMs > 0 && now - overviewCache.at < overviewCacheMs) {
        return overviewCache.payload
      }
      if (overviewInFlight) return overviewInFlight
      const task = computeOverview()
      overviewInFlight = task
      try {
        const payload = await task
        if (overviewCacheMs > 0) overviewCache = { at: Date.now(), payload }
        return payload
      } finally {
        if (overviewInFlight === task) overviewInFlight = null
      }
    },

    /**
     * Provider-owned price catalog for one route, bounded by `peerTimeoutMs`.
     * Returns null for every route that exposes no pricing endpoint; never throws.
     */
    async getProviderPrices(providerRouteId) {
      if (typeof providerRouteId !== 'string' || providerRouteId === '') return null
      const key = `prices:${providerRouteId}`
      const now = Date.now()
      const cached = priceCache.get(key)
      if (cached && now - cached.at < PRICE_CACHE_TTL_MS) return cached.catalog
      const outcome = await withTimeout(loadPriceCatalog(providerRouteId), peerTimeoutMs, () => TIMED_OUT)
      // A deadline miss is not cached: the next refresh should try again.
      if (outcome === TIMED_OUT) return null
      priceCache.set(key, { at: Date.now(), catalog: outcome })
      return outcome
    },

    routes() {
      return resolveRoutes().map((route) => ({
        id: route.id,
        displayName: route.displayName,
        kind: route.kind,
      }))
    },
  }
}
