# Architecture

How `dsh-balance-usage-dock` is split between the DSH host and the browser bundle, how session
events become money, and where every cache/deadline lives. The frozen wire contract is
[contract-v2.md](contract-v2.md); this document explains the implementation behind it.

## Components

| file | side | role |
|---|---|---|
| `index.js` | host | Cordis plugin entry: resolves config (clamping defaults), registers the route inside an effect, schedules best-effort warmup. |
| `lib/http.js` | host | Route registration, loopback/same-origin fence, whole-handler deadline, error envelope, message sanitisation, redacted error sink. |
| `lib/api.js` | host | Handler map for every `kind`, server-side caches (`overview`, `session`), diagnostics ring, `warmup()`. |
| `lib/providers.js` | host | Route discovery (host catalog + config profiles + `KNOWN_ROUTES`), `classifyKind`, per-provider balance/quota/spend queries with `peerTimeoutMs`, 30 s result cache, provider price catalogs. |
| `lib/adapters.js` | host | One isolated adapter per provider family (16 kinds), bounded JSON fetch with retries, credential-safe errors, V4 signing, OpenRouter/New API price catalogs. |
| `lib/pricing.js` | host | Runtime price resolution, official-page parser, peak/holiday predicate, confidence labels, provider/extra/models.dev catalogs. |
| `lib/usage.js` | host | Session event fold (`tokens`, costs, `byModel`, confidence), fork-prefix skip, subagent rollup, 90-day stats. |
| `client.js` | browser | Single module-loader bundle: in-memory data store, 1 s scheduler, model-selection subscription, dock cell, overlay panel, localised copy fallback. |
| `locale/*.json` | both | Host-side `meta.title/description` dictionaries and UI strings; `client.js` also bundles an offline copy. |

The host half is plain ESM for the host's Node (≥22); the browser half is a `window.__ModuleLoader__.load`
factory that may require exactly one module: `react`. Nothing is bundled or transpiled — there is no build step.

## Request flow

```
browser dock/panel
  └─ fetch GET /balance-usage-api?kind=…            (same-origin, cache: no-store, AbortSignal)
       └─ lib/http.js  checkGuard → kind lookup → Promise.race(handler, requestTimeoutMs)
            └─ lib/api.js  handler
                 ├─ kind=config       static tuning from resolved config
                 ├─ kind=overview     providers.overview()        [15 s cache]
                 ├─ kind=session      usage.sessionUsage(id)      [1 s per-id cache]
                 ├─ kind=stats        usage.stats({force})        [300 s cache]
                 ├─ kind=pricing      pricing.snapshot/refresh    [12 h price TTL]
                 ├─ kind=diagnostics  capabilities + price + provider status counts + error ring
                 └─ kind=ping         liveness
            └─ { ok: true, data } | { ok: false, error: { code, message, retryable } }
```

Request deadline misses answer `504` / `unavailable` / `retryable: true`. Handler throws map to
`bad-request` (<500), `unavailable` (503/504) or `internal` (other 5xx), with `retryable = status ≥ 500`.
All responses carry `cache-control: no-store`, `nosniff` and `referrer-policy: no-referrer`.

## Session-event accounting

Events are read through `ctx.get('sessions')?.get(id)` (live `snapshotEvents()`), then
`sessionController.inspect(id)`, then `sessionQuery.observeSession(id, { projectionMode: 'none' })`.
Each layer is optional.

Only `assistant/message` events with `data.usage` contribute tokens. The fold:

1. **Fork prefix** — every event with `seq < inheritedEventCount` is dropped. A forked session
   therefore never bills its parent's history.
2. **Request time** — `step/start` (`data.turn`/`data.step`) gives the request start time; an
   assistant message without a matching step uses its own event time (this decides peak/idle).
3. **Provider/model** — `request/header` (`data.header.config`) and `request/context`
   (`data.provider`/`data.model`) record switches; the last switch at or before the message applies.
   `assistant/message.data.message.source` wins when present.
4. **Usage** — `inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`.
   Cost = `(input×cacheMiss + cacheRead×cacheHit + cacheWrite×cacheWrite + output×output) / 1e6`
   using the price resolved for that event's provider/model and the event's peak/idle bucket.
5. **Aggregation** — totals are cumulative for the whole session; a provider/model switch never
   resets them. `byModel` keeps `{provider, model, tokens, cost, currency, costs, priceSource,
   pricingConfidence}` per model, and its per-currency amounts sum back to `costs` (6 decimals).
6. **Pricing confidence** — each priced event contributes its price `confidence`; the session reports
   the weakest one (`none < community < family < override < exact`).
7. **Mixed providers** — `mixedProviders` is true when `byModel` contains more than one provider.
8. **Subagents** — `subagents.listDescendants(sessionId)` returns the reachable descendant tree;
   each `{kind: 'child', id}` is folded independently (own fork prefix respected) and added to the
   top-level `tokens`/`costs`, while `subagent` isolates the child part (`sessions`, `requested`,
   `unavailable`, `tokens`, `costs`, `cost`, `currency`, `priced`). If the service is absent or
   throws, the payload degrades to parent-only with `unavailable: true` — it never throws.

Currencies are never converted; multi-currency costs stay a list, and `cost` is only set when a single
currency is unambiguous.

## Stats (90 days)

