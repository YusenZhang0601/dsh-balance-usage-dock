/**
 * Provider adapters for balance / quota / spend queries.
 *
 * One isolated async function per provider family, keyed by provider `kind`.
 * An adapter resolves to a row fragment `{status, message, balances, usages, spend}`
 * or throws; `createProvidersEngine` catches the throw and degrades that single
 * provider to `status: 'error'`. Adapters never read the credential store or log
 * secrets: they receive an already-resolved API key.
 *
 * Shapes are frozen by README.md ("HTTP 契约") and INTERFACES.md.
 *
 * Plain ESM, Node 24, no dependencies (only the built-in `node:crypto`).
 */

import { createHash, createHmac } from 'node:crypto'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 20_000
const RETRY_DELAYS_MS = [2_000, 4_000]
const RETRYABLE_STATUSES = new Set([408, 425, 429])
const USER_AGENT = 'dsh-balance-usage-dock/0.1.0'
const DEFAULT_CURRENCY = 'USD'

/** Reserved for kinds that are recognized but not yet implemented. */
export const ADAPTER_PENDING_MESSAGE = 'adapter pending'

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Coerce to a finite number; empty strings, booleans and objects become null. */
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** Money as a bounded decimal string; sub-cent values keep visible precision. */
export function amountText(value, fallback = '0.00') {
  const parsed = toNumber(value)
  if (parsed === null) return fallback
  const magnitude = Math.abs(parsed)
  if (magnitude !== 0 && magnitude < 0.01) {
    return parsed.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  }
  return parsed.toFixed(2)
}

/** Percent clamped to 0..100, or null when the input is not numeric. */
export function percentOf(value) {
  const parsed = toNumber(value)
  if (parsed === null) return null
  return Math.min(100, Math.max(0, parsed))
}

