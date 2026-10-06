# Implementation Plan: X (formerly Twitter) provider

**Branch**: `014-x-provider` | **Date**: 2026-10-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/014-x-provider/spec.md`

## Summary

Docket gains an `x` provider in its own folder, registered by one line. It is verified **with mocked HTTP only**, and every doc says so.

- **Connect.** An OAuth connect group `x` with `X_CLIENT_ID` / `X_CLIENT_SECRET` (G8). It is a confidential client: Basic auth on the token call, PKCE S256, scopes `tweet.read tweet.write users.read media.write offline.access`.
  1. The browser goes to `https://x.com/i/oauth2/authorize`.
  2. The callback exchanges the code at `https://api.x.com/2/oauth2/token`, then reads `GET /2/users/me`.
  3. It offers one candidate `@username` (external id = X user id) whose credentials hold both tokens, encrypted.

  The group declares HTTPS plus a public host (G10) and a `callbackHint` (G12). There is no paste fallback.
- **PKCE needs one generic change, G17.** `exchangeCode` now also receives the attempt's raw, already-validated `state`. X derives the verifier as `base64url(HMAC-SHA256(X_CLIENT_SECRET, "docket:x:pkce:v1:" + state))` in both `authorizationUrl` and `exchangeCode`, so nothing is stored and there is no schema change ([research D1](./research.md#d1-g17-carry-the-pkce-verifier-by-deriving-it-from-the-attempts-state)).
- **Renewal.**
  - `needsRefresh` fires within 5 minutes of the 2-hour access-token expiry, so the engine renews under its lease before a step (G2).
  - `refreshCredentials` stores X's **new single-use refresh token** every time.
  - The account's stored expiry is the refresh token's estimated 180-day life, so the scheduled refresh keeps idle accounts alive.
  - A readable OAuth refusal is `needs_reauth`. Anything else is transient, with a held `retryAt` (G11).
- **Counting.** A custom rule `x-weighted` (G9), written in-house from the twitter-text v3 values:
  - NFC;
  - URLs (with or without a scheme, from a TLD list in the folder) count 23;
  - RGI emoji graphemes count 2;
  - other code points count 1 or 2 by range.

  The limit is 280. `validate` adds a non-blocking drift warning above 270 when the text has a URL or emoji.
- **Publishing.** A pure, total step machine:
  - Text-only goes straight to `create_post`, the only `mayPublish` step.
  - Each image runs `upload_image_N` (initialize → one append → finalize, with one byte-carrying request), then `check_image_N` while processing is pending, then `describe_image_N` when it has alt text.
  - Next, `create_post` checks media expiry before sending, then sends `POST /2/tweets`.
  - Results:
    - any path where the create may have been executed (timeout, reset, 5xx, unreadable 2xx) is `ambiguous`;
    - 401 is retryable with `credentialsExpired`;
    - 403 is fatal (with a plain duplicate message);
    - 429 waits for `x-rate-limit-reset`, or at least an hour when it looks like a usage cap.
- **Limits.** 4 images, JPEG/PNG/WebP up to 5,000,000 bytes, alt text up to 1,000. The publish limit is 100 per 900 s.
- **Mark and docs.**
  - The X platform mark is regenerated from Simple Icons.
  - `docs/x-setup.md` opens with the "not checked against the real X API" notice.
  - limits, accounts, provider guide, decisions, README, index and nav are updated.
  - `.env.example` and the Unraid template gain the two empty variables. Compose is unchanged.

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS (planning checked on 24.16).

