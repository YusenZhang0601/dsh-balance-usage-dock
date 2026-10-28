# v0.2 contract (frozen for this iteration)

Everything below is the wire contract between the host half (`index.js`,
`lib/*.js`) and the browser bundle (`client.js`). Change only with the Lead.

## Endpoint

`GET /balance-usage-api?kind=<kind>` — same-origin / loopback only, `cache-control: no-store`, `GET` only.

Success: `{ "ok": true, "data": <payload> }`

Failure: `{ "ok": false, "error": { "code": "bad-request"|"unavailable"|"internal", "message": "...", "retryable": true|false } }`

- `bad-request` → HTTP 400 (invalid kind / missing session), not retryable.
- `unavailable` → HTTP 503/504 (deadline, upstream unavailable), retryable.
- `internal` → HTTP 500 (unexpected), retryable.

## `kind=config` (new, non-sensitive tuning for the browser)

```json
{
  "pluginVersion": "0.2.0",
  "refresh": { "overviewSec": 60, "sessionRunningSec": 3, "sessionIdleSec": 15, "statsSec": 60 },
  "retry": { "maxRetries": 2, "requestTimeoutMs": 20000 },
  "heatmapDays": 90
}
```

## `kind=overview`

Adds `degraded`, and per provider `retryable`, `fetchedAt`, `stale`:

```json
{
  "fetchedAt": 0, "active": "deepseek-official", "degraded": false,
  "providers": [{
    "id": "deepseek-official", "displayName": "DeepSeek", "kind": "deepseek",
    "status": "ok|error|missing-credential|missing-authorization|reauth-required|unsupported|no-subscription",
    "message": null, "retryable": false,
    "balances": [{ "currency": "CNY", "total": "12.34", "granted": "0.00", "toppedUp": "12.34" }],
    "usages": [{ "label": "5h limit", "percent": 42, "resetAt": 0 }],
    "spend": { "label": "this month", "amount": "3.21", "currency": "USD", "source": "provider", "asOf": 0 },
    "active": true, "fetchedAt": 0, "stale": false
  }]
}
```

`degraded: true` when at least one provider failed/timed out but the rest are usable.

## `kind=session&session=<id>`

`tokens` / `cost` / `costs` remain the whole turn tree (session + reachable subagent sessions).
New fields: `byModel`, `mixedProviders`, `pricingConfidence`.

```json
{
  "sessionId": "…", "provider": "deepseek-official", "model": "deepseek-flash",
  "tokens": { "input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 0 },
  "cost": 0.0123, "currency": "CNY", "priced": true,
  "costs": [{ "currency": "CNY", "amount": 0.0123 }],
  "priceSource": "official-page|provider-catalog|extra-catalog|models.dev|override|none",
  "pricingConfidence": "exact|family|community|override|none",
  "pricingAsOf": 0, "pricingStale": false,
  "mixedProviders": false,
  "turns": 3, "steps": 5, "updatedAt": 0,
  "byModel": [{
    "provider": "deepseek-official", "model": "deepseek-flash",
    "tokens": { "input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 0 },
    "cost": 0.0101, "currency": "CNY", "priced": true,
    "costs": [{ "currency": "CNY", "amount": 0.0101 }],
    "priceSource": "official-page", "pricingConfidence": "exact"
  }],
  "subagent": { "sessions": 2, "requested": 2, "unavailable": false,
                "tokens": { "input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 0 },
                "costs": [{ "currency": "CNY", "amount": 0.0021 }],
                "cost": 0.0021, "currency": "CNY", "priced": true }
}
```

Rules: accumulated across the whole session; provider/model switches never reset it. `byModel`
amounts sum to `costs` per currency (rounded to 6 decimals). `mixedProviders` = distinct
providers among priced events > 1. `pricingConfidence` is the weakest confidence used.

## `kind=stats`

```json
{
  "days": [{ "date": "2026-10-28", "tokens": 0, "costs": [{ "currency": "CNY", "amount": 0 }],
             "cost": 0, "currency": "CNY", "sessions": 2,
             "models": { "deepseek-flash": { "tokens": 0, "cost": 0, "currency": "CNY" } } }],
  "totals": { "today": { "tokens": 0, "costs": [], "cost": 0, "currency": "CNY" } },
  "priceSource": "official-page", "pricingAsOf": 0, "pricingStale": false,
  "pricingConfidence": "exact",
  "scannedSessions": 12, "failedSessions": 0, "truncated": false
}
```