/** Epoch milliseconds from seconds, milliseconds or an ISO timestamp. */
export function epochMsOf(value) {
  const numeric = toNumber(value)
  if (numeric !== null) {
    if (numeric > 1e12) return Math.round(numeric)
    if (numeric > 1e9) return Math.round(numeric * 1000)
    return Math.round(numeric)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/** First day of the current UTC month, epoch milliseconds. */
export function startOfUtcMonth(now) {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

/** First day of the current UTC month, ISO-8601. */
export function isoUtcMonthStart(now) {
  return new Date(startOfUtcMonth(now)).toISOString()
}

/** Strip trailing slashes from a configured base URL, keeping any path. */
export function baseOf(baseURL) {
  if (typeof baseURL !== 'string') return ''
  return baseURL.trim().replace(/\/+$/, '')
}

/** `scheme://host[:port]` of a configured base URL, or '' when unparseable. */
export function originOf(baseURL) {
  const base = baseOf(baseURL)
  if (base === '') return ''
  try {
    return new URL(base).origin
  } catch {
    return ''
  }
}

/**
 * Provider root: the origin plus any reverse-proxy path, with one trailing
 * `/v1` removed. `https://api.deepseek.com/v1` and `https://api.deepseek.com`
 * both resolve to `https://api.deepseek.com`.
 */
export function rootOf(baseURL) {
  const base = baseOf(baseURL)
  if (base === '') return ''
  let url
  try {
    url = new URL(base)
  } catch {
    return base
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '')
  return url.origin + path
}

/** Hostname of a base URL, lower-cased, or ''. */
export function hostOf(baseURL) {
  const base = baseOf(baseURL)
  if (base === '') return ''
  try {
    return new URL(base).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function bearer(apiKey) {
  return { authorization: `Bearer ${apiKey}` }
}

function balanceEntry(currency, total, granted, toppedUp) {
  return {
    currency: typeof currency === 'string' && currency !== '' ? currency : DEFAULT_CURRENCY,
    total: amountText(total),
    granted: amountText(granted, '0.00'),
    toppedUp: amountText(toppedUp ?? total),
  }
}

function usageEntry(label, percent, resetAt) {
  const clamped = percentOf(percent)
  if (clamped === null) return null
  return { label, percent: Math.round(clamped * 100) / 100, resetAt: epochMsOf(resetAt) }
}

function spendEntry(label, amount, currency, asOf) {
  return {
    label,
    amount: typeof amount === 'string' ? amount : amountText(amount),
    currency: typeof currency === 'string' && currency !== '' ? currency : DEFAULT_CURRENCY,
    source: 'provider',
    asOf,
  }
}

function compact(list) {
  return list.filter((entry) => entry !== null)
}

function rowResult(status, patch) {
  return {
    status,
    message: null,
    balances: null,
    usages: null,
    spend: null,
    ...(patch ?? {}),
  }
}

// ---------------------------------------------------------------------------
// Networking: one bounded JSON helper with a short retry budget
// ---------------------------------------------------------------------------

/** Abort/network failure that must not be retried. */
function abortedError() {
  const error = new Error('request aborted')
  error.name = 'AbortError'
  error.aborted = true
  return error
}

function sleep(ms) {
  // Deliberately ref'd: a retry delay is in-flight request work, not a
  // background timer, so the event loop must stay alive until it resolves.
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Whether a failure is worth retrying: transport/network/deadline failures,
 * 408/425/429 and 5xx are; 401/403 and other 4xx are not.
 *
 * Exported because `lib/providers.js` publishes the same verdict as the
 * per-row `retryable` field, and the two must never disagree.
 */
export function isRetryableError(error) {
  if (!error || error.aborted === true) return false
  if (error.timedOut === true) return true
  if (error.transient === true) return true
  const status = Number(error.status)
  if (Number.isInteger(status)) {
    if (status === 401 || status === 403) return false
    return RETRYABLE_STATUSES.has(status) || status >= 500
  }
  return false
}

const isRetryable = isRetryableError

function describeNetworkError(error) {
  const cause = error?.cause
  const code = typeof cause?.code === 'string' ? cause.code : ''
  if (code) return `network error (${code})`
  if (error?.name === 'TimeoutError') return 'network timeout'
  const message = typeof error?.message === 'string' ? error.message : ''
  return message === '' ? 'network error' : `network error (${message.slice(0, 120)})`
}

/** Short, single-line detail from an error body; never echoes the request. */
function shortDetail(text) {
  if (typeof text !== 'string') return 'request failed'
  const trimmed = text.trim()
  if (trimmed === '') return 'request failed'
  try {
    const parsed = JSON.parse(trimmed)
    const candidate =
      parsed?.error?.message ??
      parsed?.error?.code ??
      parsed?.message ??
      parsed?.msg ??
      parsed?.ResponseMetadata?.Error?.Code ??
      parsed?.ResponseMetadata?.Error?.Message ??
      (typeof parsed?.error === 'string' ? parsed.error : undefined)
    if (typeof candidate === 'string' && candidate !== '') {
      return candidate.replace(/\s+/g, ' ').slice(0, 160)
    }
  } catch {
    // not JSON; fall through to the raw body
  }
  return trimmed.replace(/\s+/g, ' ').slice(0, 160)
}

/** Parse a response body once; `{parsed: undefined}` means it was not JSON. */
function parseBody(text) {
  if (typeof text !== 'string' || text.trim() === '') return { parsed: null, json: false }
  try {
    return { parsed: JSON.parse(text), json: true }
  } catch {
    return { parsed: undefined, json: false }
  }
}

async function requestOnce(fetchImpl, url, { headers, signal, method, body, timeoutMs }) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  let response
  try {
    response = await fetchImpl(url, {
      method,
      headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
      signal: combinedSignal,
      redirect: 'follow',
      ...(body === undefined ? {} : { body }),
    })
  } catch (error) {
    if (signal?.aborted) throw abortedError()
    const wrapped = new Error(describeNetworkError(error))
    wrapped.transient = true
    wrapped.cause = error
    throw wrapped
  }
  let text = ''
  try {
    text = await response.text()
  } catch {
    text = ''
  }
  const { parsed, json } = parseBody(text)
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${shortDetail(text)}`)
    error.status = response.status
    // Parsed body, so callers can branch on a provider error code without
    // re-reading the response. Additive: retry policy never looks at it.
    error.payload = parsed
    throw error
  }
  if (text.trim() === '') return null
  if (!json) {
    const error = new Error(`HTTP ${response.status}: malformed JSON`)
    error.status = response.status
    throw error
  }
  return parsed
}

/**
 * `GET`/`POST` a URL and parse JSON.
 *
 * 20s timeout per attempt via `AbortSignal.timeout`, up to two retries on
 * 408/425/429/5xx and transient network failures with a 2s then 4s delay.
 * Non-2xx throws `HTTP <status>: <short detail>`; the error carries `.status`
 * and `.payload` (the parsed error body, when it was JSON).
 */
export async function fetchJson(url, options = {}) {
  const {
    headers = {},
    signal,
    method = 'GET',
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = RETRY_DELAYS_MS.length,
    fetchImpl = globalThis.fetch,
  } = options
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable in this host')
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw abortedError()
    try {
      return await requestOnce(fetchImpl, url, { headers, signal, method, body, timeoutMs })
    } catch (error) {
      lastError = error
      if (!isRetryable(error) || attempt === retries) break
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
      await sleep(delay)
    }
  }
  throw lastError ?? new Error('request failed')
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/** Shared for ratios shaped `{used_ratio, reset_time}` (Kimi). */
function ratioUsage(label, node) {
  if (!node || typeof node !== 'object') return null
  const ratio = toNumber(node.used_ratio ?? node.usedRatio ?? node.ratio)
  if (ratio === null) return null
  return usageEntry(label, ratio * 100, node.reset_time ?? node.resetTime ?? node.resetsAt ?? node.resets_at)
}

function compactMessage(error) {
  const raw = typeof error?.message === 'string' ? error.message : 'request failed'
  const text = raw.replace(/\s+/g, ' ').trim()
  return text === '' ? 'request failed' : text.slice(0, 160)
}

// -- GitHub Copilot ---------------------------------------------------------

const COPILOT_URL = 'https://api.github.com/copilot_internal/user'
const COPILOT_HEADERS = {
  'editor-version': 'vscode/1.96.2',
  'editor-plugin-version': 'copilot-chat/0.26.7',
  'user-agent': 'GitHubCopilotChat/0.26.7',
  'x-github-api-version': '2025-04-01',
}
const COPILOT_LABELS = {
  chat: 'chat',
  completions: 'completions',
  premium_interactions: 'premium requests',
  premium_requests: 'premium requests',
}

/**
 * Copilot reports percentages on paid plans (`quota_snapshots`) and used /
 * remaining counts on the free plan (`limited_user_quotas` + `monthly_quotas`).
 */
function copilotUsages(body) {
  const usages = []
  const seen = new Set()
  const push = (label, percent, resetAt) => {
    if (seen.has(label)) return
    const entry = usageEntry(label, percent, resetAt)
    if (!entry) return
    seen.add(label)
    usages.push(entry)
  }
  const resetAt = body?.quota_reset_date ?? body?.limited_user_reset_date
  const snapshots = body?.quota_snapshots
  if (snapshots && typeof snapshots === 'object') {
    for (const [key, snapshot] of Object.entries(snapshots)) {
      if (!snapshot || typeof snapshot !== 'object') continue
      const remaining = toNumber(snapshot.percent_remaining)
      if (remaining === null) continue
      push(
        COPILOT_LABELS[key] ?? String(snapshot.quota_id ?? key),
        100 - remaining,
        snapshot.quota_reset_date ?? resetAt,
      )
    }
  }
  const limited = body?.limited_user_quotas
  const monthly = body?.monthly_quotas
  if (limited && typeof limited === 'object') {
    for (const key of Object.keys(limited)) {
      const allowance = toNumber(monthly?.[key])
      const left = toNumber(limited[key])
      if (allowance === null || allowance <= 0 || left === null) continue
      push(COPILOT_LABELS[key] ?? key, ((allowance - left) / allowance) * 100, resetAt)
    }
  }
  return usages
}

// -- OpenAI Codex (OAuth grant record) --------------------------------------

const CODEX_GRANT_KEY = 'llm-pi-ai/openai-codex'
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODEX_REFRESH_SKEW_MS = 30_000
const CODEX_REAUTH_CODES = new Set(['invalid_grant', 'invalid_token', 'refresh_token_reused'])

function reauthFailure(message) {
  const error = new Error(message)
  error.reauth = true
  return error
}

/**
 * The harness stores a pi-ai grant as `{kind: 'grant', payload: <credential>}`,
 * where the payload is the `{type: 'oauth', access, refresh, expires, accountId}`
 * object (expires in epoch milliseconds). Accept a flat record too, and always
 * write back through the same envelope so the host's own login keeps working.
 */
function codexPayloadOf(record) {
  if (!record || typeof record !== 'object') return null
  if (record.payload && typeof record.payload === 'object') return record.payload
  return record
}

function codexRecordFrom(previous, payload) {
  if (previous && typeof previous === 'object' && previous.payload && typeof previous.payload === 'object') {
    return { ...previous, kind: previous.kind ?? 'grant', payload: { ...payload } }
  }
  return { ...payload }
}

/** `accountId` lives in the access token's `https://api.openai.com/auth` claim. */
function codexAccountIdFromToken(access) {
  if (typeof access !== 'string') return null
  const parts = access.split('.')
  if (parts.length !== 3) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const accountId = claims?.['https://api.openai.com/auth']?.chatgpt_account_id
    return typeof accountId === 'string' && accountId !== '' ? accountId : null
  } catch {
    return null
  }
}

function codexExpiry(record) {
  const raw = record?.expires ?? record?.expires_at ?? record?.expiry
  if (raw === undefined || raw === null || raw === '') return null
  const value = epochMsOf(raw)
  return value > 0 ? value : null
}

function codexNeedsRefresh(record, now) {
  const expires = codexExpiry(record)
  return expires !== null && expires <= now + CODEX_REFRESH_SKEW_MS
}

function oauthErrorCode(error) {
  const payload = error?.payload
  if (!payload || typeof payload !== 'object') return null
  if (typeof payload.error === 'string') return payload.error
  if (typeof payload.error?.code === 'string') return payload.error.code
  if (typeof payload.code === 'string') return payload.code
  return null
}

/**
 * Refresh one OAuth grant inside `modifyRecord`, so rotation has a single
 * writer for this process; a concurrent writer's fresher grant is kept.
 */
async function refreshCodexGrant(credentials, { force }) {
  return credentials.modifyRecord(CODEX_GRANT_KEY, async (current) => {
    if (!current || typeof current !== 'object') return current
    const payload = codexPayloadOf(current)
    if (!payload) return current
    if (!force && !codexNeedsRefresh(payload, Date.now())) return current
    if (typeof payload.refresh !== 'string' || payload.refresh === '') {
      throw reauthFailure('OpenAI Codex grant has no refresh token')
    }
    let response
    try {
      response = await fetchJson(CODEX_TOKEN_URL, {
        method: 'POST',
        // Matches the host's own token exchange, so a rotated grant stays
        // byte-compatible with what the login flow would have written.
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        // A rotating refresh token must never be replayed, so no auto-retry.
        retries: 0,
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: payload.refresh,
          client_id: CODEX_CLIENT_ID,
        }).toString(),
      })
    } catch (error) {
      const code = oauthErrorCode(error)
      if (code !== null && CODEX_REAUTH_CODES.has(code)) {
        throw reauthFailure(`OpenAI Codex sign-in expired (${code})`)
      }
      throw error
    }
    if (!response || typeof response.access_token !== 'string' || response.access_token === '') {
      throw reauthFailure('OpenAI Codex refresh returned no access token')
    }
    const lifetime = toNumber(response.expires_in)
    if (lifetime === null) throw new Error('OpenAI Codex refresh returned no expiry')
    const nextPayload = {
      ...payload,
      type: 'oauth',
      access: response.access_token,
      refresh:
        typeof response.refresh_token === 'string' && response.refresh_token !== ''
          ? response.refresh_token
          : payload.refresh,
      expires: Date.now() + lifetime * 1000,
      accountId: codexAccountIdFromToken(response.access_token) ?? payload.accountId,
    }
    return codexRecordFrom(current, nextPayload)
  })
}

function codexUsageRows(body) {
  const usages = []
  const seen = new Set()
  const push = (label, node) => {
    if (!node || typeof node !== 'object' || seen.has(label)) return
    const used = toNumber(node.used_percent ?? node.usedPercent)
    if (used === null) return
    const entry = usageEntry(
      label,
      used,
      node.reset_at ?? node.resets_at ?? node.reset_at_ms ?? node.resetAt,
    )
    if (!entry) return
    seen.add(label)
    usages.push(entry)
  }
  const rateLimit = body?.rate_limit
  push('5h limit', rateLimit?.primary_window)
  push('weekly', rateLimit?.secondary_window)
  const extras = Array.isArray(body?.additional_rate_limits) ? body.additional_rate_limits : []
  for (const extra of extras) {
    if (!extra || typeof extra !== 'object') continue
    const label = String(extra.name ?? extra.limit_name ?? extra.label ?? extra.id ?? 'rate limit')
    push(label, extra.rate_limit && typeof extra.rate_limit === 'object' ? extra.rate_limit : extra)
  }
  const spendControl = body?.spend_control
  const individual =
    spendControl?.individual_limit && typeof spendControl.individual_limit === 'object'
      ? spendControl.individual_limit
      : spendControl && typeof spendControl === 'object' && 'limit' in spendControl
        ? spendControl
        : null
  if (individual) {
    const limit = toNumber(individual.limit ?? individual.limit_amount ?? individual.amount)
    const used = toNumber(individual.used ?? individual.used_amount ?? individual.amount_used)
    if (limit !== null && limit > 0 && used !== null) {
      push('spend limit', { used_percent: (used / limit) * 100, reset_at: individual.reset_at })
    }
  }
  return usages
}

function codexBalances(body) {
  const credits = body?.credits
  if (!credits || typeof credits !== 'object') return null
  const balance = toNumber(credits.balance ?? credits.remaining ?? credits.available)
  if (balance === null) return null
  const currency = typeof credits.currency === 'string' && credits.currency !== '' ? credits.currency : 'USD'
  return [balanceEntry(currency, balance, credits.granted ?? 0)]
}

function codexSpend(body, now) {
  const used = toNumber(body?.credits?.used)
  if (used === null) return null
  return spendEntry('credits used', String(used), 'USD', now)
}

async function queryCodex({ ctx, route, now, fetchJson: request }) {
  const credentials = service(ctx, 'credentials')
  if (!credentials || typeof credentials.readRecord !== 'function') {
    return rowResult('unsupported', { message: 'credential store is unavailable in this host' })
  }
  let record = null
  try {
    record = await credentials.readRecord(CODEX_GRANT_KEY)
  } catch {
    record = null
  }
  let grant = codexPayloadOf(record)
  if (!grant || typeof grant.access !== 'string' || grant.access === '') {
    return rowResult('missing-credential', { message: `missing credential ${CODEX_GRANT_KEY}` })
  }
  if (grant.type !== undefined && grant.type !== 'oauth') {
    return rowResult('reauth-required', { message: 'OpenAI Codex grant is not an OAuth record; sign in again' })
  }
  // Older grants may pre-date a stored accountId; the access token still carries it.
  if (typeof grant.accountId !== 'string' || grant.accountId === '') {
    const derived = codexAccountIdFromToken(grant.access)
    if (derived !== null) grant = { ...grant, accountId: derived }
  }
  const canRefresh = typeof credentials.modifyRecord === 'function'
  try {
    if (codexNeedsRefresh(grant, now)) {
      if (!canRefresh) {
        return rowResult('reauth-required', { message: 'OpenAI Codex sign-in expired; sign in again' })
      }
      grant = codexPayloadOf(await refreshCodexGrant(credentials, { force: false })) ?? grant
    }
  } catch (error) {
    if (error?.reauth === true) return rowResult('reauth-required', { message: compactMessage(error) })
    throw error
  }
  const readUsage = (current) => {
    const headers = { authorization: `Bearer ${current.access}`, originator: 'pi' }
    if (typeof current.accountId === 'string' && current.accountId !== '') {
      headers['chatgpt-account-id'] = current.accountId
    }
    return request(`${baseOf(route.baseURL)}/wham/usage`, { headers })
  }
  let body
  try {
    body = await readUsage(grant)
  } catch (error) {
    if (error?.status !== 401) throw error
    if (!canRefresh) {
      return rowResult('reauth-required', { message: 'OpenAI Codex rejected the grant; sign in again' })
    }
    try {
      const refreshed = codexPayloadOf(await refreshCodexGrant(credentials, { force: true }))
      if (!refreshed || typeof refreshed.access !== 'string' || refreshed.access === '') {
        return rowResult('reauth-required', { message: 'OpenAI Codex rejected the grant; sign in again' })
      }
      body = await readUsage(refreshed)
    } catch (retryError) {
      if (retryError?.reauth === true || retryError?.status === 401) {
        return rowResult('reauth-required', { message: 'OpenAI Codex rejected the grant; sign in again' })
      }
      throw retryError
    }
  }
  const usages = codexUsageRows(body)
  const balances = codexBalances(body)
  const spend = codexSpend(body, now)
  return rowResult('ok', {
    usages,
    ...(balances ? { balances } : {}),
    ...(spend ? { spend } : {}),
  })
}

// -- Volcengine Ark (IAM AK/SK, V4 HMAC-SHA256) -----------------------------

const VOLC_HOST = 'open.volcengineapi.com'
const VOLC_REGION = 'cn-beijing'
const VOLC_SERVICE = 'ark'
const VOLC_API_VERSION = '2024-01-01'
const VOLC_AK_REFS = ['VOLC_ARK_ACCESS_KEY_ID', 'VOLC_ACCESS_KEY_ID', 'VOLC_ACCESSKEY']
const VOLC_SK_REFS = ['VOLC_ARK_ACCESS_KEY_SECRET', 'VOLC_ACCESS_KEY_SECRET', 'VOLC_SECRETKEY', 'VOLC_SECRET_KEY']

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function hmacSha256(key, text) {
  return createHmac('sha256', key).update(text, 'utf8').digest()
}

function hmacSha256Hex(key, text) {
  return createHmac('sha256', key).update(text, 'utf8').digest('hex')
}

/** RFC 3986 percent-encoding, as both AWS and Volcengine canonical forms require. */
function volcEncode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function volcCanonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${volcEncode(key)}=${volcEncode(params[key])}`)
    .join('&')
}

/** `yyyyMMdd'T'HHmmss'Z'` in UTC (ISO-8601 basic form). */
function volcTimestamp(now) {
  return new Date(now)
    .toISOString()
    .replace(/[:-]/g, '')
    .replace(/\.\d{3}/, '')
}

/**
 * Volcengine V4 HMAC-SHA256 signature.
 *
 * Signed headers are exactly `host;x-content-sha256;x-date` with credential
 * scope `<yyyyMMdd>/<region>/<service>/request`. Deterministic for a fixed
 * clock and body, which makes the signature unit-testable.
 */
export function signVolcengineRequest({
  method,
  host,
  path,
  params,
  body,
  accessKeyId,
  secretAccessKey,
  now,
  region = VOLC_REGION,
  service = VOLC_SERVICE,
}) {
  const timestamp = volcTimestamp(now)
  const dateStamp = timestamp.slice(0, 8)
  const payloadHash = sha256Hex(body)
  const canonicalHeaders = `host:${host}\nx-content-sha256:${payloadHash}\nx-date:${timestamp}\n`
  const signedHeaders = 'host;x-content-sha256;x-date'
  const canonicalRequest = [
    method,
    path,
    volcCanonicalQuery(params),
    `${canonicalHeaders}\n${signedHeaders}`,
    payloadHash,
  ].join('\n')
  const scope = `${dateStamp}/${region}/${service}/request`
  const stringToSign = ['HMAC-SHA256', timestamp, scope, sha256Hex(canonicalRequest)].join('\n')
  const dateKey = hmacSha256(secretAccessKey, dateStamp)
  const regionKey = hmacSha256(dateKey, region)
  const serviceKey = hmacSha256(regionKey, service)
  const signingKey = hmacSha256(serviceKey, 'request')
  const signature = hmacSha256Hex(signingKey, stringToSign)
  return {
    timestamp,
    payloadHash,
    scope,
    signature,
    headers: {
      'content-type': 'application/json',
      'x-date': timestamp,
      'x-content-sha256': payloadHash,
      authorization: `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  }
}

async function resolveFirstRef(resolveCredential, refs) {
  if (typeof resolveCredential !== 'function') return null
  for (const ref of refs) {
    const hit = await resolveCredential(ref)
    if (hit?.ok === true && typeof hit.value === 'string' && hit.value !== '') return hit.value
  }
  return null
}

function volcErrorCode(error) {
  const code = error?.payload?.ResponseMetadata?.Error?.Code
  return typeof code === 'string' ? code : null
}

/** Volcengine can answer with a 2xx envelope carrying `ResponseMetadata.Error`. */
function volcBodyFailure(body) {
  const failure = body?.ResponseMetadata?.Error
  if (!failure || typeof failure !== 'object') return null
  if (typeof failure.Code !== 'string' && typeof failure.Message !== 'string') return null
  // Only the provider's error code: its message text is free-form and may echo
  // account or request details that must not reach a response or a log.
  const error = new Error(`volcengine ${failure.Code ?? 'error'}`)
  error.payload = body
  return error
}

async function callArk(action, { accessKeyId, secretAccessKey, now, request }) {
  const params = { Action: action, Version: VOLC_API_VERSION }
  const path = '/'
  const body = '{}'
  const url = `https://${VOLC_HOST}/?${volcCanonicalQuery(params)}`
  const signed = signVolcengineRequest({
    method: 'POST',
    host: VOLC_HOST,
    path,
    params,
    body,
    accessKeyId,
    secretAccessKey,
    now,
  })
  const response = await request(url, { method: 'POST', headers: signed.headers, body })
  const failure = volcBodyFailure(response)
  if (failure) throw failure
  return response?.Result ?? response?.result ?? response ?? {}
}

function arkAgentUsages(result) {
  const afp = result?.AFP ?? result?.afp ?? result ?? {}
  const usages = []
  const push = (label, node) => {
    if (!node || typeof node !== 'object') return
    const quota = toNumber(node.Quota ?? node.quota)
    const used = toNumber(node.Used ?? node.used)
    if (quota === null || quota <= 0 || used === null) return
    usages.push(usageEntry(label, (used / quota) * 100, node.ResetTime ?? node.resetTime))
  }
  push('5h limit', afp?.FiveHour ?? afp?.fiveHour ?? afp?.five_hour)
  push('weekly', afp?.Weekly ?? afp?.weekly)
  push('monthly', afp?.Monthly ?? afp?.monthly)
  return compact(usages)
}

function arkCodingLabel(level) {
  const text = String(level ?? '').toLowerCase()
  if (text === '') return 'limit'
  if (text.includes('session') || text.includes('5h') || text.includes('hour')) return '5h limit'
  if (text.includes('month')) return 'monthly'
  if (text.includes('week')) return 'weekly'
  return String(level)
}

function arkCodingUsages(result) {
  const list = Array.isArray(result?.QuotaUsage)
    ? result.QuotaUsage
    : Array.isArray(result?.quotaUsage)
      ? result.quotaUsage
      : []
  const usages = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const percent = toNumber(entry.Percent ?? entry.percent)
    if (percent === null) continue
    usages.push(
      usageEntry(arkCodingLabel(entry.Level ?? entry.level), percent, entry.ResetTimestamp ?? entry.resetTimestamp),
    )
  }
  return compact(usages)
}

