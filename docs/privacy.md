# Privacy

This plugin exists to read numbers, not to collect them. This document lists exactly what it can
access, what it sends, where it sends it, and what is guaranteed by tests.

## Design principles

1. **No persistence.** Neither half writes anything to disk, browser storage or cookies. All state is
   in-memory and disappears when the host process or browser page stops.
2. **Least data.** The host reads session metadata/usage locally; responses contain derived numbers
   (tokens, costs, balances, quotas) — never prompts, messages, tool output or account profiles.
3. **Credentials stay credentials.** The plugin never stores a secret value in config. It resolves a
   *reference* per request and uses it only as an authorization header for that provider.
4. **No telemetry.** No analytics, no crash reporting, no remote logging.
5. **Read-only surface.** The browser talks to exactly one same-origin, `GET`-only route.

## What is stored (memory only)

| side | in-memory data | lifetime |
|---|---|---|
| browser (`client.js`) | module store entries: `config`, `overview`, `session:<id>`, `stats`, `pricing`, `selection` (provider/model/session id only) | until the page reloads |
| host (`lib/api.js`) | overview payload cache, per-session usage cache, stats cache, diagnostics error ring | until the host restarts |
| host (`lib/pricing.js`, `lib/providers.js`) | parsed price tables, provider result fragments, resolution cache | TTL-bounded, memory only |

No session event is persisted by the plugin; session events are read through the host services
(`ctx.get('sessions')`, `sessionController`, `sessionQuery`) and folded into totals in memory.

## What is read locally

- Session events (tokens, timestamps, provider/model of each step, turn/step numbering, subagent ids)
  via the host session services.
- Provider routes, base URLs and credential **references** via the host `llm` / `configEditor` /
  `credentials` services.
- Plugin configuration.

The plugin does not read message text for display, credentials values beyond the outbound header, the
account profile, or any other profile data.

## Outbound network requests

Every outbound request is HTTPS and originates from the host half. The browser never contacts a third
party; it only fetches the same-origin `/balance-usage-api` route.

| destination | when | data sent |
|---|---|---|
| `api-docs.deepseek.com` (or `officialPricingUrls`) | price refresh (`pricingTtlSec`) | plain `GET`, no credential |
| `models.dev/api.json` (or `modelsDevUrl`) | price fallback refresh | plain `GET`, no credential |
| URLs in `extraPriceCatalogs` | price refresh | plain `GET`, no credential |
| `api.deepseek.com` | `overview` for a DeepSeek route | Bearer API key |
| `api.moonshot.cn` / `api.moonshot.ai` | Moonshot balance | Bearer API key |
| `openrouter.ai` | OpenRouter credits + model catalog | Bearer API key |
| `api.x.ai` / `management-api.x.ai` | xAI balance | Bearer API key |
| `ai-gateway.vercel.sh` | Vercel AI Gateway credits | Bearer API key |
| `api.z.ai` / `open.bigmodel.cn` | Z.ai quota limits | API key header |
| `api.minimax.io` / `api.minimaxi.com` | MiniMax coding-plan remains | Bearer API key |
| `api.kimi.com` | Kimi Coding usage | Bearer API key |
| `opencode.ai` | OpenCode usage | Bearer API key |
| `api.openai.com` | OpenAI admin cost report | Bearer admin key |
| `api.anthropic.com` | Anthropic admin cost report | `x-api-key` |
| `api.github.com` | GitHub Copilot quota | `token` header |
| `chatgpt.com` | OpenAI Codex usage | Bearer OAuth access token |
| `auth.openai.com` | Codex OAuth token refresh (only when the grant is near expiry) | OAuth refresh token in a form-encoded body |
| `open.volcengineapi.com` | Volcengine Ark quota (signed `POST`) | IAM AK/SK signature, empty JSON body |
| any `config.providers[].baseURL` | manual routes | the credential referenced by `apiKeyEnv` |

