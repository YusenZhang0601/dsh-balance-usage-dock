# Internal interfaces (v0.2)

The frozen wire contract lives in `docs/contract-v2.md`. This file only maps
module boundaries between the host half and the browser bundle.

## `lib/providers.js` (provider engine)

```js
export function createProvidersEngine(ctx, config) {
  return {
    async overview(),            // bounded; rows carry status/retryable/fetchedAt/stale
    async getProviderPrices(id), // provider's own model price catalog or null
    routes(),                    // [{id, displayName, kind}] for diagnostics
  }
}
```

Bounded by `config.peerTimeoutMs` per provider and `config.overviewCacheSec` for
the whole payload; shared in-flight promise; never throws per provider.

## `lib/pricing.js` (runtime pricing)

```js
export function createPricingEngine(ctx, config, deps) // deps: { getProviderPrices }
// async resolveModel(provider, model) -> null | {
//   source: 'override'|'provider-catalog'|'extra-catalog'|'official-page'|'models.dev',
//   currency, unit, confidence: 'exact'|'family'|'community'|'override',
//   cacheHit/cacheMiss/cacheWrite/output: { idle, peak }, fetchedAt, url }
// async refresh({force}) ; async snapshot() ; isPeak(atMs) ; priceAt(price, atMs)
export function parseOfficialPricing(html)   // pure, fixture-tested
export function normalizeModelId(value)      // pure, fixture-tested
export function weakestConfidence(values)    // shared by usage + pricing
```

Peak windows use `config.peakTimeZone` (IANA) and `config.holidays`; prices are
never hard-coded. `extraPriceCatalogs` accepts `openrouter` / `newapi` /
`modelsdev` JSON shapes.

## `lib/usage.js` (session accounting)

```js
export function createUsageEngine(ctx, config, pricing)
//   async sessionUsage(sessionId) -> cumulative tokens/costs/byModel/subagent/confidence
//   async stats({force})         -> 90-day days/totals/confidence, server-cached
```

Rules: skip `seq < inheritedEventCount`; only `assistant/message.data.usage`;
per-event model/provider pricing (switch never resets); subagent sessions are
rolled into `sessionUsage` but stay separate rows in `stats` (no double count).
Daily buckets use `config.statsTimeZone` (system zone when null).

## `lib/http.js` (carrier)

- `registerRoute(ctx, config, handlers, sink)` — one exact GET route, loopback /
  same-origin fence, per-request deadline (`config.requestTimeoutMs`), error
  envelope `{code, message, retryable}`, redacted error ring via `sink`.
- `checkGuard(req, config)` / `sanitizeMessage(value)` are exported for tests.

## `lib/api.js` (handlers)

`createHandlers(ctx, config, version)` returns `{ handlers, warmup, recordError }`.
Handlers: `ping`, `config`, `diagnostics`, `overview`, `session`, `stats`,
`pricing`; short caches for overview/session; `warmup()` precomputes overview,
stats and pricing after boot.

## `client.js` (browser bundle)

Single hand-authored `window.__ModuleLoader__.load` bundle, `require('react')`
only. Module data store + one scheduler; `kind=config` drives TTLs; model
selection comes from `ctx.get('modelDirectories').directoryFor(sessionId).store`;
retries/timeouts/backoff live in `fetchKind`; ErrorBoundary protects both slots.
No persistence, no credentials, no `@deepseek-ai/*` imports.