async function queryArk(kind, { now, fetchJson: request, resolveCredential }) {
  const accessKeyId = await resolveFirstRef(resolveCredential, VOLC_AK_REFS)
  if (accessKeyId === null) {
    return rowResult('missing-credential', { message: `missing credential ${VOLC_AK_REFS[0]}` })
  }
  const secretAccessKey = await resolveFirstRef(resolveCredential, VOLC_SK_REFS)
  if (secretAccessKey === null) {
    return rowResult('missing-credential', { message: `missing credential ${VOLC_SK_REFS[0]}` })
  }
  const call = { accessKeyId, secretAccessKey, now, request }
  const agent = kind === 'volcengine-ark-agent'
  let result
  if (agent) {
    try {
      result = await callArk('GetAFPUsage', call)
    } catch (error) {
      // Some accounts only answer to the newer action alias.
      if (volcErrorCode(error) !== 'InvalidActionOrVersion') throw error
      result = await callArk('GetAgentPlanAFPUsage', call)
    }
  } else {
    result = await callArk('GetCodingPlanUsage', call)
  }
  return rowResult('ok', { usages: agent ? arkAgentUsages(result) : arkCodingUsages(result) })
}

/**
 * Adapter table. `requiresCredential: false` skips API-key resolution (the
 * adapter resolves its own grant or key pair); `adminKey: true` turns 401/403
 * into `missing-authorization`.
 */
