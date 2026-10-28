# Providers

The host half discovers provider routes, classifies each into an adapter `kind`, and queries it
independently. One provider failing never fails `kind=overview`: failures become a `status` plus a
short `message`, and `overview.degraded` is true when at least one provider failed while others are
usable. Every row carries `retryable`, `fetchedAt` and `stale`.

## Discovery

Routes are resolved in three layers, strongest first:

1. The live host catalog — `ctx.get('llm').listProviders()` plus
   `listConfigurableProviders()`, with `{baseURL, apiKeyEnv, displayName}` read from the profile's
   `configEditor.entries()` section (`options.id` = settings namespace).
2. Host-declared defaults (`defaultBaseURL`, `nativeAuth.env`, `displayName`).
3. The frozen `KNOWN_ROUTES` snapshot in `lib/providers.js`.

`config.providers[]` then overrides matching ids (`enabled: false` removes a route; an explicit
`kind` always wins over the URL heuristics). Routes with a non-empty `id` are classified by
`classifyKind(routeId, baseURL, explicitKind)`.

### Credentials

A route's `apiKeyEnv` is a credential **reference**, not a value. It is resolved per request via
`ctx.credentials.resolve(ref)` with a `process.env[ref]` fallback. Values are never cached, logged or
returned. Detected routes default to the provider's conventional env names; manual routes set
`apiKeyEnv` themselves. `openai-codex` and `volcengine-*` resolve their own grant/key pair instead
(`requiresCredential: false`).

## Route ids → kinds

| route id (detected) | kind |
|---|---|
| `deepseek-official` | `deepseek` |
| `deepseek-account` | `deepseek-account` |
| `kimi-coding` | `kimi-coding` |
| `moonshotai`, `moonshotai-cn` | `moonshot` |
| `openrouter` | `openrouter` |
| `xai` | `xai` |
| `vercel-ai-gateway` | `vercel-ai-gateway` |
| `zai`, `zai-coding-cn` | `zai` |
| `minimax`, `minimax-cn` | `minimax` |
| `opencode`, `opencode-go` | `opencode` |
| `openai` | `openai` |
| `anthropic` | `anthropic` |
| `github-copilot` | `github-copilot` |
| `openai-codex` | `openai-codex` |
| `ark-agent-plan` | `volcengine-ark-agent` |
| `ark-coding-plan` | `volcengine-ark-coding` |

URL heuristics map unknown ids by host (e.g. `platform.deepseek.com` → `deepseek-account`,
`chatgpt.com/backend-api` → `openai-codex`, `volces.com`/`volcengine` → `volcengine-ark-agent`);
anything else is `unknown` and renders as `unsupported`.

## The 16 adapter kinds

All balance/usage queries are `GET` unless noted. `Bearer` means
`authorization: Bearer <resolved credential>`.

| kind | upstream endpoint | auth | returned fields |
|---|---|---|---|
| `deepseek` | `GET {root}/user/balance` (`/v1` stripped) | Bearer | `balances[]` from `balance_infos` (`currency`, total, granted, topped-up) |
| `deepseek-account` | host service `deepseekAccount` (no HTTP) | host account session; no API key | `balances[]` merged from recharge + bonus wallets, per currency |
| `moonshot` | `GET {baseURL}/users/me/balance` | Bearer | `balances[]` from `data.{available_balance, voucher_balance, cash_balance}` |
| `openrouter` | `GET {origin}/api/v1/credits` | Bearer | `balances[]` (remaining = total credits − usage) + `spend` (`credits used`, USD) |
| `xai` | `GET {base}/prepaid/balance` for `management-api.x.ai`, else `GET {base}/billing/credits` | Bearer | `balances[]` (cents → USD) |
| `vercel-ai-gateway` | `GET {base}/v1/credits` | Bearer | `balances[]` from `balance` |
| `zai` | `GET {origin}/api/monitor/usage/quota/limit` | raw `authorization: <key>` | `usages[]` from `TOKENS_LIMIT` rows (5h limit / weekly / limit N) |
| `minimax` | `GET {origin}/v1/api/openplatform/coding_plan/remains` | Bearer | `usages[]` (5h limit, weekly) from remaining percentages |
| `kimi-coding` | `GET {base}/v1/usages` (or `{base}/usages` when base ends `/v1`) | Bearer + `user-agent: KimiCLI/1.6` | `usages[]` from `limit_5h`, `limit_7d`, `limit_month_total`, `limit_month_code` |
| `opencode` | `GET {base}/v1/usage` | Bearer | `usages[]` for `rolling`, `weekly`, `monthly` windows |
| `openai` | `GET {origin}/v1/organization/costs?start_time=<UTC month start>` | Bearer **admin** key | `spend` (`this month`, provider-reported currency) |
| `anthropic` | `GET {base}/v1/organizations/cost_report?starting_at=<UTC month start>` | `x-api-key` + `anthropic-version: 2023-06-01` | `spend` (`this month`) |
| `github-copilot` | `GET https://api.github.com/copilot_internal/user` | `token <key>` + Copilot editor headers | `usages[]` from `quota_snapshots` or `limited_user_quotas` |
| `openai-codex` | `GET {base}/wham/usage`; token refresh `POST https://auth.openai.com/oauth/token` | OAuth grant from the credential store (`llm-pi-ai/openai-codex`): Bearer access token + `originator: pi` + `chatgpt-account-id` | `usages[]` (5h limit, weekly, extra windows, spend limit), optional `balances[]`/`spend` from credits |
| `volcengine-ark-agent` | `POST https://open.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01` (retries with `GetAgentPlanAFPUsage` on `InvalidActionOrVersion`) | IAM AK/SK (`VOLC_ARK_ACCESS_KEY_ID`, `VOLC_ARK_ACCESS_KEY_SECRET`, with conventional fallbacks), Volcengine V4 HMAC-SHA256 | `usages[]` (5h limit, weekly, monthly) |
| `volcengine-ark-coding` | `POST https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01` | same as above | `usages[]` from `QuotaUsage[]` (`session` → 5h limit, `weekly`, `monthly`) |