**Primary Dependencies**: all already installed (decision #19). **Nothing new.**

- Platform `fetch` (undici), `FormData`/`Blob` for the multipart append, `node:crypto` (`createHmac`, `createHash`) for PKCE, `Intl.Segmenter` and the `v`-flag `\p{RGI_Emoji}` regex for counting (checked on Node 24.16, research §1).
- zod 4 for credentials, settings, state and env.
- `simple-icons` 16.34.0 (dev dependency, already installed) has slug `x`.
- Next.js 16.3.8, used as before. Proxy runs on the Node.js runtime, so `authorizationUrl` may use `node:crypto` (research F3).
- No `twitter-text` (unmaintained, research), and no X SDK.

**Storage**: PostgreSQL 17. **No migration.** Existing columns only (data-model intro). Media bytes are read from the variant URL, as for Bluesky.

**Testing**: Vitest.

- Unit tests sit beside the code in `src/providers/x/`.
- Integration tests are in `tests/integration/x/`, against the real Postgres harness, using the DB clock instead of sleeps.
- A new `tests/helpers/fake-x.ts` stubs `fetch` ([contracts/x-api.md](./contracts/x-api.md)).
- **No live calls** (constitution II).

**Target Platform**: the existing `node:24-slim` image for `web` and `worker`. The worker bundle gains only pure TypeScript.

**Project Type**: the single Next.js app. `src/providers/**` stays a leaf: lint bans `src/server/**` imports, and X also imports no other provider folder (research D12).

**Performance Goals** (SC-002):

- A text post publishes in 1 step.
- An image post takes 1–3 steps per image (upload, plus processing checks only if X reports them, plus describe only if there is alt text), then 1 create step.
- Each step stays within `SCHEDULER_PROVIDER_TIMEOUT_SECONDS` (one signal for the step).
- Connect makes 2 requests (token, profile) within the 15 s connect timeout.
- Counting is O(length).

**Constraints**:

- No provider I/O inside a transaction. No sleeps or loops in `advance`.
- `create_post` is the only `mayPublish` step, and nothing is re-uploaded after it was sent.
- Tokens, the client secret, the code, the state and the verifier never reach the browser, logs, attempts, step state, `last_error`, messages or snapshots.
- Meta, Threads and Bluesky behaviour and tests are unchanged.

**Scale/Scope**:

- 1 new provider folder (~13 source files, ~10 test files).
- 1 generic change (G17), touching 2 framework files.
- 2 env vars.
- No new routes, pages or tables.
- Docs: `x-setup.md` (new), `limits.md`, `accounts.md`, `adding-a-provider.md`, `decisions.md`, `index.md`, README, `mkdocs.yml`, `.env.example`, `unraid/docket.xml`.

**Unknowns**: no `NEEDS CLARIFICATION` remains.

- Every value the research leaves UNVERIFIED (U1–U9) has an interim constant ([research D10](./research.md#d10-interim-values-one-constant-each-all-in-srcprovidersxconfigts)), mocked tests that accept both shapes ([research §3](./research.md#3-unverified-items-how-each-is-handled)), and a decisions entry.
- No `NEEDS RESEARCH` and no `NEEDS DEPENDENCY`.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (below).*

| Principle | Status | How this plan complies |
|---|---|---|
| I. Verified facts over memory | ✅ | Hosts, endpoints, scopes, PKCE parameters, token lifetimes, rate limits, media flow, alt-text limit, counting values and pricing come from `docs/research/x.md`. The Next proxy runtime comes from the bundled Next docs. Runtime features were checked on the installed Node. Request-vs-research disagreements are in the spec's table, and research wins. UNVERIFIED items carry interim constants and are never presented as facts. |
| II. Nothing is "working" unless it ran | ✅ | Every path has a mocked-HTTP test (quickstart §1–§3). X is reported as "verified with mocks only" in `x-setup.md`, `accounts.md` and decisions. No live check is planned or owed. |
| III. Project isolation | ✅ | No new table or query. Accounts, targets and connect attempts use the existing project-scoped repos. G17 passes the state only after the existing scope, role, user, session and consumption checks. |
| IV. One service layer | ✅ | The same connect service, validation path (`validateResolvedContent` via `countText`), refresh path (`applyRefreshResult`) and publish engine. Nothing is X-specific outside the folder. |
| V. Providers are plug-ins | ⚠️ justified | X is one folder plus one registry line. G17 is a one-field generic addition to `exchangeCode`'s input, which the spec classes as a framework gap. It is optional to use, tested with a throwaway group, recorded with a reversal, and has no schema change. Ambiguous-never-retried is kept: only `create_post` may publish, and every possibly-executed create is `ambiguous`. See Complexity Tracking. |
| VI. Boring, few dependencies | ✅ | No new dependency. `twitter-text` was deliberately not added (research D6). Built-ins only. |
| VII. Secrets never leak | ✅ | Both tokens are encrypted (AES-256-GCM, row AAD). Timestamps are numbers, so engine redaction keys on the tokens. The verifier is derived and never stored. Platform text is scrubbed and truncated. Summaries use an allow-list (data-model §6). A dedicated no-secrets integration test covers connect, refresh and every advance path. Env is Zod-validated through G8 and documented in `.env.example`. |
| Eng. constraints | ✅ | `runTick` stays bounded: one bounded unit per step, `continue` + `notBefore` for processing waits, no loops. No call inside a transaction. UTC epoch ms everywhere, with no wall-clock maths. UI change is the generated mark only (follows `docket-ui`: existing `ProviderIcon`). The constitution's "other platforms" scope line is lifted for X only, by this spec. |
| Workflow | ✅ | Conventional commits with explicit paths. Targeted tests per task. One final `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. `db:check` confirms no migration. Docs are deliverables (FR-036–FR-039). |

**Gate result: PASS.** The principle V deviation (G17) is justified below.

### Post-design re-check (after Phase 1)

Re-evaluated against [data-model.md](./data-model.md) and [contracts/](./contracts/):

- **Duplicate safety.**
  - `create_post` is the only `mayPublish` step, and lease recovery on it stays `recovered_ambiguous`.
  - The expiry guard returns `continue` before any request is built, so it cannot publish.
  - 401 and 429 on create are retryable only because X refused them unexecuted.
  - 5xx, lost, reset and unreadable 2xx on create are `ambiguous`.
  - After a create is sent, the result is terminal or a known-refused retry. State is never rewound past it.
- **Credentials.**
  - Refreshes are serialised by the existing refresh lease, so a single-use token is never sent twice at once.
  - Publish-time refresh happens outside `advance` (G2).
  - The G11 hold (5 min, or the rate reset) is short enough that `needsRefresh` + hold only delays publishing briefly (provider guide "refresh hold" note, research F7).
  - Removing the X env vars makes a refresh transient, not `needs_reauth`.
- **Authorization.** Start, callback and choose keep their existing server-side role checks. G17 adds no new entry point. Editors see no connect action.
- **Time.** All instants are UTC epoch ms or `Date`. Media `expiresAt` and the rate-limit reset are compared with the engine clock (`ctx.now`).
- **Secrets.**
  - The state is now handed to one more function, but it is already in the browser URL, and the no-secrets test treats it as secret anyway.
  - The verifier exists only in memory and in the token request body.
- **Scope (SC-007).** Outside `src/providers/x/`, tests, docs, `.env.example`, the Unraid template, the icon script and its generated file, `src/lib/docs.ts`, `mkdocs.yml` and specs, the code diff is:
  - the registry line (+ its test);
  - `src/providers/types.ts` and `src/server/services/connect.ts` (G17).

  No schema file changes.

**Re-check result: PASS.**

## Project Structure

### Documentation (this feature)

```text
specs/014-x-provider/
├── plan.md              # This file
├── research.md          # Phase 0: framework facts, design decisions D1–D14, interim constants
├── data-model.md        # Phase 1: credentials, settings, candidate, G17 flow, step state, summaries, env
├── quickstart.md        # Phase 1: offline validation guide
├── contracts/
│   ├── connect.md       # G17 and the X connect group
│   ├── providers.md     # xProvider against SocialProvider: refresh, steps, outcome table
│   └── x-api.md         # mocked HTTP shapes and the fake-x helper
└── tasks.md             # Phase 2 (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
src/providers/x/
├── index.ts             # xProvider (SocialProvider<XSettings, XState>)
├── config.ts            # hosts, scopes, interim constants (research D10), parseXEnv, requireXConfig
├── pkce.ts              # pkceVerifier(state, secret), pkceChallenge(verifier)
├── http.ts              # fetch wrapper: sent/not-sent/lost classification, JSON/form/multipart, rate headers, scrub
├── oauth.ts             # token call (exchange + refresh) and GET /2/users/me, typed outcomes
├── connect-group.ts     # xConnectGroup (contracts/connect.md)
├── credentials.ts       # XCredentials schema, readXCredentials, account expiry
├── refresh.ts           # needsRefresh, refreshX
├── settings.ts          # xSettingsSchema, xAccountNotes, postUrl
├── tlds.ts              # fixed TLD list for scheme-less URL detection
├── text.ts              # countXText, xCountingRule (x-weighted), URL/emoji helpers
├── capabilities.ts      # xCapabilities, X_DEFAULT_PUBLISH_LIMIT
├── validate.ts          # validateX
├── state.ts             # XState schema, parseXState
├── steps.ts             # xStepFor (pure, total)
├── publish.ts           # advanceX: upload / check / describe / create
└── *.test.ts            # config, pkce, oauth, connect-group, refresh, text, validate, steps, publish, settings

src/providers/registry.ts          # + one line (xProvider)
src/providers/registry.test.ts     # + x group assertions
src/providers/types.ts             # G17: exchangeCode input gains `state`
src/server/services/connect.ts     # G17: pass `state` to exchangeCode
src/server/services/generation/prompt.test.ts   # + X platform rules test (no prompt code change)
src/lib/docs.ts                    # DocPage + "x-setup"
src/components/ui/icons.generated.ts            # regenerated (pnpm icons)
scripts/generate-icons.mjs         # PROVIDERS + x: "x"

tests/helpers/fake-x.ts            # fetch stub for X (contracts/x-api.md)
tests/integration/x/
├── connect.test.ts
├── availability.test.ts
├── publish-e2e.test.ts
├── refresh.test.ts
└── no-secrets.test.ts
tests/integration/connect/state-to-exchange.test.ts   # G17, throwaway group
tests/integration/docs/provider-guide.test.ts         # G-mention check extended to G17
tests/integration/docs/x-docs.test.ts                 # x-setup notice first, U1–U9 listed, vars match .env.example, callback anchor exists

docs/x-setup.md (new) · docs/limits.md · docs/accounts.md · docs/adding-a-provider.md · docs/decisions.md
docs/index.md · README.md · mkdocs.yml · .env.example · unraid/docket.xml
```

**Structure Decision**: the existing single Next.js app. All X behaviour is in `src/providers/x/`, with tests beside it and under `tests/integration/x/`. G17 touches only the contract type and the one call site.

## Implementation notes for tasks

- **Order:**
  1. G17 (types, call site, throwaway-group test).
  2. config/pkce/http/oauth.
  3. credentials/refresh.
  4. connect group.
  5. text/tlds/validate/capabilities.
  6. state/steps/publish.
  7. index + registry line.
  8. Icons.
  9. Integration tests.
  10. Docs.
  11. Final pass.
- **Registry line:** `xProvider as SocialProvider` appended to the `providers` array, plus its import.
- **Icons:** run `pnpm icons` and do not hand-edit (FR-034). Expect one new `x:` line.
- **Env block in `.env.example`:** match the Threads block's format ("# Group. …", "# No default."). Comment: "Leave X_CLIENT_ID and X_CLIENT_SECRET empty to disable. X needs an HTTPS callback address on a public host; see docs/x-setup.md".
- **Unraid:** add, after the Threads fields, two `<Config>` entries ("X Client ID", `X_CLIENT_ID`, `Mask="false"`; "X Client Secret", `X_CLIENT_SECRET`, `Mask="true"`), each `Default=""`, `Required="false"`, `Display="advanced"` and empty value. The implement phase must report the exact XML added (owner's standing note on template changes). `docker-compose.yml` is unchanged.
- **`docs/x-setup.md` anchors:** at least `## Callback address` (→ `#callback-address`, used by G10's `doc`). The rest follows FR-036, in the style of `docs/meta-setup.md`.
- **`docs/limits.md`:**
  - a `## X` section with the rows `text length | 280 | x-weighted (custom rule)`, `images | 4`, `bytes per file | 5000000`, `formats | image/jpeg, image/png, image/webp`, `alt text length | 1000`, `media required | no`, `text only | yes`, `publish limit | 100 / 900 s`;
  - each row's Source is `docs/research/x.md`, and its Test is `tests/integration/limits/enforcement.test.ts` "x: <category>";
  - the per-app 10,000 / 24 h limit is not enforced, so it is mentioned in the audit notes text, not as a row (every row must name its enforcement point).
- **`docs/decisions.md` "014 — X":**
  - G17 (what/why/reverse);
  - every request-vs-research disagreement;
  - the interim constants of research D10;
  - "refresh success without a refresh token keeps the old one";
  - the self-contained folder (D12);
  - "verified with mocks only; no live check is owed".

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Principle V: a framework change (G17, `exchangeCode` receives `state`) in a provider feature | X requires PKCE. The verifier must be the same at authorize and exchange time, and today nothing per-attempt reaches `exchangeCode` (research F1). | An encrypted verifier column on `connect_attempts` is a schema change plus migration for one provider. A cookie breaks G5's multi-instance and binding guarantees. PKCE `plain` with the state would expose the verifier in the browser. The added field is optional to use, so existing groups are unaffected. |