export const ADAPTERS = {
  deepseek: {
    label: 'DeepSeek',
    async query({ route, apiKey, fetchJson: request }) {
      const url = `${rootOf(route.baseURL)}/user/balance`
      const body = await request(url, { headers: bearer(apiKey) })
      const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
      const balances = infos.map((info) =>
        balanceEntry(info?.currency, info?.total_balance, info?.granted_balance, info?.topped_up_balance),
      )
      return rowResult('ok', { balances })
    },
  },

  'deepseek-account': {
    label: 'DeepSeek Account',
    requiresCredential: false,
    requiresBaseURL: false,
    async query({ ctx, now }) {
      const account = service(ctx, 'deepseekAccount')
      if (!account || typeof account.getState !== 'function') {
        return rowResult('unsupported', { message: 'DeepSeek account service is unavailable in this host' })
      }
      const state = await account.getState()
      if (!state || state.status === 'signed-out') {
        return rowResult('missing-credential', { message: 'DeepSeek account is not signed in' })
      }
      if (typeof account.getBalance !== 'function') {
        return rowResult('unsupported', { message: 'DeepSeek account balance is unavailable in this host' })
      }
      const wallet = await account.getBalance({
        version: '0.1.0',
        locale: 'zh-CN',
        timezoneOffsetSeconds: -new Date(now).getTimezoneOffset() * 60,
      })
      if (!wallet) {
        return rowResult('reauth-required', { message: 'DeepSeek account is not signed in' })
      }
      if (wallet.status !== 'ready') {
        return rowResult('error', { message: 'DeepSeek account balance request failed' })
      }
      const rechargeWallet = Array.isArray(wallet.value) ? wallet.value : []
      const bonusWallets = Array.isArray(wallet.bonusWallets) ? wallet.bonusWallets : []
      const byCurrency = new Map()
      const accumulate = (entry, field) => {
        if (!entry || typeof entry !== 'object') return
        const currency = typeof entry.currency === 'string' && entry.currency !== '' ? entry.currency : 'CNY'
        const current = byCurrency.get(currency) ?? { currency, recharge: 0, bonus: 0 }
        current[field] += toNumber(entry.balance) ?? 0
        byCurrency.set(currency, current)
      }
      for (const entry of rechargeWallet) accumulate(entry, 'recharge')
      for (const entry of bonusWallets) accumulate(entry, 'bonus')
      const balances = [...byCurrency.values()].map((entry) =>
        balanceEntry(entry.currency, entry.recharge + entry.bonus, entry.bonus, entry.recharge),
      )
      return rowResult('ok', { balances })
    },
  },

  moonshot: {
    label: 'Moonshot',
    async query({ route, apiKey, fetchJson: request }) {
      const url = `${baseOf(route.baseURL)}/users/me/balance`
      const body = await request(url, { headers: bearer(apiKey) })
      const data = body?.data && typeof body.data === 'object' ? body.data : body
      if (!data || typeof data !== 'object') return rowResult('ok', { balances: [] })
      const balances = [
        balanceEntry(data.currency, data.available_balance, data.voucher_balance, data.cash_balance),
      ]
      return rowResult('ok', { balances })
    },
  },

  openrouter: {
    label: 'OpenRouter',
    async query({ route, apiKey, fetchJson: request, now }) {
      const url = `${originOf(route.baseURL)}/api/v1/credits`
      const body = await request(url, { headers: bearer(apiKey) })
      const data = body?.data && typeof body.data === 'object' ? body.data : body
      const totalCredits = toNumber(data?.total_credits)
      const totalUsage = toNumber(data?.total_usage)
      const remaining = totalCredits !== null && totalUsage !== null ? totalCredits - totalUsage : totalCredits
      const balances = [balanceEntry('USD', remaining, 0, totalCredits)]
      const spend = spendEntry('credits used', String(data?.total_usage ?? 0), 'USD', now)
      return rowResult('ok', { balances, spend })
    },
  },

  xai: {
    label: 'xAI',
    async query({ route, apiKey, fetchJson: request }) {
      const base = baseOf(route.baseURL)
      const prepaid = hostOf(base).startsWith('management-api.x.ai')
      const url = prepaid ? `${base}/prepaid/balance` : `${base}/billing/credits`
      const body = await request(url, { headers: bearer(apiKey) })
      const cents = toNumber(body?.total?.val ?? body?.val ?? body?.balance)
      if (cents === null) return rowResult('ok', { balances: [] })
      return rowResult('ok', { balances: [balanceEntry('USD', Math.abs(cents) / 100, 0)] })
    },
  },

  'vercel-ai-gateway': {
    label: 'Vercel AI Gateway',
    async query({ route, apiKey, fetchJson: request }) {
      const url = `${baseOf(route.baseURL)}/v1/credits`
      const body = await request(url, { headers: bearer(apiKey) })
      const value = body?.balance ?? body?.data?.balance
      return rowResult('ok', { balances: [balanceEntry('USD', value, 0)] })
    },
  },

  zai: {
    label: 'Z.ai',
    async query({ route, apiKey, fetchJson: request }) {
      const url = `${originOf(route.baseURL)}/api/monitor/usage/quota/limit`
      const body = await request(url, {
        headers: {
          authorization: apiKey,
          'content-type': 'application/json',
          'accept-language': 'en-US,en',
        },
      })
      const limits = Array.isArray(body?.data?.limits) ? body.data.limits : []
      const tokenLimits = limits
        .filter((limit) => limit && limit.type === 'TOKENS_LIMIT')
        .sort((a, b) => (epochMsOf(a?.nextResetTime) || Infinity) - (epochMsOf(b?.nextResetTime) || Infinity))
      const usages = compact(
        tokenLimits.map((limit, index) =>
          usageEntry(
            index === 0 ? '5h limit' : index === 1 ? 'weekly' : `limit ${index + 1}`,
            limit?.percentage,
            limit?.nextResetTime,
          ),
        ),
      )
      return rowResult('ok', { usages })
    },
  },

  minimax: {
    label: 'MiniMax',
    async query({ route, apiKey, fetchJson: request }) {
      const url = `${originOf(route.baseURL)}/v1/api/openplatform/coding_plan/remains`
      const body = await request(url, { headers: bearer(apiKey) })
      const remains = Array.isArray(body?.model_remains) ? body.model_remains : []
      const general = remains.find((entry) => entry?.model_name === 'general') ?? remains[0]
      const usages = []
      const intervalRemaining = toNumber(general?.current_interval_remaining_percent)
      if (intervalRemaining !== null) {
        usages.push(usageEntry('5h limit', 100 - intervalRemaining, general?.end_time))
      }
      const weeklyRemaining = toNumber(general?.current_weekly_remaining_percent)
      if (weeklyRemaining !== null) {
        usages.push(usageEntry('weekly', 100 - weeklyRemaining, general?.weekly_end_time))
      }
      return rowResult('ok', { usages: compact(usages) })
    },
  },

  'kimi-coding': {
    label: 'Kimi Coding',
    async query({ route, apiKey, fetchJson: request }) {
      const base = baseOf(route.baseURL)
      const url = /\/v1$/i.test(base) ? `${base}/usages` : `${base}/v1/usages`
      const body = await request(url, {
        headers: { ...bearer(apiKey), 'user-agent': 'KimiCLI/1.6' },
      })
      const usages = []
      const summary = body?.usages ?? body?.data?.usages
      if (summary && typeof summary === 'object') {
        usages.push(ratioUsage('5h limit', summary.limit_5h))
        usages.push(ratioUsage('weekly', summary.limit_7d))
        usages.push(ratioUsage('monthly', summary.limit_month_total))
        usages.push(ratioUsage('monthly code', summary.limit_month_code))
      } else if (Array.isArray(body?.limits)) {
        for (const entry of body.limits) {
          usages.push(
            ratioUsage(
              String(entry?.label ?? entry?.name ?? entry?.window ?? entry?.period ?? 'limit'),
              entry,
            ),
          )
        }
      } else if (Array.isArray(body?.data)) {
        for (const entry of body.data) {
          usages.push(
            ratioUsage(
              String(entry?.label ?? entry?.name ?? entry?.window ?? entry?.period ?? 'limit'),
              entry,
            ),
          )
        }
      }
      return rowResult('ok', { usages: compact(usages) })
    },
  },

  opencode: {
    label: 'OpenCode',
    async query({ route, apiKey, fetchJson: request }) {
      const url = `${baseOf(route.baseURL)}/v1/usage`
      const body = await request(url, { headers: bearer(apiKey) })
      const usage = body?.usage ?? body?.data ?? body
      const usages = []
      for (const window of ['rolling', 'weekly', 'monthly']) {
        const node = usage?.[window]
        if (!node || typeof node !== 'object') continue
        usages.push(
          usageEntry(
            window,
            node.percent ?? node.used_percent ?? node.percentage,
            node.resetsAt ?? node.resets_at,
          ),
        )
      }
      return rowResult('ok', { usages: compact(usages) })
    },
  },

  openai: {
    label: 'OpenAI',
    adminKey: true,
    async query({ route, apiKey, fetchJson: request, now }) {
      const origin = originOf(route.baseURL)
      const startTime = Math.floor(startOfUtcMonth(now) / 1000)
      const url = `${origin}/v1/organization/costs?start_time=${startTime}`
      const body = await request(url, { headers: bearer(apiKey) })
      let total = 0
      let currency = DEFAULT_CURRENCY
      const buckets = Array.isArray(body?.data) ? body.data : []
      for (const bucket of buckets) {
        const results = Array.isArray(bucket?.results) ? bucket.results : []
        for (const result of results) {
          const value = toNumber(result?.amount?.value)
          if (value !== null) total += value
          const reported = result?.amount?.currency
          if (typeof reported === 'string' && reported !== '') currency = reported
        }
      }
      return rowResult('ok', { spend: spendEntry('this month', amountText(total), currency, now) })
    },
  },

  anthropic: {
    label: 'Anthropic',
    adminKey: true,
    async query({ route, apiKey, fetchJson: request, now }) {
      const url = `${baseOf(route.baseURL)}/v1/organizations/cost_report?starting_at=${encodeURIComponent(
        isoUtcMonthStart(now),
      )}`
      const body = await request(url, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      })
      let total = 0
      let currency = DEFAULT_CURRENCY
      const buckets = Array.isArray(body?.data) ? body.data : []
      for (const bucket of buckets) {
        const results = Array.isArray(bucket?.results) ? bucket.results : []
        for (const result of results) {
          const value = toNumber(result?.amount)
          if (value !== null) total += value
          const reported = result?.currency ?? bucket?.currency
          if (typeof reported === 'string' && reported !== '') currency = reported
        }
      }
      return rowResult('ok', { spend: spendEntry('this month', amountText(total), currency, now) })
    },
  },

  'github-copilot': {
    label: 'GitHub Copilot',
    async query({ apiKey, fetchJson: request }) {
      let body
      try {
        body = await request(COPILOT_URL, {
          headers: { ...COPILOT_HEADERS, authorization: `token ${apiKey}` },
        })
      } catch (error) {
        if (error?.status === 401) {
          return rowResult('reauth-required', { message: 'GitHub Copilot token was rejected; sign in again' })
        }
        if (error?.status === 403) {
          return rowResult('no-subscription', {
            message: 'GitHub Copilot subscription is not active for this token',
          })
        }
        throw error
      }
      return rowResult('ok', { usages: copilotUsages(body) })
    },
  },

  'openai-codex': {
    label: 'OpenAI Codex',
    requiresCredential: false,
    async query(args) {
      return queryCodex(args)
    },
  },

  'volcengine-ark-agent': {
    label: 'Volcengine Ark (Agent Plan)',
    requiresCredential: false,
    async query(args) {
      return queryArk('volcengine-ark-agent', args)
    },
  },

  'volcengine-ark-coding': {
    label: 'Volcengine Ark (Coding Plan)',
    requiresCredential: false,
    async query(args) {
      return queryArk('volcengine-ark-coding', args)
    },
  },
}