Field shapes (frozen by `docs/contract-v2.md`):

```json
"balances": [{ "currency": "CNY", "total": "12.34", "granted": "0.00", "toppedUp": "12.34" }]
"usages":   [{ "label": "5h limit", "percent": 42, "resetAt": 0 }]
"spend":    { "label": "this month", "amount": "3.21", "currency": "USD", "source": "provider", "asOf": 0 }
```

`balances`/`usages`/`spend` are `null` when the provider has no such data. Amounts are decimal strings
(2 dp, sub-cent values keep visible precision); `percent` is clamped 0–100 and rounded to 2 dp;
`resetAt` is epoch milliseconds.

## Status values

| status | meaning | retryable |
|---|---|---|
| `ok` | data returned | – |
| `error` | request/parse failed; `message` holds a sanitised reason (`HTTP 403`, `network error (…)`) | usually `true` for 5xx/network/timeouts, `false` for 4xx |
| `missing-credential` | route needs a credential and none resolved | `false` |
| `missing-authorization` | admin-scoped kind (`openai`, `anthropic`) got 401/403 | `false` |
| `reauth-required` | OAuth/token rejected or expired beyond refresh (Codex, Copilot 401) | `false` |
| `unsupported` | no balance API for this provider / no adapter for the kind | `false` |
| `no-subscription` | Copilot token without an active subscription (403) | `false` |

`overview.degraded` is true when `error` rows coexist with `ok` rows. Rows answered from the 30 s
per-provider cache are marked `stale: true` (their `fetchedAt` is the original query time). A provider
query exceeding `peerTimeoutMs` degrades that row to `error` without touching the others.

## Price catalogs owned by providers

`createProvidersEngine.getProviderPrices(routeId)` returns a per-million-token table for routes that
expose one, otherwise `null`:

- `openrouter` → `${origin}/api/v1/models` (USD; `prompt`/`completion`/`input_cache_read` per token ×
  1e6), rendered as `source: provider-catalog`, `confidence: exact|family` depending on the match.
- any non-official host (New API relay candidate) → `${origin}/api/pricing`, using
  `model_ratio × 2` USD/1M and `completion_ratio`/`cache_ratio`.
- official hosts (DeepSeek, Kimi, Moonshot, OpenRouter, xAI, Vercel, Z.ai, MiniMax, OpenAI, Anthropic,
  Copilot, ChatGPT, OpenCode, Volcengine) never expose a New API relay catalog and are skipped.

## Known coverage

`deepseek`, `deepseek-account`, `moonshot`, `openrouter`, `xai`, `zai`, `minimax`, `kimi-coding` and
`opencode` are exercised against stubbed fixtures in `test/providers.test.mjs`. `github-copilot`,
`openai-codex` and both Volcengine Ark kinds are fixture/joint-tested only — there is no live account
in CI, so treat their field mappings as best effort until you can run them against a real plan.
