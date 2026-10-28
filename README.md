# dsh-balance-usage-dock

[![CI](https://github.com/YusenZhang0601/dsh-balance-usage-dock/actions/workflows/ci.yml/badge.svg)](https://github.com/YusenZhang0601/dsh-balance-usage-dock/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A zero-dependency [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that adds one cell to the **composer dock**: the balance of the provider you are currently using plus the cumulative estimated cost of the session, including every subagent session it spawned. Click the cell for a panel with all providers, quotas, provider-reported spend, a 90-day heatmap and the per-model breakdown.

- Runs locally only: one read-only loopback/same-origin HTTP route, no telemetry, no browser storage, no credential persistence.
- **No price table is compiled in.** Prices are fetched at runtime from the provider's own catalog, user catalogs, the official DeepSeek price page or `models.dev` — the UI always names the source and its confidence.
- No floating widget, no sidebar, no bundled artwork.

## Features (v0.2)

- **Model-following dock** — the balance target follows the model-selection directory
  (`ctx.modelDirectories`), so switching provider/model updates the balance immediately while the
  session cost keeps accumulating (switches never reset it).
- **Cumulative, whole-tree session cost** — tokens, costs and `byModel` cover the session plus every
  reachable subagent session; fork-inherited history (`seq < inheritedEventCount`) is skipped so a
  fork never double-bills its parent. `mixedProviders` flags cross-provider accumulation and
  `pricingConfidence` reports the weakest price source used (`exact | family | community | override | none`).
- **Multi-currency, never summed across currencies** — CNY and USD are shown side by side.
- **Peak / off-peak pricing** — official CNY prices are applied in the IANA `peakTimeZone`
  (default `Asia/Shanghai`), with configurable `peakWindows`, `peakWeekdays` and `holidays`.
- **Resilient transport** — bounded retries, per-provider `peerTimeoutMs`, a whole-handler
  `requestTimeoutMs`, `retryable`/`stale`/`degraded` flags, and `refresh=1` cache bypasses.
- **16 provider kinds** — DeepSeek (API key and desktop account), Moonshot, OpenRouter, xAI,
  Vercel AI Gateway, Z.ai, MiniMax, Kimi Coding, OpenCode, OpenAI and Anthropic admin spend,
  GitHub Copilot, OpenAI Codex OAuth, Volcengine Ark agent/coding plans. See
  [docs/providers.md](docs/providers.md).
- **90-day heatmap** with day bucketing in `statsTimeZone` and bounded session scanning.
- **Safe diagnostics** — `?kind=diagnostics` produces a redacted snapshot you can paste into an
  issue: no token/credential values, no account profile, no session content.

## Requirements

- DeepSeek Harness desktop with the browser `webServer` service (the plugin registers one route).
- Node.js 22 or newer in the host (24 recommended). The plugin has no npm dependencies and no build
  step; the browser half is a single `client.js` module-loader bundle.

## Install

Install through the harness — do **not** edit the profile's `package.json` or
`cordis.patch.yml` by hand. The plugin registers one read-only route and one composer-dock cell.

### From GitHub (recommended)

In a DSH session, ask the agent:

> Install the DSH plugin `github:YusenZhang0601/dsh-balance-usage-dock` with `plugin_manager`
> (`install_bundle`), enable it if it is disabled, then verify it loaded.

For a `dsh web` profile, the CLI equivalent is:

```bash
dsh plugin --profile web add github:YusenZhang0601/dsh-balance-usage-dock
```

### From a local checkout (development)

> Install the local DSH plugin at `<absolute path>/dsh-balance-usage-dock` with `plugin_manager`
> (`install_bundle`), enable it if it is disabled, then verify it loaded.

### After installing

`plugin_manager` reports whether a restart is required. Then:

1. `cordis_inspect_query` (Client → `Slots`) should list `conversation.composer.dock` with the
   `balance-usage` cell and `shell.overlay` with the `balance-usage-panel`.
2. Refresh the browser page. If installation returned `restart-required`, fully quit the desktop
   client (including the tray) and reopen it.

### From npm

Once the package is published: `dsh plugin --profile web add dsh-balance-usage-dock`, or the same
`plugin_manager` flow with the package name. Publishing is a manual workflow:
[`.github/workflows/publish.yml`](.github/workflows/publish.yml) (requires the `NPM_TOKEN` secret).

## Configuration (v0.2)

Every key is optional and lives in the plugin line's `config` (normally `cordis.patch.yml`); values
are clamped to the documented ranges. Full reference with examples: [docs/configuration.md](docs/configuration.md).

| key | default | meaning |
|---|---|---|
| `refreshSeconds` | `60` | Legacy polling hint retained for older clients (5–86400). |
| `statsDays` | `90` | Heatmap window in days (1–365); also exposed as `heatmapDays`. |
| `statsSessionLimit` | `200` | Max sessions scanned per stats pass (1–5000). |
| `statsCacheSec` | `300` | Server cache for `kind=stats` (0–86400). |
| `peakTimeZone` | `Asia/Shanghai` | IANA zone that defines the high-peak windows. |
| `statsTimeZone` | system zone (`null`) | IANA zone for daily bucketing; `null` = host zone. |
| `holidays` | `[]` | `YYYY-MM-DD` dates in `peakTimeZone` treated as all-day off-peak. |
| `peakWindows` | `09–12, 14–18` | Peak wall-clock windows in `peakTimeZone`. |
| `peakWeekdays` | `[1,2,3,4,5]` | Peak weekdays (0 = Sunday). |
| `pricingSources` | `provider-catalog, official-page, models.dev` | Enabled sources, in priority order. |
| `officialPricingUrls` | DeepSeek CN/EN price pages | Official page candidates (first valid table wins). |
| `modelsDevUrl` | `https://models.dev/api.json` | Community fallback catalog (USD, may lag). |
| `pricingTtlSec` | `43200` | Price cache TTL (3600–604800). |
| `priceOverrides` | `{}` | Manual prices, highest priority. |
| `modelAliases` | `{}` | `{ "normalized-model-id": "catalog-model-id" }` for pricing lookup. |
| `extraPriceCatalogs` | `[]` | `[{ url, format: openrouter\|newapi\|modelsdev, currency, ttlSec, matchPrefix? }]`. |
| `providers` | `[]` | Manual routes `{ id, kind, baseURL, apiKeyEnv, displayName, enabled }`. |
| `trustedHosts` | `[]` | Extra allowed `Host` values for the local route (loopback is implicit). |
| `requestTimeoutMs` | `15000` | Whole-handler deadline (1000–120000). |
| `peerTimeoutMs` | `12000` | Per-provider balance budget inside `overview`. |
| `overviewCacheSec` | `15` | Server cache for `kind=overview`. |
| `sessionCacheSec` | `1` | Micro-cache for `kind=session` per session id. |
| `warmup` / `warmupDelayMs` | `true` / `1500` | Best-effort precompute after boot. |
| `diagnosticsErrors` | `20` | Size of the redacted diagnostics error ring. |
| `clientRefresh` | `{overviewSec:60,sessionRunningSec:3,sessionIdleSec:15,statsSec:60}` | Browser TTLs (served via `kind=config`). |
| `clientRetry` | `{maxRetries:2,requestTimeoutMs:20000}` | Browser GET retry policy (served via `kind=config`). |

### Example

```yaml
- insert:
    - id: balance-usage-dock
      name: dsh-balance-usage-dock
      config:
        peakTimeZone: Asia/Shanghai
        statsTimeZone: America/New_York
        holidays: ["2026-10-01", "2026-10-02"]
        priceOverrides:
          "my-relay/deepseek-v4.1-flash":
            currency: CNY
            cacheHit: { idle: 0.02, peak: 0.04 }
            cacheMiss: { idle: 1, peak: 2 }
            output: { idle: 4, peak: 8 }
        modelAliases:
          "my-relay/fast": "deepseek-flash"
        trustedHosts: ["127.0.0.1:55976"]
```

## HTTP contract (summary)

The authoritative frozen contract is [docs/contract-v2.md](docs/contract-v2.md); implementation notes
are in [docs/architecture.md](docs/architecture.md).

- One route: `GET /balance-usage-api?kind=<kind>`, `GET` only, loopback/same-origin only,
  `cache-control: no-store`.
- Success: `{ "ok": true, "data": … }`. Failure: `{ "ok": false, "error": { "code", "message", "retryable" } }`
  where `bad-request` → 400 (guard rejections may use 403/405), `unavailable` → 503/504, `internal` → 500.
- Kinds: `config`, `overview`, `session&session=<id>`, `stats` (`refresh=1` bypasses the cache),
  `pricing` (`refresh=1` re-fetches sources), `diagnostics`, and `ping` (liveness).
- `overview` carries `degraded` and per-provider `retryable` / `fetchedAt` / `stale`;
  `session` carries `byModel`, `mixedProviders`, `pricingConfidence`; `stats` carries per-day
  `costs`, `pricingConfidence`, `scannedSessions`, `failedSessions`, `truncated`.

## Pricing and cost rules

- Resolution order: `priceOverrides` → provider catalog or `extraPriceCatalogs` → official DeepSeek
  page → `models.dev`. Every price records `source` and `confidence`; `none` means "no price source"
  and the UI shows tokens without a cost.
- Official prices are CNY per 1M tokens with idle/peak pairs. The parser validates
  `peak = 2 × idle` and degrades with a warning instead of trusting a half-parsed table.
- Usage is folded from `assistant/message.data.usage`; request time comes from the matching
  `step/start` (else the event time); provider/model come from `request/header` and
  `request/context` switches (last switch wins).
- Cost = `(input × cacheMiss + cacheRead × cacheHit + cacheWrite × cacheWrite + output × output) / 1e6`.
  Amounts are **estimates**, not an official bill.
- Currencies are never converted or added across; `byModel` always sums back to `costs` per currency
  (rounded to 6 decimals).

## Privacy

- No persistence in the browser: no `localStorage`, `sessionStorage`, `indexedDB`, cookies or
  filesystem writes; the client keeps an in-memory module store only.
- Credentials are resolved per request through `ctx.credentials` (or the `apiKeyEnv` environment
  fallback), never cached, logged or echoed. Responses never contain credential values, account
  profile data or session content.
- Outbound requests are limited to the price sources you enable and the providers you configured.
  See [docs/privacy.md](docs/privacy.md) for the full outbound host list and diagnostics redaction.

## Limitations

- **Estimates only.** Numbers are computed from local session events × runtime prices; provider
  billing, discounts and mid-turn price changes are not modelled.
- **Official price parsing is structural.** If the DeepSeek page changes shape the parser degrades
  (warning + last known table). Keep `priceOverrides` or `extraPriceCatalogs` as a fallback.
- `models.dev` is a community catalog and may lag; it is labelled `community` in the UI.
- Third-party relays usually expose neither balance nor price APIs: they show no balance, and cost
  needs `priceOverrides` / `extraPriceCatalogs`.
- Holiday handling is a static `holidays` list; it does not auto-import a calendar.
- Subagent rollup needs the `subagents` service; if it is missing the dock shows the parent session
  only (`subagent.unavailable: true`).
- The visual layer is verified by slot registration and API payloads; this repository has no browser
  automation.
- `openai-codex`, Volcengine Ark and GitHub Copilot adapters are fixture-tested, not live-account
  tested.

## Development and tests

```bash
# Full suite (fixtures only, no network, no external dependencies)
node --test test/*.test.mjs

# Same via npm (script defined in package.json)
npm test

# Syntax-check every shipped and test module
for f in index.js client.js lib/*.js test/*.test.mjs scripts/check.mjs; do node --check "$f" || exit 1; done

# Optional static consistency checks (file headers, no forbidden APIs, locale parity)
node scripts/check.mjs
```

Test files: `test/pricing.test.mjs`, `test/usage.test.mjs`, `test/http.test.mjs`,
`test/privacy.test.mjs`, `test/providers.test.mjs`; fixtures live in `test/fixtures/` and include a
trimmed snapshot of the official DeepSeek price table (source URL and date are recorded in the file).
CI runs Node 22 and 24 — see `.github/workflows/ci.yml`.

Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).
Release notes: [CHANGELOG.md](CHANGELOG.md).

## License and attribution

MIT — see [LICENSE](LICENSE). Provider-adapter coverage, session folding and the heatmap approach are
inspired by MIT-licensed DSH plugins listed in [ATTRIBUTION.md](ATTRIBUTION.md). DeepSeek prices are
read at runtime from the official price page; no price table is copied into this repository.
