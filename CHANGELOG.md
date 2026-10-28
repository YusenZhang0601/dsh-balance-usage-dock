# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [Semantic
Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-10-28

v0.2 is the "model-follow + resilient host/client split" release. The frozen wire contract lives in
[docs/contract-v2.md](docs/contract-v2.md).

### Added

- **Dock follows the model selection.** The browser subscribes to
  `ctx.modelDirectories.directoryFor(sessionId).store` and publishes `{provider, model}` from the
  snapshot (`pending ?? current`); the balance target is `selection.provider` → `session.provider` →
  `overview.active`. Switching provider/model refreshes the balance without resetting the cumulative
  session cost.
- **Per-model session breakdown.** `kind=session` now returns `byModel[]` (tokens, costs, price source
  and confidence per provider/model) plus `mixedProviders` and `pricingConfidence`
  (`exact | family | community | override | none`). `byModel` amounts sum back to `costs` per currency.
- **`kind=config`** (non-sensitive browser tuning: `pluginVersion`, `refresh.*`, `retry.*`,
  `heatmapDays`) and **`kind=diagnostics`** (redacted, paste-safe snapshot: capabilities, price
  summary, provider counts, error ring, config summary).
- **`pricing` payload additions:** `peak.timeZone` (IANA; `timeZoneOffsetHours` kept for back-compat),
  `peak.holidays`, `modelsDev`, `extraCatalogs`, and per-model `confidence`.
- **Config additions:** `peakTimeZone`, `statsTimeZone`, `holidays`, `modelAliases`,
  `extraPriceCatalogs`, `requestTimeoutMs`, `peerTimeoutMs`, `overviewCacheSec`, `sessionCacheSec`,
  `warmup`, `warmupDelayMs`, `diagnosticsErrors`, `clientRefresh`, `clientRetry`.
- **Runtime price sources:** user `extraPriceCatalogs` (OpenRouter, New API relay and models.dev-shaped
  JSON), normalized `modelAliases`, and confidence labels on every resolved price.
- **Resilient host transport:** whole-handler `requestTimeoutMs` deadline (504 `unavailable`), per-provider
  `peerTimeoutMs` budget, bounded adapter retries (408/425/429/5xx + transient network), 30 s provider
  result cache with `stale` marking, 5 min provider price cache, `kind=overview` `degraded` flag and
  per-provider `retryable`/`fetchedAt`/`stale`, `refresh=1` cache bypasses for overview/session/stats.
- **Browser data layer:** a single in-memory module store (`config`, `overview`, `session:<id>`, `stats`,
  `pricing`, `selection`), one 1 s scheduler tick while subscribers exist, pause while
  `document.hidden`, immediate revalidation on focus/visibility, server-driven TTLs, GET-only retries
  with exponential backoff (2 s → 4 s → … capped at 60 s), stale payloads kept on screen, and
  per-key `retrying`/`error` state.
- **Warmup:** best-effort overview + stats + pricing precompute after boot (`warmup`, `warmupDelayMs`).
- **Documentation set:** English `README.md` (default), `README.zh.md`, `docs/architecture.md`,
  `docs/configuration.md`, `docs/providers.md`, `docs/privacy.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  `CHANGELOG.md`, and the frozen `docs/contract-v2.md` reference.
- **Test suite** (`node:test`, zero dependencies): pricing, usage, HTTP, privacy and provider-adapter
  suites plus fixtures, including a trimmed official DeepSeek price-table snapshot with provenance.
- **CI** (`.github/workflows/ci.yml`): Node 22/24 matrix, `node --check` over all JS, `node --test`,
  and a static privacy grep gate. No build step.

### Changed

- Peak/off-peak evaluation now uses an IANA `peakTimeZone` (default `Asia/Shanghai`) via
  `Intl.DateTimeFormat` instead of a fixed offset; holidays can force all-day off-peak.
- Stats day bucketing uses `statsTimeZone` (default: host system zone) instead of a fixed +8 offset.
- Error envelopes now always include `retryable`; 503/504 map to `unavailable`, other 5xx to `internal`,
  and guard rejections keep `bad-request` with 403/405.
- `kind=overview` responses gain the fields above; providers are sorted active-first then by name.
- Session costs for multi-currency accounts stay a `costs[]` list (no cross-currency summing), and
  `priceSource`/`pricingConfidence` describe the weakest source used.
- Package: version `0.2.0`, `engines.node >= 22`, `files` includes the docs set, `test`/`check`
  scripts, and a public (`private: false`) package metadata block.

### Fixed

- Forked sessions no longer double-count inherited history (`seq < inheritedEventCount` is skipped for
  the session and for every subagent session).
- Subagent usage rolls up into the session totals while `stats` stays per-session, so the heatmap never
  double-counts child spend.
- A provider failure or timeout degrades only that provider row (never the whole overview); a handler
  deadline returns a retryable `unavailable` instead of hanging the request.
- Official price parsing degrades with a warning (and keeps the last good table) instead of trusting a
  table that violates `peak = 2 × idle`.
- Error messages returned to the browser are sanitised (`sk-…`/`Bearer …` masked, URL query stripped,
  bounded length).
- Client-side refresh failures keep the last good payload and show a retrying state instead of
  blanking the dock.

### Security

- Local route stays `GET`-only, loopback/same-origin, `cache-control: no-store`,
  `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `trustedHosts` opt-in only.
- Static privacy gate in tests and CI: no browser storage/cookies, no filesystem writes, no
  `getProfile`, no credential literals, only `react` required by the client bundle, no non-local or
  non-GET client fetches, locale key parity.
- Credentials remain per-request (host credential service with `apiKeyEnv`/env fallback), never cached,
  logged, echoed or included in diagnostics; rotated OpenAI Codex grants are written back through the
  host credential store only.

## [0.1.0] — initial release

- Composer dock cell (`conversation.composer.dock`, id `balance-usage`) with the active provider
  balance and the estimated session cost, plus an overlay panel (`shell.overlay`, id
  `balance-usage-panel`) with provider balances/quotas/provider-reported spend, today/7/30/90-day
  totals and a 90-day heatmap.
- Runtime pricing from provider catalogs, the official DeepSeek price page and `models.dev`, with
  `priceOverrides`; no price table compiled into the plugin.
- Session event fold with fork-prefix skipping, subagent rollup, per-day aggregation and in-memory
  caching.
- Provider adapters: DeepSeek (API key + desktop account), Moonshot, OpenRouter, xAI, Vercel AI
  Gateway, Z.ai, MiniMax, Kimi Coding, OpenCode, OpenAI/Anthropic admin spend, GitHub Copilot, OpenAI
  Codex OAuth and Volcengine Ark agent/coding plans.
- Read-only loopback/same-origin HTTP route with `cache-control: no-store`; credentials resolved per
  request and never persisted.
