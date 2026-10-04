# Quickstart: validating 010 Hardening

This file lists the runnable checks that prove the feature works. Each one maps to requirements and names the tests that cover it. Commands run from the repo root against the local Postgres `_test` database, as in earlier entries.

Run the targeted files per task. Run the full gate once, at the end of implement (constitution, "Run checks in proportion").

## 0. Prerequisites

- Node 24 and pnpm. Dependencies are already installed; this feature adds **none**.
- A Postgres 17 instance with `DATABASE_URL` pointing at a database whose name ends in `_test`.
- For §7 only: Docker with Compose v2. If Docker is unavailable, §7 is reported **not verified**, with the steps left ready (research U6).

## 1. Failures view (US1; FR-001–FR-013; SC-001–SC-003)

```bash
pnpm vitest run tests/integration/failures src/server/services/failures.test.ts
```

| Scenario | Test file › focus | Expect |
|---|---|---|
| Listing across posts and accounts, ambiguous first, newest first, deleted posts excluded, isolation across two projects | `failures/list.test.ts` | every ambiguous and failed target exactly once; 0 from the other project (SC-002) |
| Filters (status, account) and pagination in search params; unknown account → empty | `failures/list.test.ts` | counts and rows match |
| Attempt log complete, in time order, with actor names; runs collapsed but counted; no secrets | `failures/attempts.test.ts`, `services/failures.test.ts` (`groupAttemptRuns`) | `sum(run.count) == attempts` |
| Mark published with an https URL → published, link, `resolved_published`, `post.published` webhook | `failures/resolve.test.ts` | row gone; webhook delivery row exists |
| `javascript:`, `data:`, `https://u:p@…` refused with a field error; same rule on post detail | `failures/resolve.test.ts`, `posts/resolve-url.test.ts` | `fieldErrors.url` |
| Requeue with a free slot → preview equals the taken slot; `resolved_not_published` + `requeued` | `failures/requeue.test.ts` | scheduled into the previewed occurrence |
| Requeue with no slot → failed with "no free posting slot"; don't-requeue → failed | `failures/requeue.test.ts` | messages as in data-model §2 |
| Requeue blocked by gate (needs_reauth, removed, invalid content) → nothing changes | `failures/requeue.test.ts` | still `ambiguous` |
| 20 parallel resolve/requeue on one target → exactly one applies; no occurrence held twice (repeat ×5) | `failures/concurrency.test.ts` | one success; 19 "already resolved"; unique holders |
| Retry on failed → `scheduled`, `next_attempt_at = now`, `retry_requested`; next tick publishes (mock) | `failures/retry.test.ts` | published after one tick |
| Retry refused for reconnect, removed or provider-missing, with the specific message; the UI shows the same text | `failures/retry.test.ts`, `failures/ui.test.tsx` | messages per D8 |
| Non-member gets not found for page and every action; an API-key scope cannot call the actions | `failures/authz.test.ts`, `tests/integration/actions-authz.test.ts` rows | `not_found` |
| Nav badge counts ambiguous only, from one count query | `failures/nav.test.ts` | `Failures (n)` text; one `count` statement recorded |
| Post detail shows the attempt count and the same choices | `posts/detail-resolution.test.tsx` | Attempts row; same buttons |
| Accessibility markup and the four states | `failures/ui.test.tsx` | see contracts/ui.md §6 |
| Engine pre-call failure (decrypt throws, settings parse throws, DB read throws) is never ambiguous on a may-publish step | `scheduler/pre-call-failures.test.ts` | `failed` (fatal) or `retryable` with backoff; no `ambiguous` attempt |

## 2. Limits audit (US2; FR-014–FR-019; SC-004)

```bash
pnpm vitest run tests/integration/limits tests/integration/docs/limits-inventory.test.ts \
  tests/integration/bluesky/sessions.test.ts src/providers/limits.test.ts
```

- `docs/limits.md` exists with one table per registered provider. The doc test fails if any of these holds:
  - a capability value differs from the code;
  - a capability field or declared limit has no row;
  - a named test does not exist;
  - a row says "unenforced".
- The enforcement test is table-driven from the provider capabilities. For every content limit:
  - it is refused before scheduling (compose, API, job item, generation save);
  - it is refused at publish time after the content or capability changes;
  - **0 platform requests** are made (a fetch spy fails on any platform host).
- Rate rows: Instagram 100/24 h, Threads 250/24 h, and Bluesky 1,666/h and 11,666/day. Each is deferred to the computed instant, with a `deferred` attempt, an unchanged `attempt_count`, and no request.
- Bluesky: N publishes across ticks cause one `createSession` (the connect) and no more (FR-019).

## 3. Security pass (US3; FR-020–FR-028; SC-005, SC-006, SC-011)

```bash
pnpm vitest run tests/integration/security tests/integration/tick-endpoint.test.ts \
  src/server/net/safe-fetch.test.ts tests/integration/webhooks tests/integration/docs/security-findings.test.ts \
  src/server/dal/audit.test.ts
```

- `security/secret-scan.test.ts`:
  - the full mock flow plus a Bluesky account (fake PDS), an API key's use and a webhook delivery;
  - 0 seeded secrets in any captured output;
  - the self-check proves a deliberately logged secret is caught and reported with its name and location.