`?kind=stats&refresh=1` bypasses the server cache.

## `kind=pricing` (unchanged shape, adds nothing sensitive)

Existing `source/url/fetchedAt/stale/currency/unit/models/peak/warning` stays. `peak` now contains
`timeZone` (IANA) instead of only an offset; keep `timeZoneOffsetHours` for back-compat.

## `kind=diagnostics` (new, safe to paste into issues)

```json
{
  "plugin": "dsh-balance-usage-dock", "version": "0.2.0",
  "dshProfile": "desktop|null",
  "capabilities": { "webServer": true, "credentials": true, "llm": true,
                    "sessionQuery": true, "sessionController": true,
                    "subagents": true, "modelDirectories": null },
  "price": { "source": "official-page", "fetchedAt": 0, "stale": false, "warning": null,
             "sources": ["provider-catalog", "official-page", "models.dev"] },
  "providers": { "total": 3, "byStatus": { "ok": 1, "unsupported": 1, "missing-credential": 1 } },
  "errors": [{ "code": "unavailable", "message": "timeout", "at": 0 }],
  "config": { "refreshSeconds": 60, "pricingTtlSec": 43200, "peakTimeZone": "Asia/Shanghai",
              "statsTimeZone": "Asia/Shanghai", "pricingSources": ["…"], "providersConfigured": 0 },
  "generatedAt": 0
}
```

`modelDirectories` is `null` on the host: it is a client-only service the host cannot observe.

Never include: token/credential values, credential records, account profile/email/phone, session
content, request URLs with query secrets. Credential **ref names** are allowed, values are not.

## Config additions (plugin `config` in `cordis.patch.yml`)

| key | default | meaning |
|---|---|---|
| `peakTimeZone` | `Asia/Shanghai` | IANA zone for high-peak windows (DeepSeek defines them in Beijing time) |
| `statsTimeZone` | system zone | IANA zone for daily bucketing; `null` = host system zone |
| `holidays` | `[]` | `YYYY-MM-DD` dates treated as all-day off-peak |
| `modelAliases` | `{}` | `{ "normalized-model-id": "catalog-model-id" }` for pricing lookup |
| `extraPriceCatalogs` | `[]` | `[{url, format:'openrouter'|'newapi'|'modelsdev', currency, ttlSec, matchPrefix?}]` |
| `requestTimeoutMs` | `15000` | server-side whole-handler deadline |
| `peerTimeoutMs` | `12000` | per-provider balance query budget inside `overview` |
| `overviewCacheSec` | `15` | short server cache for `overview` |
| `sessionCacheSec` | `1` | micro-cache for `session` per session id |
| `warmup` | `true` | precompute overview + stats after boot |
| `warmupDelayMs` | `1500` | warmup delay |
| `clientRefresh` | `{overviewSec:60,sessionRunningSec:3,sessionIdleSec:15,statsSec:60}` | exposed via `kind=config` |
| `clientRetry` | `{maxRetries:2,requestTimeoutMs:20000}` | exposed via `kind=config` |

## Client data layer (browser, in-memory only)

- Module store keys: `config`, `overview`, `session:<id>`, `stats`, `pricing`, `selection`.
- Single scheduler tick (1s) when subscribers exist; paused while `document.hidden`; immediate
  revalidate on visibility/focus; TTLs come from `kind=config`; exponential backoff on failure
  (2s → 4s → … cap 60s), reset on success.
- `selection` comes from `ctx.modelDirectories.directoryFor(sessionId).store` snapshot
  `{current, pending}` → `{provider, model}`; fallback chain: selection → session.provider → overview.active.
- Balance target = `overview.providers` row whose `id === selection.provider`.
- Session cost is never clipped on switch: display the server `cost`/`costs` as-is.
- Retries: GET only, max `clientRetry.maxRetries`, retry on network/timeout/408/425/429/5xx/`retryable`,
  not on other 4xx. Keep stale payloads; expose `{retrying, error}` state per key.

## Privacy invariants (tested)

No `localStorage`/`sessionStorage`/`indexedDB`/`document.cookie`/`fetch` to non-local origins from
the client; no file/storage writes on the host; no credential values or account profile in any
response, log, or diagnostics; no telemetry.
