# Configuration

All keys are optional. They live in the plugin line's `config` in the profile's bundle patch
(`cordis.patch.yml`), normally under `- insert: - id: balance-usage-dock`. Values are resolved by
`resolveConfig` in `index.js`: invalid or out-of-range values fall back to the default (or are clamped
to the documented range), unknown keys are ignored. Do not edit the profile by hand — let
`plugin_manager` install the plugin, then change `config` through the normal profile patch if you need
non-default values.

Credential **references** are resolved at request time through the host credential service
(`ctx.credentials.resolve(ref)`) with a `process.env[ref]` fallback. The plugin never stores a
credential value in config; `apiKeyEnv` only names the reference.

## Reference

### Refresh and statistics

| key | type | default | range / notes |
|---|---|---|---|
| `refreshSeconds` | integer | `60` | 5–86400. Legacy polling hint; v0.2 clients use `kind=config`. |
| `statsDays` | integer | `90` | 1–365. Heatmap window; also sent as `heatmapDays`. |
| `statsSessionLimit` | integer | `200` | 1–5000. Newest sessions scanned per stats pass. |
| `statsCacheSec` | integer | `300` | 0–86400. Server cache for `kind=stats`; `refresh=1` bypasses. |

### Time zones, peaks and holidays

| key | type | default | notes |
|---|---|---|---|
| `peakTimeZone` | IANA zone | `Asia/Shanghai` | Only finite offsets via `Intl`; invalid IDs fall back to the default. |
| `statsTimeZone` | IANA zone or `null` | `null` | `null` = host system zone. Day buckets (`YYYY-MM-DD`) use this zone. |
| `holidays` | `string[]` | `[]` | `YYYY-MM-DD` dates in `peakTimeZone`; those dates are off-peak all day. Deduplicated and sorted. |
| `peakWindows` | `{start,end}[]` | `[{9,12},{14,18}]` | Local wall hours in `peakTimeZone`; `start < end`, 0–24. |
| `peakWeekdays` | `integer[]` | `[1,2,3,4,5]` | `0` = Sunday. |

DeepSeek defines its peak windows in Beijing time: Monday–Friday excluding Chinese public holidays,
09:00–12:00 and 14:00–18:00. Keep the defaults unless the official page says otherwise; add public
holidays to `holidays` (the plugin does not bundle a calendar).

### Pricing sources

| key | type | default | notes |
|---|---|---|---|
| `pricingSources` | `string[]` | `["provider-catalog","official-page","models.dev"]` | Allowed: `provider-catalog`, `official-page`, `models.dev`. Order is priority order; drop a source to disable it. |
| `officialPricingUrls` | `string[]` | DeepSeek CN + EN price pages | Tried in order; first table that parses and validates wins. |
| `modelsDevUrl` | URL | `https://models.dev/api.json` | Community USD catalog (fallback). |
| `pricingTtlSec` | integer | `43200` | 3600–604800. Price-table and resolution cache TTL. |
| `priceOverrides` | object | `{}` | Manual prices, highest priority; see below. |
| `modelAliases` | object | `{}` | `{ "normalized-model-id": "catalog-model-id" }`; see below. |
| `extraPriceCatalogs` | object[] | `[]` | Extra JSON catalogs consulted under the `provider-catalog` source; see below. |

#### `priceOverrides`

The key may be `"<provider-id>/<model-id>"`, a bare model id, or a substring of the normalized model
id (longest key wins). A value may be:

- a number → cache-miss price only (cache hit/write/output become 0), or
- an object with `currency` (default `CNY`) and any of `cacheHit`, `cacheMiss`, `cacheWrite`, `output`.
  A bucket may be a number or an `{idle, peak}` pair. `cacheMiss` and `output` are required; the
  aliases `input`/`cache_hit`/`cache_miss`/`cache_write` are accepted.

```yaml
priceOverrides:
  "my-relay/deepseek-v4.1-flash":
    currency: CNY
    cacheHit: { idle: 0.02, peak: 0.04 }
    cacheMiss: { idle: 1, peak: 2 }
    cacheWrite: 0
    output: { idle: 4, peak: 8 }
  "deepseek-v4-pro": 13.5 # number shorthand: only the cache-miss price is priced
```

Precedence: `priceOverrides` → provider catalog → `extraPriceCatalogs` → official page → `models.dev`.
Override prices are labelled `confidence: "override"`.

#### `modelAliases`

Applied to both override lookup and catalog matching. Ids are normalized before comparison: a leading
`<vendor>/` is stripped, a trailing `:tag`, `-<3/4 digits>`, date suffix and
`-free/-beta/-preview/-exp/-vision/-latest/-instruct/-thinking` suffixes are removed, lower-cased and
hyphen-collapsed.

```yaml
modelAliases:
  "my-relay/fast": "deepseek-flash"
  "deepseek-v4.1-flash-1017": "deepseek-flash"
```

#### `extraPriceCatalogs`

Only used when `provider-catalog` is enabled. Entries are fetched through the same bounded HTTP client
as providers and cached for `ttlSec`.

| field | type | required | notes |
|---|---|---|---|
| `url` | `http(s)` URL | yes | JSON endpoint. |
| `format` | `openrouter` \| `newapi` \| `modelsdev` | no (`openrouter`) | Parser for the document. |
| `currency` | string | no (`USD`) | Fallback currency when the document has none. |
| `ttlSec` | integer | no (`3600`) | 60–604800. |
| `matchPrefix` | string | no | Only use this catalog when the provider id contains the prefix (case-insensitive). |

Formats:

