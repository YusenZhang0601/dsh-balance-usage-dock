# Contributing

Thanks for helping improve `dsh-balance-usage-dock`. This is a small, zero-dependency DSH plugin;
small focused pull requests are easiest to review.

## Development setup

- Node.js 22 or newer (CI runs 22 and 24). No `npm install` is needed — there are no runtime or dev
  dependencies, and there is no build step.
- A checkout of the repository is enough for the tests:

```bash
node --test test/*.test.mjs
```

The suite is fully offline: price pages and provider responses are fixtures/stubs under `test/`.

## Repository layout

| path | contents |
|---|---|
| `index.js` | Cordis plugin entry and config resolution/clamping. |
| `lib/http.js` | Route registration, loopback/same-origin fence, deadline, error envelope. |
| `lib/api.js` | Handler map (`config`, `overview`, `session`, `stats`, `pricing`, `diagnostics`, `ping`) and server caches. |
| `lib/providers.js` | Route discovery, kind classification, balance/quota/spend engine. |
| `lib/adapters.js` | One isolated adapter per provider family; bounded HTTP client; price catalogs. |
| `lib/pricing.js` | Runtime price resolution, official-page parser, peak/holiday predicate. |
| `lib/usage.js` | Session event fold, fork/subagent rules, 90-day stats. |
| `client.js` | Browser module-loader bundle (React only), in-memory store, scheduler, UI. |
| `locale/*.json` | `en`/`zh` dictionaries; key sets must stay identical. |
| `docs/` | Contract, architecture, configuration, providers and privacy docs. |
| `test/` | `node:test` suites and fixtures. |

`docs/contract-v2.md` is the frozen wire contract. Do not change it or the public payload shapes
without agreement in the pull request; add a new contract section instead when needed.

## Tests

- Every behavior change should come with a test in the matching file:
  `pricing.test.mjs`, `usage.test.mjs`, `http.test.mjs`, `privacy.test.mjs`, `providers.test.mjs`.
- **Fixtures must be synthetic or trimmed from public docs with provenance.** Do not commit real
  credentials, account data, session content or unredacted provider responses. Trimmed page fixtures
  must keep a header comment with source URL, fetch date and "trimmed for testing" (see
  `test/fixtures/official-pricing.html`).
- `test/privacy.test.mjs` is a gate, not a formality: it scans all shipped `.js`/`.json`/`.yml` for
  forbidden storage/filesystem/profile APIs and credential literals. If your change legitimately needs
  a new pattern, update the gate and the docs together.
- The browser bundle may only `require('react')` (checked by the privacy suite).
- Run the syntax check locally before pushing:

```bash
for f in index.js client.js lib/*.js test/*.test.mjs scripts/check.mjs; do node --check "$f" || exit 1; done
```

## Adding a provider adapter

1. Add an isolated async `query({ route, apiKey, fetchJson, now, ctx, resolveCredential })` entry to
   `ADAPTERS` in `lib/adapters.js`, returning a row fragment
   `{status, message, balances, usages, spend}` (use the `rowResult`/`balanceEntry`/`usageEntry`/
   `spendEntry` helpers).
2. Never read credentials or log secrets inside an adapter; accept the resolved `apiKey`/credential
   resolver. Throw on transport errors (the engine classifies them), or return a classified status for
   expected failures (401/403, missing subscription, unsupported).
3. Map the route id in `lib/providers.js` (`ROUTE_ID_KINDS`) and, if needed, a URL heuristic in
   `BASEURL_KIND_RULES` plus a `KNOWN_ROUTES` fallback entry.
4. Add the kind to `docs/providers.md` (endpoint, auth, fields, status behavior).
5. Add a fixture-driven test in `test/providers.test.mjs` covering the happy path and at least one
   failure/status path.
6. If the provider exposes a price catalog, return it via `getProviderPrices` / `extraPriceCatalogs`
   rather than hard-coding prices anywhere.

## Changing session accounting

- Read events through the host services only (`sessions` → `sessionController` → `sessionQuery`), and
  keep the fork rule: events with `seq < inheritedEventCount` are skipped.
- Tokens come only from `assistant/message.data.usage`; keep `byModel` additive (per-currency sums must
  equal `costs`) and keep `stats` per-session so subagent spend is not double-counted.
- If you touch payload fields, update `docs/contract-v2.md`, the README summary, the docs, and the
  usage tests together.

## Localisation and UI

- Add keys to **both** `locale/en.json` and `locale/zh.json` (and to the bundled fallback dictionaries
  in `client.js` if you add a new string). Missing keys fail the privacy/key-parity test.
- The panel/dock must keep working on stale payloads: failures show a retrying state, never a blank
  screen or a thrown error boundary.
- Keep the client half dependency-free (React only), and keep all data in the in-memory module store.

## Style

- Plain ESM, 2-space indentation, semicolon-free style, single quotes; JSDoc on non-obvious functions.
- No runtime dependencies, no build step, no telemetry. The host half must stay loadable with plain
  `node --check`.
- Do not add `@deepseek-ai/*` imports; access host services through `ctx.get(...)` with
  `typeof fn === 'function'` probes.
- Keep comments useful; avoid mentioning forbidden API names in comments (the CI grep gate scans raw
  text).

## Pull requests

- Describe the behavior change, the tests you ran (`node --test test/*.test.mjs`), and any follow-up
  work.
- Keep unrelated formatting changes out of the diff; one topic per PR.
- CI must pass on Node 22 and 24 before merge.
- By contributing you agree your changes are licensed under the repository's MIT license
  ([LICENSE](LICENSE)). Existing attribution in `ATTRIBUTION.md` must be preserved.

Be respectful and constructive in reviews and issues.