- `security/csrf.test.ts`: a cross-origin or missing-Origin-with-cookie request is refused with 403 and has no DB effect. This covers a server action, `compose/check` and an auth endpoint.
- `tick-endpoint.test.ts`: the five refusals are byte-identical; a correct secret runs exactly one tick.
- `security/headers.test.ts`: headers on a page, `/api/v1/...` and `/api/health`; HSTS only for an https URL.
- `security/body-limit.test.ts`: an endless chunked body is refused after the limit, without reading on.
- `safe-fetch.test.ts`: the range table per policy, and rebinding refused at connect.
- `webhooks/destination.test.ts`: refusal of loopback and metadata destinations at save and at delivery; a private LAN address is allowed.
- `dal/audit.test.ts`: a `tokenHash` detail key throws on the invitations path.
- `security/cookies.test.ts`: `Secure` + `__Secure-` with an https base URL; `httpOnly`; `SameSite=Lax`.
- `docs/security.md`: every FR-028 area has a row, and each row has a test or a reason.

## 4. Configuration and startup (US4; FR-029–FR-033; SC-007)

```bash
pnpm vitest run tests/lint/env-coverage.test.ts src/server/startup tests/startup src/server/env.test.ts src/server/llm/config.test.ts
```

- **Coverage:** every variable read in code or Compose is in `.env.example` and in `validateConfiguration`. The groups are in order, and the markers are present.
- **For each required variable removed in turn**, each of `runStartup` (web), the worker `main` and `prestart` exits 1, names the variable, and calls neither `migrate` nor serve. A spy proves `migrate` was not called.
- **For each validated variable given a malformed value:** the same, and the value never appears in the output.
- **Partly-set groups exit:** storage without its secret, `LLM_PROVIDER` without `LLM_MODEL`, `OPENAI_API_KEY` without `LLM_PROVIDER`, and `META_APP_ID` without its secret.
- **Wholly absent groups** produce one "not configured" line each, and startup continues.
- `DATABASE_URL_DIRECT=""` gets the same answer from `parseEnv`, `migrationUrl` and `directUrlOf`.

## 5. Docs (US6; FR-039, FR-040; SC-010)

```bash
pnpm vitest run tests/integration/docs
```

- `provider-guide.test.ts`:
  - every contract member is named in `docs/adding-a-provider.md`;
  - the 004 F5 strings are gone;
  - the refresh-hold note is present.
- README review (manual, recorded in the implement summary):
  - the section order matches FR-039;
  - every command is marked as run (with the date) or not run;
  - no owner-specific host appears.

## 6. Build smoke: headers, nonce, CSP (FR-024; U5)

```bash
pnpm build
# One synchronous command: start, probe, stop. The server never outlives the command.
( PORT=3100 BETTER_AUTH_URL=http://localhost:3100 node .next/standalone/server.js < /dev/null > "$TMPDIR/smoke-server.log" 2>&1 & pid=$!
  curl -s --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:3100/api/health
  curl -s -D "$TMPDIR/login.headers" -o "$TMPDIR/login.html" http://localhost:3100/login
  kill $pid )
grep -iE 'content-security-policy|x-frame-options|x-content-type-options|referrer-policy|strict-transport' "$TMPDIR/login.headers"
# Expect: every <script in login.html has nonce="<value in the CSP header>"; no Strict-Transport-Security for http.
```

The environment needs the required variables exported (a test database URL is fine). Tasks may wrap this in `scripts/check-headers.mjs`, which does the nonce comparison.

**Browser check (U5):** open `/login`, `/setup`, a project's calendar, compose, failures, media and accounts with the devtools console open. There should be **no CSP violation messages**. Record the result as run (with date and browser) or not run.

## 7. Clean-checkout Compose run (US5; FR-034–FR-038; SC-008, SC-009)

Run in a fresh directory:

```bash
git clone <repo> docket-verify && cd docket-verify
cp .env.example .env    # set BETTER_AUTH_SECRET, CREDENTIALS_ENCRYPTION_KEY (openssl rand -base64 32), MOCK_PROVIDER_ENABLED=true,
                        # BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD, TICK_SECRET
docker compose up -d --build < /dev/null
docker compose ps                                   # web healthy, worker running
docker compose run --rm worker node scripts/smoke.mjs < /dev/null   # every step ✓
docker compose exec -T postgres pg_dump -U docket -d docket -Fc > docket.dump
docker compose stop web worker
docker compose exec -T postgres pg_restore -U docket -d docket --clean --if-exists < docket.dump
docker compose start web worker
docker compose run --rm worker node scripts/smoke.mjs < /dev/null   # still ✓; the earlier smoke post is present (the script lists it)
docker compose down -v
```

- Behind a TLS-intercepting proxy, build with `--secret id=extra_ca,src=<pem>` (decision 12).
- Record every command, its observed result and the date in `docs/deployment.md` → "Verified run".
- Also do the manual UI walkthrough (contracts/docs-and-config.md §3a, steps 4–7). Record it as run (with date) or not run.
- If `docker` is not usable, write "Not verified in this environment: <reason>" there and in the implement summary.

## 8. Final gate (once, end of implement)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

`db:check` is needed because migration 0007 changes the schema. `build` is needed because routes, the proxy, `next.config.ts` and the bundles changed.