/** Resolve the adapter for one kind, or null when the kind has no balance API. */
export function adapterFor(kind) {
  if (typeof kind !== 'string' || kind === '') return null
  return Object.prototype.hasOwnProperty.call(ADAPTERS, kind) ? ADAPTERS[kind] : null
}

// ---------------------------------------------------------------------------
// Price catalogs
//
// Only providers that genuinely expose a model price endpoint are handled here.
// The engine owns caching and null-on-failure; these helpers are best effort.
// ---------------------------------------------------------------------------

/** Official hosts that never serve a New API `/api/pricing` relay catalog. */
const OFFICIAL_HOSTS = new Set([
  'api.deepseek.com',
  'api.kimi.com',
  'api.moonshot.ai',
  'api.moonshot.cn',
  'openrouter.ai',
  'api.x.ai',
  'management-api.x.ai',
  'ai-gateway.vercel.sh',
  'api.z.ai',
  'open.bigmodel.cn',
  'api.minimax.io',
  'api.minimaxi.com',
  'api.openai.com',
  'api.anthropic.com',
  'api.individual.githubcopilot.com',
  'chatgpt.com',
  'opencode.ai',
  'ark.cn-beijing.volces.com',
])

/** True when a configured endpoint is plausibly a self-hosted New API relay. */
export function isNewApiRelayCandidate(baseURL) {
  const host = hostOf(baseURL)
  if (host === '') return false
  return !OFFICIAL_HOSTS.has(host)
}