- `openrouter` — `{data:[{id, pricing:{prompt, completion, input_cache_read}}]}` (USD per token → per 1M).
- `newapi` — `{data:[{model_name, model_ratio, completion_ratio, cache_ratio, quota_type}]}`;
  `model_ratio × 2` is the cache-miss price in USD/1M, `completion_ratio` scales output,
  `cache_ratio` scales cache hits; entries with a non-zero `quota_type` are skipped.
- `modelsdev` — a models.dev-shaped `{provider:{models:{id:{cost:{input,output,cache_read,cache_write}}}}}` document.

```yaml
extraPriceCatalogs:
  - url: https://my-relay.example.com/api/pricing
    format: newapi
    matchPrefix: my-relay
    ttlSec: 3600
  - url: https://openrouter.ai/api/v1/models
    format: openrouter
    currency: USD
```

### Providers

| key | type | default | notes |
|---|---|---|---|
| `providers` | object[] | `[]` | Manual routes / overrides; see below. |
| `trustedHosts` | `string[]` | `[]` | Extra allowed `Host` header values for the local route. Loopback (`127.0.0.1`, `localhost`, `[::1]`, `::1`) is always allowed, with or without a port. |

`providers` entries override detected routes with the same `id`; a detected route not listed here is
kept as-is. Fields:

| field | type | notes |
|---|---|---|
| `id` | string | Route id (e.g. `deepseek-official`, `my-relay`). |
| `kind` | string | Adapter kind (see [providers.md](providers.md)); explicit kind always wins over URL heuristics. |
| `baseURL` | string | Provider origin; `/v1` is stripped for root-style endpoints. |
| `apiKeyEnv` | string | Credential **reference** resolved via `ctx.credentials` then `process.env`. |
| `displayName` | string | Label in the dock/panel. |
| `enabled` | boolean | `false` removes the route from `overview`. |

```yaml
providers:
  - id: my-relay
    kind: deepseek
    baseURL: https://my-relay.example.com
    apiKeyEnv: MY_RELAY_API_KEY
    displayName: My Relay
    enabled: true
```

### Transport, caches and warmup

| key | type | default | range / notes |
|---|---|---|---|
| `requestTimeoutMs` | integer | `15000` | 1000–120000. Whole `GET /balance-usage-api` handler deadline; a miss returns `504 unavailable`. |
| `peerTimeoutMs` | integer | `12000` | 1000–120000. Per-provider balance query budget inside `overview`. |
| `overviewCacheSec` | integer | `15` | 0–3600. Server cache for `kind=overview` (`refresh=1` bypasses). |
| `sessionCacheSec` | integer | `1` | 0–600. Per-session micro-cache for `kind=session` (`refresh=1` bypasses). |
| `warmup` | boolean | `true` | Precompute overview + stats + pricing after boot. |
| `warmupDelayMs` | integer | `1500` | 0–60000. |
| `diagnosticsErrors` | integer | `20` | 1–200. Redacted error ring exposed by `kind=diagnostics`. |

### Browser tuning (served through `kind=config`)

| key | default | notes |
|---|---|---|
| `clientRefresh.overviewSec` | `60` | 5–3600. Overview TTL in the browser. |
| `clientRefresh.sessionRunningSec` | `3` | 1–300. Session TTL while the session is running. |
| `clientRefresh.sessionIdleSec` | `15` | 2–3600. Session TTL when idle. |
| `clientRefresh.statsSec` | `60` | 10–3600. Stats TTL. |
| `clientRetry.maxRetries` | `2` | 0–5. Browser GET retries (server-side adapter retries are separate). |
| `clientRetry.requestTimeoutMs` | `20000` | 2000–120000. Browser request timeout. |

The browser retries only network/timeout/408/425/429/5xx/`retryable` failures, keeps stale payloads on
screen, and backs off 2 s → 4 s → … up to 60 s.

## Complete example

```yaml
- insert:
    - id: balance-usage-dock
      name: dsh-balance-usage-dock
      config:
        peakTimeZone: Asia/Shanghai
        statsTimeZone: Asia/Shanghai
        holidays: ["2026-10-01", "2026-10-02", "2026-10-03"]
        statsDays: 90
        statsSessionLimit: 300
        requestTimeoutMs: 15000
        peerTimeoutMs: 10000
        pricingSources: [provider-catalog, official-page, models.dev]
        pricingTtlSec: 43200
        priceOverrides:
          "my-relay/deepseek-v4.1-flash":
            currency: CNY
            cacheHit: { idle: 0.02, peak: 0.04 }
            cacheMiss: { idle: 1, peak: 2 }
            output: { idle: 4, peak: 8 }
        modelAliases:
          "my-relay/fast": "deepseek-flash"
        extraPriceCatalogs:
          - url: https://my-relay.example.com/api/pricing
            format: newapi
            matchPrefix: my-relay
            ttlSec: 3600
        providers:
          - id: my-relay
            kind: deepseek
            baseURL: https://my-relay.example.com
            apiKeyEnv: MY_RELAY_API_KEY
            displayName: My Relay
        trustedHosts: ["127.0.0.1:55976"]
        clientRefresh:
          overviewSec: 30
          sessionRunningSec: 3
          sessionIdleSec: 15
          statsSec: 60
        clientRetry:
          maxRetries: 2
          requestTimeoutMs: 20000
```

## Validation behaviour

- Unknown keys are ignored; a value that is not its expected type falls back to the default.
- Integer keys are clamped; IANA zones are validated through `Intl.DateTimeFormat` and fall back to
  the default zone when invalid (`statsTimeZone` falls back to `null`).
- `peakWindows` entries with `start >= end` are dropped; an empty result falls back to the defaults.
  The same applies to `peakWeekdays`, `pricingSources`, `officialPricingUrls` and `providers`.
- `extraPriceCatalogs` entries with a non-http(s) URL or unknown `format` are dropped.
- `holidays` accepts only `YYYY-MM-DD` strings.
