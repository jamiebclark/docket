# Quickstart: validating the Threads provider

**Feature**: `006-threads-provider` | **Plan**: [plan.md](./plan.md)

Everything in §1–§6 runs with **mocked HTTP only** (constitution II) and reports "verified with mocks only". §7 is the local HTTPS walk-through, and §8 is the owner's live check after merge.

## 0. Prerequisites

- Node 24, pnpm, and the test Postgres from the 001–005 harness (`docker compose up -d postgres` or the CI service).
- `.env` copied from `.env.example`. The Threads variables may stay empty for §1–§6, because tests set their own env.
- No real Threads app, tester account or network access is needed.

## 1. Counting and validation (US5, G9)

```bash
pnpm vitest run src/providers/threads/text.test.ts src/providers/threads/validate.test.ts src/providers/text.test.ts src/providers/validation.test.ts
pnpm vitest run tests/integration/compose-check-route.test.ts tests/integration/compose/counting-rule.test.ts
```

Expected:

- The counts match [research D3](./research.md#d3--counting-rule-fr-020-r9-interim): 😀 = 4, 👍🏽 = 8, family = 25, 🇫🇷 = 8, keycap = 7, é = 1, 日 = 1, ☺ = 3, © = 2.
- 500 is allowed and 501 is `text_too_long` with emoji.
- 20/21 images, widths 319/320/1440/1441, 8,000,000/8,000,001 bytes, aspect 10:1 both ways and alt text 1,000/1,001 behave as in [data-model](./data-model.md).
- The composer check's `count` equals the validator's count for each string (throwaway custom-rule provider and `threads`).

## 2. Connect, paste and the HTTPS requirement (US1, US7, G10, G12, G13)

```bash
pnpm vitest run src/providers/threads/oauth.test.ts src/providers/threads/config.test.ts src/providers/connect.test.ts
pnpm vitest run tests/integration/threads/connect.test.ts tests/integration/threads/paste.test.ts tests/integration/connect tests/integration/accounts-ui.test.ts tests/integration/actions-authz.test.ts
```

Expected:

- The authorize URL is on `threads.com`, with both scopes, the state and the HTTPS callback.
- An `http://` or `localhost` `BETTER_AUTH_URL` shows "Threads needs an HTTPS address that is not localhost.", start is refused before any state row, and the paste form is still shown.
- A callback runs code → short-lived → long-lived → `/me`, and the chooser shows `@user`. Choosing saves one row, which is updated in place on reconnect.
- The callback banner for a failed Threads login includes the tester-invite hint.
- Paste branches (a)–(d) and the network-stop rule (research D6). An estimated expiry shows on the chooser and the account card.
- Editors are refused everywhere on the server.
- The Facebook/Instagram connect suites pass unchanged.

## 3. Token renewal (US4, G11)

```bash
pnpm vitest run src/providers/threads/refresh.test.ts tests/integration/threads/refresh.test.ts tests/integration/scheduler/token-refresh-hold.test.ts
pnpm vitest run tests/integration/bluesky
```

Expected:

- With the DB clock set, a 50-day-old token in the window is renewed (one request, new ciphertext, expiry about +60 d).
- A refusal → `needs_reauth` with no token in the reason.
- A 5xx → stays `active`.
- An unreadable 2xx → transient, old credentials kept.
- A token under 24 h → no request, parked until issue + 24 h.
- An expired token → no request, `needs_reauth`.
- The Bluesky refresh tests are unchanged.

## 4. Step machine and outcomes (US2, US3)

```bash
pnpm vitest run src/providers/threads/steps.test.ts src/providers/threads/quota.test.ts
pnpm vitest run tests/integration/threads/publish-e2e.test.ts tests/integration/threads/carousel.test.ts tests/integration/threads/container-status.test.ts tests/integration/threads/outcomes.test.ts
```

Expected:

- Text, image and five-image carousel publish through the real `runTick` in 4 / 4–5 / 9 ticks.
- `notBefore` is used (no sleeps): first check +30 s, then +60 s, and a 5-minute cap.
- `ERROR` → fatal; `EXPIRED` → recreated at most twice; `PUBLISHED` → ambiguous.
- The publish timeout, reset, 5xx, unparseable and missing-id cases → `ambiguous`. A rate limit → retryable. A rejection → fatal. A pre-send failure → retryable.
- 190 → `needs_reauth`. A mismatched state restarts.

## 5. Limits (US6)

```bash
pnpm vitest run tests/integration/threads/limits.test.ts
```

Expected:

- 250 starts in the window → the 251st waits with no request (300-target run, SC-006).
- Quota full → retry ≥ 1 h with no publish request.
- An unreadable quota → proceeds, with summary `quota: "unknown"`.
- A container aged ≥ 23 h at the quota step → recreated.

## 6. No secrets and scope (FR-033, SC-008, SC-009)

```bash
pnpm vitest run tests/integration/meta/no-secrets.test.ts tests/integration/meta/engine-unchanged.test.ts tests/integration/facebook tests/integration/instagram src/providers/meta
git diff --stat main -- . ':!src/providers/threads' ':!src/providers/meta' ':!tests' ':!docs' ':!specs' ':!README.md'
```

Expected:

- The fake token, secret and code never appear in plaintext columns, attempts, step state, `last_error`, responses, rendered HTML or console output.
- The Facebook and Instagram suites pass with unchanged expectations.
- The diff outside the allowed paths is only the registry line and the G9–G13 files listed in [plan.md § Project Structure](./plan.md#source-code-repository-root), plus `.env.example`, `.gitignore` and the `dev:https` script.

Final gates, once per implement phase: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. No migration, so `pnpm db:check` reports "Migrations are current".

## 7. Local HTTPS walk-through (US8, manual, not run by the pipeline)

Follow `docs/meta-setup.md` → "Local HTTPS for Threads":

1. Add `127.0.0.1 docket.local` to `/etc/hosts` (on Windows, `C:\Windows\System32\drivers\etc\hosts`).
2. `mkcert -install`, then `mkdir -p certificates && cd certificates && mkcert docket.local`. This is the same command `docs/meta-setup.md` already gives. It writes `docket.local.pem` and `docket.local-key.pem`; if your mkcert names them differently, point the script's flags at the files it printed.
3. Set `BETTER_AUTH_URL=https://docket.local:3000` and run `pnpm dev:https` (`next dev --experimental-https --experimental-https-key … --experimental-https-cert … -H docket.local`).
4. Open `https://docket.local:3000`: no certificate warning, and sign in again.
5. On Accounts, the Threads section shows **Connect Threads**, not the HTTPS warning.

Expected: SC-002 (under 15 minutes). The pipeline cannot run this. It is reported as not verified until a person does it.

## 8. Owner's live check (after merge)

With a real Threads app id and secret, an accepted tester and a public bucket:

1. Connect via OAuth.
2. Publish a text post, an image post and a 3-image carousel.
3. Confirm they appear on Threads.
4. Optionally set the DB expiry inside the window and confirm a renewal.
5. Check U1 by setting `THREADS_GRAPH_BASE=https://graph.threads.net`.
6. Check U2 by pasting a generator token.

Record "verified live on <date>" in `docs/decisions.md`.