/** OpenRouter's public model catalog -> per-million-token USD table. */
export async function fetchOpenRouterCatalog({ route, fetchJson: request, now }) {
  const url = `${originOf(route.baseURL)}/api/v1/models`
  const body = await request(url, {})
  const models = Array.isArray(body?.data) ? body.data : []
  const rows = []
  for (const model of models) {
    const id = typeof model?.id === 'string' ? model.id : ''
    if (id === '') continue
    const pricing = model?.pricing
    if (!pricing || typeof pricing !== 'object') continue
    const prompt = toNumber(pricing.prompt)
    const completion = toNumber(pricing.completion)
    if (prompt === null || completion === null) continue
    const cacheRead = toNumber(pricing.input_cache_read) ?? 0
    rows.push({
      match: id,
      cacheHit: cacheRead * 1e6,
      cacheMiss: prompt * 1e6,
      cacheWrite: 0,
      output: completion * 1e6,
    })
  }
  if (rows.length === 0) return null
  return {
    source: 'provider-catalog',
    url,
    fetchedAt: now,
    currency: 'USD',
    unit: 'per-million-tokens',
    models: rows,
  }
}

/**
 * Best-effort New API relay catalog.
 *
 * New API expresses prices as a multiple of `$0.002 / 1K tokens`, so one unit
 * of `model_ratio` is `2` USD per million tokens and `completion_ratio`
 * multiplies the output side. The table is only built when those two factors
 * are present and the entry is token-priced (`quota_type` absent or 0).
 */
