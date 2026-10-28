/**
 * Provider adapter contract tests (v0.2).
 *
 * Only exported, pure-ish helpers are exercised; every network call is a stub,
 * so no credential or provider is contacted. If an export disappears the
 * individual tests skip and the surface test flags it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'

const adapters = await import('../lib/adapters.js')
const providers = await import('../lib/providers.js')

const KIND_LIST = [
  'deepseek',
  'deepseek-account',
  'moonshot',
  'openrouter',
  'xai',
  'vercel-ai-gateway',
  'zai',
  'minimax',
  'kimi-coding',
  'opencode',
  'openai',
  'anthropic',
  'github-copilot',
  'openai-codex',
  'volcengine-ark-agent',
  'volcengine-ark-coding',
]

function need(mod, name) {
  const value = mod[name]
  return typeof value === 'function' ? value : null
}

const close = (actual, expected, message) =>
  assert.ok(Math.abs(Number(actual) - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`)

test('adapters: the frozen helper/table surface is complete', () => {
  const expected = [
    'ADAPTER_PENDING_MESSAGE',
    'ADAPTERS',
    'adapterFor',
    'amountText',
    'baseOf',
    'epochMsOf',
    'fetchJson',
    'fetchNewApiCatalog',
    'fetchOpenRouterCatalog',
    'hostOf',
    'isNewApiRelayCandidate',
    'isoUtcMonthStart',
    'originOf',
    'percentOf',
    'rootOf',
    'signVolcengineRequest',
    'startOfUtcMonth',
    'toNumber',
  ]
  const missing = expected.filter((name) => adapters[name] === undefined)
  assert.deepEqual(missing, [], `missing adapter exports: ${missing.join(', ')}`)
  assert.deepEqual(Object.keys(adapters.ADAPTERS).sort(), [...KIND_LIST].sort(), 'exactly 16 adapter kinds')
  assert.equal(typeof providers.classifyKind, 'function', 'classifyKind must stay exported')
  assert.equal(typeof providers.createProvidersEngine, 'function', 'createProvidersEngine must stay exported')
})

test('url helpers: trailing slashes, proxy paths and the single /v1 strip', (t) => {
  const { baseOf, originOf, rootOf, hostOf } = Object.fromEntries(
    ['baseOf', 'originOf', 'rootOf', 'hostOf'].map((name) => [name, need(adapters, name)]),
  )
  if (!baseOf || !originOf || !rootOf || !hostOf) {
    t.skip('url helpers are not exported yet')
    return
  }
  assert.equal(baseOf('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1')
  assert.equal(baseOf(undefined), '')
  assert.equal(originOf('https://api.deepseek.com/v1'), 'https://api.deepseek.com')
  assert.equal(originOf('not a url'), '')
  assert.equal(rootOf('https://api.deepseek.com/v1'), 'https://api.deepseek.com')
  assert.equal(rootOf('https://relay.example.com/openai/v1'), 'https://relay.example.com/openai')
  assert.equal(rootOf('https://api.deepseek.com/anthropic'), 'https://api.deepseek.com/anthropic')
  assert.equal(hostOf('https://API.DeepSeek.com/v1'), 'api.deepseek.com')
  assert.equal(hostOf(''), '')
})

test('number/money helpers: bounded amounts, clamped percents, epoch coercion', (t) => {
  const { toNumber, amountText, percentOf, epochMsOf, startOfUtcMonth, isoUtcMonthStart } = Object.fromEntries(
    ['toNumber', 'amountText', 'percentOf', 'epochMsOf', 'startOfUtcMonth', 'isoUtcMonthStart'].map((name) => [
      name,
      need(adapters, name),
    ]),
  )
  if (!toNumber || !amountText || !percentOf || !epochMsOf || !startOfUtcMonth || !isoUtcMonthStart) {
    t.skip('pure helpers are not exported yet')
    return
  }
  assert.equal(toNumber('12.5'), 12.5)
  assert.equal(toNumber('  '), null)
  assert.equal(toNumber(true), null)
  assert.equal(toNumber({}), null)
  assert.equal(toNumber('abc'), null)

  assert.equal(amountText(12.34), '12.34')
  assert.equal(amountText(1.5), '1.50')
  assert.equal(amountText(0), '0.00')
  assert.equal(amountText(null), '0.00')
  assert.equal(amountText(null, '—'), '—')
  assert.equal(amountText(0.004), '0.004')

  assert.equal(percentOf(42.5), 42.5)
  assert.equal(percentOf(150), 100)
  assert.equal(percentOf(-5), 0)
  assert.equal(percentOf('nope'), null)

  assert.equal(epochMsOf(1730000000), 1730000000000)
  assert.equal(epochMsOf(1730000000000), 1730000000000)
  assert.equal(epochMsOf('2026-10-28T00:00:00Z'), Date.parse('2026-10-28T00:00:00Z'))
  assert.equal(epochMsOf(''), 0)
  assert.equal(epochMsOf('nope'), 0)

  const now = Date.parse('2026-10-28T10:00:00+08:00')
  assert.equal(startOfUtcMonth(now), Date.UTC(2026, 9, 1))
  assert.equal(isoUtcMonthStart(now), '2026-10-01T00:00:00.000Z')
})

test('classifyKind: route id + URL heuristics + explicit override', (t) => {
  const classifyKind = need(providers, 'classifyKind')
  if (!classifyKind) {
    t.skip('classifyKind is not exported yet')
    return
  }
  assert.equal(classifyKind('deepseek-official', 'https://api.deepseek.com', undefined), 'deepseek')
  assert.equal(classifyKind('whatever', 'https://platform.deepseek.com/api', undefined), 'deepseek-account')
  assert.equal(classifyKind('many', 'https://api.moonshot.cn/v1', undefined), 'moonshot')
  assert.equal(classifyKind('x', 'https://openrouter.ai/api/v1', undefined), 'openrouter')
  assert.equal(classifyKind('x', 'https://api.x.ai/v1', undefined), 'xai')
  assert.equal(classifyKind('x', 'https://ai-gateway.vercel.sh', undefined), 'vercel-ai-gateway')
  assert.equal(classifyKind('x', 'https://open.bigmodel.cn/api/coding/paas/v4', undefined), 'zai')
  assert.equal(classifyKind('x', 'https://api.minimax.io/anthropic', undefined), 'minimax')
  assert.equal(classifyKind('x', 'https://api.kimi.com/coding', undefined), 'kimi-coding')
  assert.equal(classifyKind('x', 'https://opencode.ai/api', undefined), 'opencode')
  assert.equal(classifyKind('x', 'https://api.anthropic.com', undefined), 'anthropic')
  assert.equal(classifyKind('x', 'https://api.openai.com/v1', undefined), 'openai')
  assert.equal(classifyKind('x', 'https://chatgpt.com/backend-api', undefined), 'openai-codex')
  assert.equal(classifyKind('x', 'https://api.individual.githubcopilot.com', undefined), 'github-copilot')
  assert.equal(classifyKind('x', 'https://ark.cn-beijing.volces.com/api/v3', undefined), 'volcengine-ark-agent')
  assert.equal(classifyKind('deepseek-official', 'https://api.deepseek.com', 'custom-kind'), 'custom-kind')
  assert.equal(classifyKind('nope', 'https://example.com', undefined), 'unknown')
})

// ------------------------------------------------------------- balance maps

test('deepseek: /user/balance maps balance_infos to bounded 2dp strings', async (t) => {
  const adapter = adapters.ADAPTERS?.deepseek
  if (!adapter) {
    t.skip('deepseek adapter is missing')
    return
  }
  const calls = []
  const request = async (url, options) => {
    calls.push({ url, options })
    return {
      balance_infos: [
        { currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' },
        { currency: 'USD', total_balance: '1.5' },
      ],
    }
  }
  const row = await adapter.query({ route: { baseURL: 'https://api.deepseek.com/v1' }, apiKey: 'test-key', fetchJson: request })
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance')
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-key')
  assert.equal(row.status, 'ok')
  assert.deepEqual(row.balances, [
    { currency: 'CNY', total: '12.34', granted: '2.00', toppedUp: '10.34' },
    { currency: 'USD', total: '1.50', granted: '0.00', toppedUp: '1.50' },
  ])
})

test('moonshot / openrouter / xai / vercel: balance + spend field mapping', async (t) => {
  const { ADAPTERS, amountText } = adapters
  if (!ADAPTERS?.moonshot || !ADAPTERS?.openrouter || !ADAPTERS?.xai || !ADAPTERS?.['vercel-ai-gateway']) {
    t.skip('one of the balance adapters is missing')
    return
  }

  const moonshotCalls = []
  const moonshot = await ADAPTERS.moonshot.query({
    route: { baseURL: 'https://api.moonshot.cn/v1/' },
    apiKey: 'k',
    fetchJson: async (url) => {
      moonshotCalls.push(url)
      return { data: { currency: 'CNY', available_balance: 8.5, voucher_balance: 1, cash_balance: 7.5 } }
    },
  })
  assert.equal(moonshotCalls[0], 'https://api.moonshot.cn/v1/users/me/balance')
  assert.deepEqual(moonshot.balances, [{ currency: 'CNY', total: '8.50', granted: '1.00', toppedUp: '7.50' }])

  const openrouterCalls = []
  const openrouter = await ADAPTERS.openrouter.query({
    route: { baseURL: 'https://openrouter.ai/api/v1' },
    apiKey: 'k',
    now: Date.parse('2026-10-28T00:00:00Z'),
    fetchJson: async (url) => {
      openrouterCalls.push(url)
      return { data: { total_credits: 20, total_usage: 7.5 } }
    },
  })
  assert.equal(openrouterCalls[0], 'https://openrouter.ai/api/v1/credits')
  assert.deepEqual(openrouter.balances, [{ currency: 'USD', total: '12.50', granted: '0.00', toppedUp: '20.00' }])
  assert.equal(openrouter.spend.label, 'credits used')
  assert.equal(openrouter.spend.amount, '7.5')
  assert.equal(openrouter.spend.currency, 'USD')
  assert.equal(openrouter.spend.source, 'provider')

  const xaiCalls = []
  const xai = await ADAPTERS.xai.query({
    route: { baseURL: 'https://management-api.x.ai' },
    apiKey: 'k',
    fetchJson: async (url) => {
      xaiCalls.push(url)
      return { total: { val: 1234 } }
    },
  })
  assert.equal(xaiCalls[0], 'https://management-api.x.ai/prepaid/balance')
  assert.deepEqual(xai.balances, [{ currency: 'USD', total: '12.34', granted: '0.00', toppedUp: '12.34' }])

  const vercel = await ADAPTERS['vercel-ai-gateway'].query({
    route: { baseURL: 'https://ai-gateway.vercel.sh' },
    apiKey: 'k',
    fetchJson: async () => ({ balance: 3.2 }),
  })
  assert.deepEqual(vercel.balances, [{ currency: 'USD', total: '3.20', granted: '0.00', toppedUp: '3.20' }])
  assert.equal(typeof amountText, 'function')
})

// --------------------------------------------------------------- usage maps

test('zai / minimax / kimi-coding / opencode: quota percentages and reset times', async (t) => {
  const A = adapters.ADAPTERS
  if (!A?.zai || !A?.minimax || !A?.['kimi-coding'] || !A?.opencode) {
    t.skip('one of the quota adapters is missing')
    return
  }
  const reset = 1_730_000_000 // seconds

  const zai = await A.zai.query({
    route: { baseURL: 'https://api.z.ai/api/coding/paas/v4' },
    apiKey: 'k',
    fetchJson: async () => ({
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', percentage: 42.5, nextResetTime: reset },
          { type: 'TOKENS_LIMIT', percentage: 10, nextResetTime: reset + 3600 },
          { type: 'OTHER', percentage: 99, nextResetTime: reset },
        ],
      },
    }),
  })
  assert.deepEqual(zai.usages, [
    { label: '5h limit', percent: 42.5, resetAt: reset * 1000 },
    { label: 'weekly', percent: 10, resetAt: (reset + 3600) * 1000 },
  ])

  const minimax = await A.minimax.query({
    route: { baseURL: 'https://api.minimax.io/anthropic' },
    apiKey: 'k',
    fetchJson: async () => ({
      model_remains: [
        {
          model_name: 'general',
          current_interval_remaining_percent: 58,
          end_time: reset,
          current_weekly_remaining_percent: 80,
          weekly_end_time: reset + 60,
        },
      ],
    }),
  })
  assert.deepEqual(minimax.usages, [
    { label: '5h limit', percent: 42, resetAt: reset * 1000 },
    { label: 'weekly', percent: 20, resetAt: (reset + 60) * 1000 },
  ])

  const kimiCalls = []
  const kimi = await A['kimi-coding'].query({
    route: { baseURL: 'https://api.kimi.com/coding' },
    apiKey: 'k',
    fetchJson: async (url) => {
      kimiCalls.push(url)
      return { usages: { limit_5h: { used_ratio: 0.4, reset_time: reset }, limit_7d: { used_ratio: 0.1 } } }
    },
  })
  assert.equal(kimiCalls[0], 'https://api.kimi.com/coding/v1/usages')
  assert.deepEqual(kimi.usages, [
    { label: '5h limit', percent: 40, resetAt: reset * 1000 },
    { label: 'weekly', percent: 10, resetAt: 0 },
  ])

  const opencode = await A.opencode.query({
    route: { baseURL: 'https://opencode.ai/api' },
    apiKey: 'k',
    fetchJson: async () => ({
      usage: { rolling: { percent: 30, resetsAt: reset }, monthly: { used_percent: 55 } },
    }),
  })
  assert.deepEqual(opencode.usages, [
    { label: 'rolling', percent: 30, resetAt: reset * 1000 },
    { label: 'monthly', percent: 55, resetAt: 0 },
  ])
})

test('openai / anthropic: admin cost-report spend mapping', async (t) => {
  const A = adapters.ADAPTERS
  if (!A?.openai || !A?.anthropic) {
    t.skip('admin spend adapters are missing')
    return
  }
  const now = Date.parse('2026-10-28T10:00:00+08:00')
  const openaiCalls = []
  const openai = await A.openai.query({
    route: { baseURL: 'https://api.openai.com/v1' },
    apiKey: 'admin-key',
    now,
    fetchJson: async (url, options) => {
      openaiCalls.push({ url, options })
      return { data: [{ results: [{ amount: { value: 1.25, currency: 'usd' } }, { amount: { value: 0.75, currency: 'usd' } }] }] }
    },
  })
  assert.match(openaiCalls[0].url, /^https:\/\/api\.openai\.com\/v1\/organization\/costs\?start_time=\d+$/)
  assert.equal(openaiCalls[0].options.headers.authorization, 'Bearer admin-key')
  assert.equal(openai.status, 'ok')
  assert.equal(openai.spend.label, 'this month')
  assert.equal(openai.spend.amount, '2.00')
  assert.equal(openai.spend.currency, 'usd')

  const anthropicCalls = []
  const anthropic = await A.anthropic.query({
    route: { baseURL: 'https://api.anthropic.com' },
    apiKey: 'admin-key',
    now,
    fetchJson: async (url, options) => {
      anthropicCalls.push({ url, options })
      return { data: [{ currency: 'USD', results: [{ amount: 1.5 }] }] }
    },
  })
  assert.match(anthropicCalls[0].url, /\/v1\/organizations\/cost_report\?starting_at=/)
  assert.equal(anthropicCalls[0].options.headers['x-api-key'], 'admin-key')
  assert.equal(anthropicCalls[0].options.headers['anthropic-version'], '2023-06-01')
  assert.equal(anthropic.spend.amount, '1.50')
  assert.equal(anthropic.spend.currency, 'USD')
})

test('github-copilot: quota_snapshots percentages + 401/403 status degradation', async (t) => {
  const adapter = adapters.ADAPTERS?.['github-copilot']
  if (!adapter) {
    t.skip('github-copilot adapter is missing')
    return
  }
  const row = await adapter.query({
    apiKey: 'token',
    fetchJson: async () => ({
      quota_snapshots: {
        chat: { percent_remaining: 75, quota_id: 'chat' },
        premium_interactions: { percent_remaining: 50, quota_id: 'premium_interactions' },
        completions: { percent_remaining: 100, quota_id: 'completions' },
      },
      quota_reset_date: 1_730_000_000,
    }),
  })
  assert.equal(row.status, 'ok')
  assert.deepEqual(row.usages, [
    { label: 'chat', percent: 25, resetAt: 1_730_000_000_000 },
    { label: 'premium requests', percent: 50, resetAt: 1_730_000_000_000 },
    { label: 'completions', percent: 0, resetAt: 1_730_000_000_000 },
  ])

  const rejected = await adapter.query({
    apiKey: 'token',
    fetchJson: async () => {
      throw Object.assign(new Error('HTTP 401: rejected'), { status: 401 })
    },
  })
  assert.equal(rejected.status, 'reauth-required')

  const forbidden = await adapter.query({
    apiKey: 'token',
    fetchJson: async () => {
      throw Object.assign(new Error('HTTP 403: no plan'), { status: 403 })
    },
  })
  assert.equal(forbidden.status, 'no-subscription')
})

test('openai-codex: OAuth grant is read from the credential store, never from env', async (t) => {
  const adapter = adapters.ADAPTERS?.['openai-codex']
  if (!adapter) {
    t.skip('openai-codex adapter is missing')
    return
  }
  const grant = {
    kind: 'grant',
    payload: { type: 'oauth', access: 'access-token', refresh: 'refresh-token', expires: Date.now() + 3600_000, accountId: 'acct-1' },
  }
  const credentials = {
    async readRecord(key) {
      assert.equal(key, 'llm-pi-ai/openai-codex')
      return grant
    },
    async modifyRecord(_key, update) {
      return update(grant)
    },
  }
  const ctx = { get: (name) => (name === 'credentials' ? credentials : null) }
  const calls = []
  const row = await adapter.query({
    ctx,
    route: { baseURL: 'https://chatgpt.com/backend-api' },
    now: Date.now(),
    fetchJson: async (url, options) => {
      calls.push({ url, options })
      return {
        rate_limit: { primary_window: { used_percent: 12, reset_at: 1_730_000_000_000 } },
        credits: { balance: 5, used: 2, currency: 'USD' },
      }
    },
  })
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/wham/usage')
  assert.equal(calls[0].options.headers.authorization, 'Bearer access-token')
  assert.equal(calls[0].options.headers['chatgpt-account-id'], 'acct-1')
  assert.equal(row.status, 'ok')
  assert.deepEqual(row.usages, [{ label: '5h limit', percent: 12, resetAt: 1_730_000_000_000 }])
  assert.deepEqual(row.balances, [{ currency: 'USD', total: '5.00', granted: '0.00', toppedUp: '5.00' }])
  assert.equal(row.spend.amount, '2')
})

// -------------------------------------------------------------- volcengine

function arkStubResponse(action) {
  if (action === 'GetAFPUsage' || action === 'GetAgentPlanAFPUsage') {
    return {
      Result: {
        AFP: {
          FiveHour: { Quota: 100, Used: 25, ResetTime: 1_730_000_000_000 },
          Weekly: { Quota: 1000, Used: 100 },
        },
      },
    }
  }
  return { Result: { QuotaUsage: [{ Level: 'session', Percent: 30 }, { Level: 'weekly', Percent: 10 }] } }
}

test('volcengine ark: action + POST + V4 signature headers; quota mapping', async (t) => {
  const A = adapters.ADAPTERS
  if (!A?.['volcengine-ark-agent'] || !A?.['volcengine-ark-coding']) {
    t.skip('volcengine adapters are missing')
    return
  }
  const resolveCredential = async (ref) => ({
    ok: true,
    value: ref.includes('ACCESS_KEY_ID') ? 'AKIDEXAMPLE' : 'SECRETEXAMPLE',
  })
  const calls = []
  const fetchJson = async (url, options) => {
    calls.push({ url, options })
    const action = new URL(url).searchParams.get('Action')
    return arkStubResponse(action)
  }
  const now = Date.parse('2026-10-28T02:00:00Z')

  const agent = await A['volcengine-ark-agent'].query({ now, fetchJson, resolveCredential })
  assert.equal(agent.status, 'ok')
  assert.equal(agent.usages.length, 2)
  assert.deepEqual(agent.usages.map((entry) => [entry.label, entry.percent]), [
    ['5h limit', 25],
    ['weekly', 10],
  ])
  assert.equal(calls[0].options.method, 'POST')
  assert.match(calls[0].options.headers.authorization, /^HMAC-SHA256 Credential=AKIDEXAMPLE\//)
  assert.match(calls[0].url, /^https:\/\/open\.volcengineapi\.com\/\?Action=GetAFPUsage&Version=/)

  const coding = await A['volcengine-ark-coding'].query({ now, fetchJson, resolveCredential })
  assert.deepEqual(coding.usages.map((entry) => [entry.label, entry.percent]), [
    ['5h limit', 30],
    ['weekly', 10],
  ])
})

test('signVolcengineRequest: deterministic V4 HMAC-SHA256 canonical request', (t) => {
  const sign = need(adapters, 'signVolcengineRequest')
  if (!sign) {
    t.skip('signVolcengineRequest is not exported yet')
    return
  }
  const now = Date.parse('2026-10-28T02:00:00Z')
  const input = {
    method: 'POST',
    host: 'open.volcengineapi.com',
    path: '/',
    params: { Version: '2024-01-01', Action: 'GetAFPUsage' },
    body: '{}',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'SECRETEXAMPLE',
    now,
  }
  const first = sign(input)
  const second = sign(input)
  assert.deepEqual(first, second, 'signing must be deterministic for a fixed clock/body')

  const timestamp = '20261028T020000Z'
  assert.equal(first.timestamp, timestamp)
  const payloadHash = createHash('sha256').update('{}', 'utf8').digest('hex')
  assert.equal(first.payloadHash, payloadHash)
  const canonicalQuery = 'Action=GetAFPUsage&Version=2024-01-01'
  const canonicalRequest = [
    'POST',
    '/',
    canonicalQuery,
    `host:open.volcengineapi.com\nx-content-sha256:${payloadHash}\nx-date:${timestamp}\n\nhost;x-content-sha256;x-date`,
    payloadHash,
  ].join('\n')
  const scope = '20261028/cn-beijing/ark/request'
  assert.equal(first.scope, scope)
  const stringToSign = ['HMAC-SHA256', timestamp, scope, createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')].join('\n')
  const hmac = (key, text) => createHmac('sha256', key).update(text, 'utf8').digest()
  const signingKey = hmac(hmac(hmac(hmac('SECRETEXAMPLE', '20261028'), 'cn-beijing'), 'ark'), 'request')
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')
  assert.equal(first.signature, signature)
  assert.equal(
    first.headers.authorization,
    `HMAC-SHA256 Credential=AKIDEXAMPLE/${scope}, SignedHeaders=host;x-content-sha256;x-date, Signature=${signature}`,
  )
  assert.equal(first.headers['x-date'], timestamp)
  assert.equal(first.headers['x-content-sha256'], payloadHash)

  const mutated = sign({ ...input, body: '{"x":1}' })
  assert.notEqual(mutated.signature, first.signature, 'a different body must change the signature')
})

// --------------------------------------------------------------- catalogs

test('catalogs: OpenRouter / New API fixtures become per-million USD tables', async (t) => {
  const openrouter = need(adapters, 'fetchOpenRouterCatalog')
  const newapi = need(adapters, 'fetchNewApiCatalog')
  const relay = need(adapters, 'isNewApiRelayCandidate')
  if (!openrouter || !newapi || !relay) {
    t.skip('catalog helpers are not exported yet')
    return
  }
  const now = Date.parse('2026-10-28T00:00:00Z')

  const orCalls = []
  const orCatalog = await openrouter({
    route: { baseURL: 'https://openrouter.ai/api/v1' },
    fetchJson: async (url) => {
      orCalls.push(url)
      return {
        data: [
          {
            id: 'deepseek/deepseek-chat',
            pricing: { prompt: '0.00000028', completion: '0.00000042', input_cache_read: '0.000000028' },
          },
          { id: 'missing-pricing' },
        ],
      }
    },
    now,
  })
  assert.equal(orCalls[0], 'https://openrouter.ai/api/v1/models')
  assert.equal(orCatalog.source, 'provider-catalog')
  assert.equal(orCatalog.currency, 'USD')
  assert.equal(orCatalog.unit, 'per-million-tokens')
  assert.equal(orCatalog.models.length, 1)
  assert.equal(orCatalog.models[0].match, 'deepseek/deepseek-chat')
  close(orCatalog.models[0].cacheMiss, 0.28, 'openrouter input')
  close(orCatalog.models[0].cacheHit, 0.028, 'openrouter cache read')
  close(orCatalog.models[0].output, 0.42, 'openrouter output')

  const naCalls = []
  const naCatalog = await newapi({
    route: { baseURL: 'https://relay.example.com' },
    fetchJson: async (url) => {
      naCalls.push(url)
      return {
        data: [
          { model_name: 'deepseek-chat', model_ratio: 0.5, completion_ratio: 2, cache_ratio: 0.1 },
          { model_name: 'per-call', model_ratio: 1, completion_ratio: 1, quota_type: 1 },
        ],
      }
    },
    now,
  })
  assert.equal(naCalls[0], 'https://relay.example.com/api/pricing')
  assert.equal(naCatalog.models.length, 1)
  close(naCatalog.models[0].cacheMiss, 1, 'new-api input')
  close(naCatalog.models[0].output, 2, 'new-api output')
  close(naCatalog.models[0].cacheHit, 0.1, 'new-api cache read')

  assert.equal(relay('https://api.deepseek.com'), false)
  assert.equal(relay('https://relay.example.com'), true)
  assert.equal(relay(''), false)
})

test('adapterFor: every documented kind resolves, unknown returns null', (t) => {
  const adapterFor = need(adapters, 'adapterFor')
  if (!adapterFor) {
    t.skip('adapterFor is not exported yet')
    return
  }
  for (const kind of KIND_LIST) {
    const adapter = adapterFor(kind)
    assert.ok(adapter, `adapterFor(${kind}) must resolve`)
    assert.equal(typeof adapter.query, 'function')
    assert.equal(typeof adapter.label, 'string')
  }
  assert.equal(adapterFor('does-not-exist'), null)
  assert.equal(adapterFor(''), null)
})
