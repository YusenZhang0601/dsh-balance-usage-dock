# Security policy

## Supported versions

| version | supported |
|---|---|
| `0.2.x` | yes |
| `0.1.x` | no (upgrade to 0.2) |

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue:

1. Open a private security advisory in the repository's **Security → Advisories → Report a
   vulnerability** flow (GitHub private advisory). Include the affected version, a description, and a
   minimal reproduction if possible.
2. If you cannot use the advisory flow, open a normal issue that only asks the maintainers to contact
   you privately — do not include vulnerability details, credentials or session data in a public issue.

Never attach real API keys, OAuth grants, account data or session transcripts. Redact balances/usage
unless they are synthetic.

We aim to acknowledge reports within 7 days and to publish a fix or mitigation plan within 30 days for
confirmed issues. Please allow coordinated disclosure; we will credit reporters (unless you prefer to
stay anonymous) once a fix ships.

## In scope

- Credential or token leakage through responses, logs, diagnostics, error messages, fixtures or docs.
- Bypass of the local HTTP fence (non-loopback/non-same-origin access, non-GET requests) or of
  `requestTimeoutMs`.
- Persistence or exfiltration regressions: browser storage/cookies, filesystem writes, telemetry,
  non-local client fetches.
- Account-profile leakage (`getProfile` or equivalent) or inclusion of session content/prompts in any
  payload.
- Server-side request forgery through user-controlled `baseURL` / `extraPriceCatalogs` that reaches
  unintended hosts, or credential forwarding to a host other than the configured provider.
- XSS or DOM injection in the dock/panel (localised strings, provider `message`/labels, amounts).
- Supply-chain issues in the zero-dependency package surface (`package.json` `files`, `exports`).

## Out of scope

- Accuracy of estimated costs or price parsing (that is a functional bug; use a normal issue —
  estimates are documented as non-authoritative).
- Provider API behavior, rate limits, billing disagreements or account suspension.
- Issues in DeepSeek Harness itself or in other plugins — report those upstream.
- Attacks that already require control of the host process, the browser profile or the DSH profile
  configuration (such an attacker can read the same data directly).

## Privacy guarantees (summary)

- No persistence: no browser storage/cookies, no filesystem writes in shipped code; in-memory caches
  only.
- Credentials are resolved per request through the host credential service (or `apiKeyEnv` environment
  fallback), never cached, logged or returned.
- Responses and diagnostics never include credential values, account profile data or session content;
  error messages are sanitised (URL query stripped, `sk-…`/`Bearer …` masked).
- The local route is `GET`-only, loopback/same-origin only, `cache-control: no-store`, no CORS.
- The browser client only fetches the same-origin plugin route; it has no analytics, WebSocket,
  EventSource or `sendBeacon` path.
- `test/privacy.test.mjs` and the CI privacy grep enforce the static privacy invariants on every
  pull request.

Full details, including the outbound host list and diagnostics fields, are in
[docs/privacy.md](docs/privacy.md).

## Hardening recommendations

- Keep `trustedHosts` empty unless you need a specific reverse-proxy host.
- Trim `pricingSources` / `extraPriceCatalogs` to the endpoints you actually trust.
- Use dedicated, least-privileged keys for admin-scoped kinds (`openai`, `anthropic`).
- Review a diagnostics payload before pasting it into a public issue; it is redacted but still reveals
  provider ids, statuses and timestamps.
- Keep DeepSeek Harness and Node.js (≥22) up to date.