`stats` lists sessions through `sessionQuery.listSessions()` (fallback `sessionController.list`),
keeps the newest `statsSessionLimit` inside the `statsDays` window, reads each session's own events
(not descendants — parent and child are separate rows, so the heatmap never double-counts), and buckets
each usage item by `dateKey(event.time)` in `statsTimeZone` (IANA; `null` = host zone). It reports
`scannedSessions`, `failedSessions`, `truncated`, per-day `costs`/`models` and `pricingConfidence`.
`?kind=stats&refresh=1` passes `force` and bypasses the server cache.

## Pricing engine

Sources, in order, all optional via `pricingSources`:

1. `priceOverrides` — exact `provider/model` key, model key, or longest substring match; may be a
   number (cache-miss only) or `{cacheHit, cacheMiss, cacheWrite, output}` with numbers or
   `{idle, peak}` pairs.
2. Provider's own catalog (`providers.getProviderPrices`) and `extraPriceCatalogs` (OpenRouter/New API/
   models.dev-shaped JSON, cached per `ttlSec`, optional `matchPrefix`).
3. Official DeepSeek price page (CNY/1M tokens). The parser requires the `价格` table and validates
   `peak = 2 × idle` for every bucket; a broken table yields a warning and keeps the last good table.
4. `models.dev` (USD, community; labelled `community` and lower confidence).

An official/HTML table is cached for `pricingTtlSec`; provider catalogs for 5 minutes; a
`{provider, model}` resolution for `pricingTtlSec`. `?kind=pricing` returns source, URL, fetch time,
staleness, the flash/pro table, the peak definition (IANA `timeZone` + back-compat offset + holidays)
and any warning.

Peak windows are evaluated in `peakTimeZone` using `Intl.DateTimeFormat` (no fixed UTC offset), honour
`peakWeekdays`, and are skipped entirely on dates listed in `holidays`.

## Caches, deadlines and retries

Host side:

| layer | bound |
|---|---|
| whole handler | `requestTimeoutMs` (default 15 s) → 504 `unavailable` |
| per-provider balance query | `peerTimeoutMs` (default 12 s) → that provider row degrades to `error` |
| `kind=overview` | `overviewCacheSec` (15 s) + shared in-flight promise |
| `kind=session` | `sessionCacheSec` (1 s) per session id + shared in-flight promise |
| `kind=stats` | `statsCacheSec` (300 s); `refresh=1` forces |
| provider result | 30 s in `providers.js`; stale rows are marked `stale` |
| provider price catalog | 5 min in `providers.js`; extra catalogs `ttlSec` |
| price table / resolution | `pricingTtlSec` (12 h default) |
| adapter HTTP | 20 s per attempt; up to 2 retries on 408/425/429/5xx and transient network failures |

Browser side (`client.js`): one in-memory store keyed by `config`, `overview`, `session:<id>`, `stats`,
`pricing`, `selection`. A single 1 s scheduler tick runs while subscribers exist, pauses while
`document.hidden`, revalidates immediately on focus/visibility change, and refreshes each key by the
TTL from `kind=config` (`clientRefresh.*`). Failed keys keep their last payload, show a `retrying`
state and back off 2 s → 4 s → … capped at 60 s, resetting on success. GET retries honour
`clientRetry.maxRetries`, only for network/timeout/408/425/429/5xx/`retryable` failures, never for
other 4xx. The dock's balance target is `selection.provider` → `session.provider` → `overview.active`;
the session cost shown is always the server's value (never clipped when the model switches).

## Model-selection following

The browser subscribes to `ctx.modelDirectories.directoryFor(sessionId).store` and publishes
`{provider, model, sessionId}` from the directory snapshot (`pending ?? current`) into the `selection`
store entry. A provider change soft-refreshes `overview` and the session payload; old data stays on
screen until the new payload lands. This is a client-side concern only — the host fold is independent
of the current selection.

## Diagnostics

`lib/api.js` keeps a bounded ring (`diagnosticsErrors`) of `{code, message, at}` failures. `kind=diagnostics`
adds plugin/version, detected capabilities (boolean probes of host services, `null` when unknown),
price snapshot summary, provider counts by status and the resolved config summary. It never includes
credential values, credential records, account profile/email/phone, session content, or request URLs
with query secrets; HTTP error text is sanitised (URL query stripped, `sk-*`/`Bearer` masked, bounded).

## Privacy enforcement points

- Host: no filesystem writes in shipped code; credentials only via `ctx.credentials` /
  `apiKeyEnv` env fallback, never cached, logged or returned; the HTTP fence accepts GET only from
  loopback/same-origin hosts (`trustedHosts` opt-in).
- Client: no `localStorage`/`sessionStorage`/`indexedDB`/cookies, no alternate transports; only GETs
  to the local API route, `cache: no-store`.
- `test/privacy.test.mjs` statically enforces all of the above over every shippable `.js`/`.json`/`.yml`.

## Failure modes

| symptom | likely cause |
|---|---|
| dock empty, no route | `webServer` service missing (`registerRoute` no-op) or plugin not loaded |
| overview rows `missing-credential` | host has no key/credential for that route; set `apiKeyEnv` or add `config.providers` |
| `unsupported` | provider has no balance API (or the kind has no adapter) |
| `no-subscription` | Copilot token without an active plan |
| cost `null`, tokens shown | no price source matched — add `priceOverrides`/`extraPriceCatalogs` |
| warnings in `kind=pricing` | official page unavailable or failed invariant validation |
| `subagent.unavailable: true` | `subagents` service missing or listing failed |