export async function fetchNewApiCatalog({ route, fetchJson: request, now }) {
  const url = `${originOf(route.baseURL)}/api/pricing`
  const body = await request(url, {})
  const entries = Array.isArray(body?.data) ? body.data : []
  const rows = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const quotaType = toNumber(entry.quota_type)
    if (quotaType !== null && quotaType !== 0) continue
    const modelName = typeof entry.model_name === 'string' ? entry.model_name : ''
    const modelRatio = toNumber(entry.model_ratio)
    const completionRatio = toNumber(entry.completion_ratio)
    if (modelName === '' || modelRatio === null || completionRatio === null) continue
    const cacheRatio = toNumber(entry.cache_ratio ?? entry.cache_ratio_read)
    rows.push({
      match: modelName,
      cacheHit: (cacheRatio === null ? 0 : modelRatio * cacheRatio) * 2,
      cacheMiss: modelRatio * 2,
      cacheWrite: 0,
      output: modelRatio * completionRatio * 2,
    })
  }
  if (rows.length === 0) return null
  return {
    source: 'provider-catalog',
    url,
    fetchedAt: now,
    currency: 'USD',
    unit: 'per-million-tokens',
    models: rows,
  }
}

function service(ctx, name) {
  try {
    return ctx?.get?.(name) ?? null
  } catch {
    return null
  }
}