Provider calls are inherent to the feature: if you configure a provider, the plugin contacts that
provider. Only enable the providers you trust. `priceSources` and `extraPriceCatalogs` can be trimmed
to remove any price endpoint you do not want contacted.

The client never uses `WebSocket`, `EventSource`, `XMLHttpRequest`, `sendBeacon` or cross-origin
`fetch`; it also sends `cache: 'no-store'` on every request.

## Credentials

- Resolution: `ctx.credentials.resolve(ref)` first, `process.env[ref]` second.
- Usage: passed as an authorization header (or signature input) to the provider's own API.
- Never: written to config, cached by the plugin, included in a response payload, included in logs,
  included in diagnostics, or echoed in an error message.
- `openai-codex` refreshes a rotating OAuth grant and writes the rotated record back through the host's
  `credentials.modifyRecord()` — the host owns that storage. The plugin itself performs no file write.
- Error sanitisation in `lib/http.js` masks `sk-…` and `Bearer …` fragments and strips URL query
  strings before a message reaches a response or log.

## Diagnostics (`kind=diagnostics`)

Designed to be pasted into a public issue. It contains:

- plugin name/version, DSH profile name (or `null`);
- capability booleans (which host services are available, `null` when unknown);
- price summary: source, fetch time, staleness, warning, configured source names;
- provider counts by status (`{ total, byStatus }`);
- the last `diagnosticsErrors` failures as `{ code, message, at }` (messages already sanitised);
- configuration summary: refresh seconds, stats window/limit, price TTLs, `peakTimeZone`,
  `statsTimeZone`, holiday **count**, source names, extra-catalog count, configured-provider count,
  warmup flag;
- `generatedAt`.

It never contains: token or credential values, credential records, account profile/email/phone,
session content, or request URLs with query secrets. Credential **reference names** (e.g.
`DEEPSEEK_API_KEY`) may appear inside an error message; values may not.

Even so, review the payload before posting it publicly — timestamps and provider ids reveal usage
patterns.

## Local HTTP surface

`GET /balance-usage-api?kind=…` only. `lib/http.js`:

- rejects anything but `GET` (405);
- requires a loopback `Host` (`127.0.0.1`, `localhost`, `[::1]`, `::1`) or an explicit `trustedHosts`
  entry (403);
- rejects a mismatched/malformed `Origin` and `Sec-Fetch-Site: cross-site` (403);
- answers with `cache-control: no-store`, `x-content-type-options: nosniff`,
  `referrer-policy: no-referrer`;
- enforces `requestTimeoutMs` and sanitises failure messages;
- never enables CORS.

`trustedHosts` is an explicit opt-in and widens the fence; leave it empty unless you need a specific
reverse proxy host.

## What is enforced by tests

`test/privacy.test.mjs` scans every shippable `.js`/`.json`/`.yml` (`index.js`, `client.js`, `lib/**`,
`locale/**`, `package.json`, `cordis.patch.yml`) and fails if it finds:

- `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, `writeFile`, `appendFile`,
  `createWriteStream`, `storageDomain`;
- `getProfile`;
- obvious credential literals (`sk-…`, `ghp_…`, `github_pat_…`, `AKIA…`, `xox?-…`);
- a client bundle that is not `window.__ModuleLoader__.load` with the package name as id, requires
  anything other than `react`, or references `@deepseek-ai/`;
- non-GET/non-local/alternate-transport requests from `client.js`;
- locale files that lost `meta.title`/`meta.description` or have diverging key sets.

`.github/workflows/ci.yml` runs the same forbidden-API gate as a plain grep on every pull request, so
a regression fails CI even if the test file is edited.

## Limitations

- The plugin can read local session usage metadata because that is the feature; anyone with access to
  the host process or the browser memory can read the same data.
- Network observers and providers see the traffic the plugin makes, exactly as any client of those
  APIs would.
- Provider-side logs are outside this plugin's control.
- In-memory caches can be dumped by a compromised host; do not run untrusted plugins alongside this
  one if that matters to you.

Report a privacy or security issue per [SECURITY.md](../SECURITY.md).
