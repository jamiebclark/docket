# Research: 010 Hardening for real use

Phase 0 of [plan.md](./plan.md). Part 1 lists facts read from the installed packages, the repository and `docs/research/`, each with where it was found. Part 2 lists the decisions built on them, each with the alternatives considered. Part 3 lists what stays NEEDS RESEARCH.

Every library fact here was read from `node_modules` (constitution I). Nothing comes from memory. Probes were run in this phase. A fact marked *code* was read from the current tree at `3572f3a`.

---

## 1. Facts

### Next.js 16.3.8 (installed docs and build output)

- **F1 — CSP with nonces.** Source: `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`.
  - The proxy generates a nonce per request. It sets the `Content-Security-Policy` header on both the request and the response.
  - During server rendering, Next.js reads the nonce from the request's CSP header and attaches it to framework scripts, page bundles, and the inline scripts and styles it generates.
  - Nonces **require dynamic rendering**. A statically prerendered page carries no nonce, and the guide warns that such pages "may encounter runtime errors".
  - `'unsafe-eval'` is needed in development only.
  - The documented production policy is `script-src 'self' 'nonce-…' 'strict-dynamic'`.
  - The alternative without nonces is `'unsafe-inline'` in `next.config` `headers()`.
- **F2 — `next.config` `headers()` is evaluated at build time.** Probe: the existing `.next/routes-manifest.json` contains the `/signup` `Referrer-Policy` rule as a static entry. A header that depends on runtime env (`BETTER_AUTH_URL`, `S3_PUBLIC_BASE_URL`) therefore cannot be set there for a prebuilt Docker image. It has to be set at request time, in the proxy. When two `headers()` rules set the same key on one path, the last one wins (`.../next-config-js/headers.md:47`).
- **F3 — Proxy runtime.** Proxy defaults to the Node.js runtime, and `runtime` cannot be configured (`.../03-file-conventions/proxy.md:255`, v16 history). Because it runs on Node.js, it can read `process.env` at request time. The repo's matcher (`src/proxy.ts`) covers every path except `_next/static`, `_next/image` and static file extensions, so it includes `/api/*`.
- **F4 — Server Actions CSRF.** Source: `.../next-config-js/serverActions.md:13` and `02-guides/data-security.md:546-552`.
  - Next compares the host of `Origin` with `x-forwarded-host` or `host`.
  - **A request with no `Origin` header is allowed through with a warning.**
  - `x-forwarded-host` comes from the client unless a proxy overwrites it.
  - Server Actions accept only POST.
- **F5 — `proxyClientMaxBodySize`.** Source: `.../next-config-js/proxyClientMaxBodySize.md`. When a proxy exists, Next buffers request bodies up to this limit (default 10 MB, set to 26 MB here). A larger body "will only be buffered up to the limit" and a warning is logged. **It is truncated, not rejected**, so this setting is not a size guard.

### Better Auth 1.7.7 (installed source)

- **F6 — Origin check.** Source: `node_modules/better-auth/dist/api/middlewares/origin-check.mjs`.
  - For non-GET requests **that carry a `cookie` header**, `validateOrigin` requires `Origin`, or else `Referer`, to match `trustedOrigins`, which defaults to `baseURL`. A missing or `null` origin is refused.
  - Cookie-less first-login forms are checked through Fetch Metadata (`validateFormCsrf`).
  - `skipOriginCheck` and `disableCSRFCheck` turn the checks off; the code leaves both unset.
  - The `/api/auth/*` surface is therefore already origin-checked whenever a session cookie exists.
- **F7 — Cookie flags.** Source: `dist/cookies/index.mjs:23-34`. Cookies carry `secure` (and the `__Secure-` prefix) when `baseURL` starts with `https://`. They are `httpOnly`, and `sameSite` defaults to `lax`. Docket sets no override (`src/server/auth/auth.ts`).

### Node 24 built-ins (as probed in 009 F7–F9, reused)

- **F8 — Guarded outbound connections.** `node:http`/`node:https` `request({ lookup })` routes every socket's DNS answer through the given `lookup`, including the connection after a redirect. A `lookup` that refuses an address therefore stops DNS rebinding at connection time. `net.BlockList` matches IPv4 and IPv6 subnets.
- **F9 — Global `fetch` cannot take a custom `lookup`** without an undici `Agent`, and `undici` is not a direct dependency (`package.json`). Webhook delivery uses global `fetch` (`src/server/services/webhooks/deliver.ts:49`). **It has no destination check at all** (*code*).

### The current tree (*code*)

- **F10 — Resolution services exist.** In `src/server/services/posts/index.ts:640-694`:
  - `retryTarget` and `resolveAmbiguous` both run inside `withLockedTarget`: post lock, then target locks, then a re-read, with a guarded update on `statuses` and `applyDerivedStatus` afterwards.
  - `resolveAmbiguous` takes `{ outcome: "published", url?: z.url() }` or `{ outcome: "failed" }`. **`z.url()` accepts `javascript:` and `data:`** (003 F15).
  - The two loser messages are "Only an unconfirmed post can be resolved." and "Only a failed post can be retried."
  - `retryTarget` refuses a missing, inactive or provider-less account with a single message: "Reconnect the account before retrying."
- **F11 — Webhook events follow derived status.** `applyDerivedStatus` (`services/posts/status.ts:26`) emits `post.published` or `post.failed` when `posts.status` changes. A manual resolution therefore fires exactly the event an automatic outcome would, with no extra code (FR-010).
- **F12 — Slot allocation.**
  - `allocateNextFree` (`services/queue/index.ts:75`) walks the free occurrences, nearest first. `tryHoldOccurrence` holds each one in a savepoint against the `post_targets_occurrence_uq` unique index. That write sets `slot_occurrence_at`, `slot_id`, `schedule_kind = 'slot'`, `scheduled_at` and `next_attempt_at`, but **not `status`**.
  - `peekNextFree` is the read-only preview.
  - `queueTargetsInTx` refuses any target that is not `draft` or `cancelled` (`queueableGate`). Requeueing an `ambiguous` target therefore needs its own transition, still through `allocateNextFree`, which stays the one allocator.
- **F13 — Attempt log.**
  - `publish_attempts` has `actor_user_id` but no API-key actor column.
  - The outcome enum holds 15 values; the user ones are `resolved_published`, `resolved_failed` and `retry_requested`.
  - `AttemptView` (`services/posts/view.ts`) omits the actor, and `PostViewTarget` omits `attemptCount` (003 F9).
  - No API operation retries or resolves targets (`src/server/api/operations/posts.ts`), so a user action is always performed by a member.
- **F14 — Publish engine pre-call failures.** In `execute()` (`src/server/scheduler/publishing.ts:277-354`), the content load, media resolution, ciphertext read, `decryptCredentials`, publish-time refresh and `settingsSchema.parse` all sit in one `try` with `provider.advance`. An unexpected throw from any of them reaches the generic `catch`, which returns `ambiguous` on a `mayPublish` step (002 F21).
  - `MediaUnavailable`, `PostGone` and `MediaNotReady` are already classified, so they are not affected.
  - The claim-time checks for account, settings and post are classified correctly.
- **F15 — No publish-time content validation.**
  - The tick resolves media at publish time (`resolvePublishMedia`). It never calls `provider.validate`.
  - Text length, image count, alt-text length, required media and post type are checked only when scheduling, through `validateTargetContent`: on queue or schedule (`gate`), composer check, generation, review approval and API.
  - A capability lowered by a deploy after scheduling therefore reaches the platform unchecked. This is a **gap against FR-015**.
- **F16 — Declared limits** (provider capabilities):

  | Provider | Text | Images | Bytes/file | Formats | Geometry | Alt text | Media required | Publish limit |
  |---|---|---|---|---|---|---|---|---|
  | facebook | 10,000 code points (R1) | 10 (R2) | 8,000,000 (R2) | jpeg, png → jpeg | — | — | no | **none** |
  | instagram | 2,200 code points (R1) | 10 | 8,000,000 | jpeg (→ jpeg) | maxWidth 1440, aspect 0.8–1.91 | 1,000 | yes, text-only refused | 100 / 24 h |
  | threads | 500 (custom: emoji UTF-8 bytes) | 20 | 8,000,000 | jpeg, png → jpeg | width 320–1440, aspect 0.1–10 | 1,000 | no | 250 / 24 h |
  | bluesky | 300 graphemes + 3,000 bytes (`validateBluesky`) | 4 | 2,000,000 | jpeg, png → jpeg | — | — | no | **none** |
  | mock | 500 graphemes | 4 | 5,000,000 | jpeg, png | — | — | no | none |

  `SocialProvider.defaultPublishLimit` is a **single** `PublishLimit`. `effectiveLimits()` already returns an array and `deferralTime()` enforces every entry (`scheduler/limits.ts`).

  Research facts (`docs/research/bluesky.md`) not yet declared:
  - Bluesky writes: 5,000 points/h and 35,000/day, create = 3 points (approximate).
  - Bluesky `createSession`: 30 per 5 min and 300/day.
- **F17 — Platform quota checks** exist already: Instagram's `content_publishing_limit` (`providers/instagram/quota.ts`) and Threads' `threads_publishing_limit` (`providers/threads/quota.ts`, tested in `tests/integration/threads/limits.test.ts`). The default-limit tests also exist: Instagram and Threads `limits.test.ts`, and `scheduler/limits.test.ts`.
- **F18 — Env validation paths.**
  - The web runs `runStartup` (`src/server/startup/index.ts`): `parseEnv` + `providerEnvIssues` → exit; LLM is log-only; migrate; bootstrap.
  - The **worker** (`src/worker.ts`) runs `parseEnv` only. It skips `providerEnvIssues`, so a malformed `META_APP_ID` stops the web process but not the worker.
  - **`scripts/prestart.mjs` migrates before any validation** (001 F7).
  - `drizzle.config.ts:4` and `tests/setup/global-setup.ts:12` read `DATABASE_URL_DIRECT ?? DATABASE_URL`, while `env.ts` and `prestart.mjs` use `||` (001 F12).
  - The env schema accepts unknown `NODE_ENV` and does not read `PORT` or `HOSTNAME`. Next's `server.js` reads those two.
- **F19 — Variables read by the code** (static scan of `src`, `scripts`, `drizzle.config.ts`, `next.config.ts`):
  - every `env.ts` schema key;
  - `LLM_PROVIDER`, `LLM_MODEL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `LLM_TIMEOUT_SECONDS`, `LLM_MAX_OUTPUT_TOKENS`;
  - provider-declared `META_*` and `THREADS_*`;
  - the internal `DOCKET_PREMIGRATED`, `NEXT_RUNTIME` and `NODE_ENV`.

  The Compose file adds `MINIO_IMAGE`, `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`, and the Dockerfile sets `NEXT_TELEMETRY_DISABLED`, `PORT` and `HOSTNAME`. `.env.example` documents all of these, but nothing checks it.
- **F20 — Tick endpoint.**
  - `handleTickRequest` (`scheduler/http.ts`) returns **404** when no secret is configured and **401** for a wrong or missing bearer. These are two distinguishable responses (FR-022).
  - It never reads the query string, so a `?secret=` alone already fails as "missing", but with the 401 body.
  - It compares SHA-256 digests in constant time.
- **F21 — Body reading.**
  - `readBytes` (`src/server/api/handle.ts:26`) checks `Content-Length`, then `await request.arrayBuffer()`. A chunked body is read whole before the check (009 N15).
  - `compose/check/route.ts:20` calls `request.json()` unbounded, so only F5's truncation applies.
- **F22 — Outbound address policy.** `src/server/net/safe-fetch.ts`:
  - The `BlockList` lacks `2002::/16` (6to4), `2001::/32` (Teredo), `2001:db8::/32`, `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` and `::/96` (IPv4-compatible).
  - IPv4-mapped addresses (`::ffff:`) are refused by regex.
  - The policies are `public` and `allow-loopback` (tests). The lookup guard runs per connection.
- **F23 — Audit writes.** `recordAudit` refuses `token|url|password|secret` detail keys, but `services/invitations/index.ts` calls `tx.audit.insert` directly at six sites. The only DB insert lives in `createAuditRepo().insert` (`src/server/dal/audit.ts:25`) (001 F4).
- **F24 — Headers today.** The only custom response header is `/signup` `Referrer-Policy: no-referrer` (`next.config.ts`). There is no CSP, `X-Content-Type-Options`, frame or HSTS header. The root layout is synchronous (`src/app/layout.tsx`). Most pages are `force-dynamic`, but `/login` and `/setup` may prerender.
- **F25 — Outbound browser navigation.** OAuth connect starts with a server action that `redirect()`s to the platform's login URL (`accounts/actions.ts:108`). `OAuthConnectGroup.authorizationUrl()` is pure, so each registered group's login origin can be computed without a request. A CSP `form-action 'self'` would block a no-JS form POST that redirects to that origin.
- **F26 — Test harness.**
  - Pages are rendered in tests as `renderToStaticMarkup(await Page({ params }))`, with the session mocked (`tests/integration/accounts-ui.test.ts:128`).
  - Each test file gets a fresh module graph, so `getEnv()`'s cache is per file. `vi.hoisted` can set env before imports (`tests/integration/meta/no-secrets.test.ts:3`).
  - Fakes exist for the PDS (`tests/helpers/fake-pds.ts`), Graph, LLM, webhook receivers and image servers.
  - `setUrlFetchOverridesForTests` is the existing pattern for test-only address policies.
- **F27 — Docker in this environment.** `docker version` fails with "permission denied … docker.sock" inside the planning sandbox. Whether the implement phase can reach Docker is unknown. FR-037 already says how to report it.
- **F28 — Compose today.**
  - `web` (port 3000 published on all interfaces), `worker` (depends on `web` healthy), `postgres:17` (volume `docket-pgdata`, credentials `docket/docket`), plus an opt-in `offline` profile with MinIO and `storage-init`.
  - The image sets `NODE_ENV=production`, so `MOCK_PROVIDER_ENABLED` defaults to false in the image (`env.ts` `bool(() => NODE_ENV !== "production")`).
  - `BETTER_AUTH_SECRET` and `CREDENTIALS_ENCRYPTION_KEY` are required with `:?`.

---

## 2. Decisions

### Failures view

- **D1 — One service module, `src/server/services/failures.ts`, for reads. Resolutions stay in `services/posts`.**
  - **Decision:** `listFailures`, `countNeedsDecision` and `previewRequeue` are read-only functions in `failures.ts`. Writes stay in `services/posts/index.ts` (`resolveAmbiguous`, `retryTarget`), which the post detail page and the failures view both call (constitution IV).
  - **Rationale:** the actions already exist with the right locking (F10). The view only adds reads.
  - **Alternatives:** a new `failures` write service would duplicate `withLockedTarget`.
- **D2 — `resolveAmbiguous` takes a new input union.**
  - **Decision:** the input is one of:
    - `{ outcome: "published", url? }`;
    - `{ outcome: "not_published", requeue: true, expected? }`;
    - `{ outcome: "not_published", requeue: false }`.

    `outcome: "failed"` is still parsed as `not_published, requeue: false`, so any older form posting it keeps working. It returns a `ResolveResult` (contracts/services.md).
  - **Rationale:** this is the spec's replacement of "failed" (FR-008). The return lets the dialog show where the target went.
  - **Alternatives:** a separate `requeueAmbiguous` would be a second locked path for the same transition.
- **D3 — Requeue transition.** Inside the same `withLockedTarget` transaction:
  1. Re-check `status = 'ambiguous'`. If it is not, raise `ConflictError("This post was already resolved.")`.
  2. Run `gate(tx, target)`, which covers the account being active, the provider being present and content validation. If it fails, raise `ConflictError(gate.message)`. **Nothing changes**, and the dialog offers "don't requeue".
  3. Call `allocateNextFree(tx, {id, accountId}, { after: now })`.
     - **If it succeeds:** update the target with guard `statuses: ["ambiguous"]`, setting `status 'scheduled'`, `attemptCount 0`, `lastError null`, `stepState null`, `inFlightStep/inFlightMayPublish null`, `firstStepAt null`, `publishStartedAt null`, `externalId null`, `externalUrl null`, `resolvedByUserId`, `resolvedAt`. Append two attempts: `resolved_not_published` and `requeued`, with request `{ scheduledAt, slotId }`.
     - **If it fails:** set `status 'failed'` and `lastError "Not published — no free posting slot. Retry or schedule it."`. Append one `resolved_not_published` attempt with error `no_free_slot`.

  `allocateNextFree` stays the only allocator. The unique index guarantees one holder per occurrence (SC-003).
  - **Why reset `publishStartedAt`:** the person resolving says nothing went out, so the start must not count against the publish limit. `retryTarget` already does the same.
  - **Alternatives:**
    - Loosening `queueableGate` to admit `ambiguous` would let Add-to-queue silently resolve a target.
    - Mapping a gate failure straight to `failed` would hide a fixable validation error behind a status change.
- **D4 — Attempt outcomes.**
  - **Decision:** add two enum values: `resolved_not_published` (the requeue path) and `requeued`. "Mark not published, don't requeue" keeps writing `resolved_failed`, with the `lastError` changed to "Marked not published by a team member. Retry or schedule it."
  - **Rationale:** the spec allows these two additions (Key Entities). Existing rows never change.
  - **Alternatives:** recording the requeue in `request_summary` on `resolved_failed` would make the log read "failed" for a target that was rescheduled.
- **D5 — Ordering and grouping.**
  - **Decision:** the list is one query ordered `(status = 'ambiguous') DESC, updated_at DESC, id`, paginated at 25 rows. The page prints the "Needs your decision" header before the first ambiguous row and the "Failed" header before the first failed row. "Newest first" means *most recently entered this state*. That is `post_targets.updated_at`, because a failed or ambiguous target is not written again until someone acts on it.
  - **New index:** `post_targets_attention_idx ON (project_id, updated_at DESC, id) WHERE status IN ('ambiguous','failed')`.
  - Filters are `status=ambiguous|failed|all` (default `all`) and `account=<uuid>`. Filters and page live in search params (FR-004).
  - Soft-deleted posts are excluded through the existing `posts.deleted_at IS NULL` join.
  - **Alternatives:**
    - Two paginated lists cannot share one URL page number sensibly.
    - Ordering by `scheduled_at` puts long-ago scheduled posts that failed today at the bottom.
- **D6 — Attempt logs are rendered on the server inside `<details>`.**
  - **Decision:** the page loads the attempts for the visible rows in one query, a new `attempts.listForTargets(ids)`, plus member names for `actor_user_id`. Each row has a native `<details>`/`<summary>` expander, which is keyboard operable with no client JS.
  - Runs of consecutive entries with the same `step`, `outcome` and `error` collapse into one summary line ("check_status · continue × 14"). That line is itself a nested `<details>` listing every entry, so nothing is dropped (FR-003).
  - The actor column shows the member's name, or "Former member" when the user is gone. No API key column is added, because the API never performs user actions on targets (F13).
  - **Alternatives:**
    - A client fetch per expansion needs a new route and loading states.
    - Loading one target per request would cost N+1 queries.
- **D7 — Nav badge.**
  - **Decision:** `countNeedsDecision(scope)` runs one `count(*)` on `post_targets` joined to live posts, `WHERE project_id AND status = 'ambiguous'`, using the new partial index. It is called in the project layout next to `countReviewQueue`. `LeftNav` gains a `failures` entry after `review`, shown as "Failures (2)" with a text count, matching Review's style.
  - **Rationale:** FR-005 forbids loading the list on every page, and one count costs one index range scan.
  - **Alternatives:** caching the count would add staleness rules for a cheap query.
- **D8 — Action permissions and retry messages.**
  - **Decision:** the actions need `post:schedule` (owner, admin, editor), as today. Viewing needs `post:view`.
  - `retryTarget`'s refusals become specific:
    - "That account has been removed."
    - "Reconnect <name> to retry."
    - "The provider for <name> is no longer available."
  - The loser of a race gets "This post is no longer failed." or "This post was already resolved."
  - The view computes the same refusal as `retryBlockedReason` (a pure helper shared with `retryTarget`), so the UI never offers what the server refuses.
- **D9 — External URL rule.**
  - **Decision:** `externalUrlSchema` lives in `src/lib/validation/scheduling.ts`: trimmed, at most 2,000 characters, `URL` parse, protocol `http:` or `https:`, no username or password. It is used by `resolveAmbiguous` and so by both screens.
  - Rendering goes through a `safeExternalHref(url)` helper. Rows written before this rule are shown as plain text when the scheme is not http(s) (defence in depth for 003 F15).
  - **Alternatives:** an `https`-only rule would refuse a valid `http://` self-hosted instance link.
- **D10 — Shared resolution UI.**
  - **Decision:** the per-target action dialogs move from `posts/[postId]/TargetActions.tsx` to `src/components/targets/TargetResolution.tsx`, a client component. The post detail page and each failures row both use it. Server actions stay in `src/app/p/[projectSlug]/posts/actions.ts`: `retryTargetAction`, `resolveTargetAction`, and a new `previewRequeueAction`.
  - **Rationale:** FR-011 requires the same choices on both screens, and one component guarantees it.

### Limits audit

- **D11 — Publish-time re-validation (closes F15).**
  - **Decision:** the provider-validation core of `validateTargetContent` is extracted as `validateResolvedContent(provider, { text, media })` in `services/posts/validate.ts`, shared by both paths. `execute()` calls it on the **first step only** (`target.stepState === null`), after media resolution and before credentials are read or decrypted.
  - Any error-severity issue gives `{ kind: "fatal_error", error: "Can't publish to <platform>: <first message>" }`. No provider call is made, and the attempt is recorded as `fatal_error` on step `engine-validate`.
  - **Rationale:**
    - Edits are refused once a target has started publishing, so content cannot change between steps.
    - Checking only on the first step means a container created on step 1 is never abandoned over a check that already passed.
    - The check is pure and costs nothing.
  - **Alternatives:**
    - Re-running the full `validateTargetContent` would re-plan variants that `resolvePublishMedia` just resolved, doing the work twice.
    - Validating on every step was rejected for the reason above.
- **D12 — Multiple default publish limits (generic change G14).**
  - **Decision:** `SocialProvider.defaultPublishLimit?: PublishLimit | readonly PublishLimit[]`. A helper `providerPublishLimits(provider): PublishLimit[]` in `src/providers/limits.ts` is the only reader. `effectiveLimits`, the `setPublishLimit` looseness warning and the accounts screen use it.
  - Bluesky declares two limits from the approximate research figures: **1,666 / 3,600 s** and **11,666 / 86,400 s**, which is `floor(points ÷ 3)`. The inventory marks both "approximate (U3)" and notes that points are shared with any other app writing to the account.
  - Facebook declares none (U2). The account-level limit stays available.
  - **Alternatives:**
    - A single hourly limit lets a day's total reach 39,984 creates.
    - A second optional member (`additionalPublishLimits`) would mean two members to read.
- **D13 — The inventory lives in a doc and is checked against the code.**
  - **Decision:** `docs/limits.md` holds one table per provider. Its columns are category, value, counting rule, source and status, enforced in, and test.
  - Content rows are checked by `tests/integration/docs/limits-inventory.test.ts`. It parses each table and asserts:
    1. every numeric value equals the provider's declared capability or limit;
    2. every capability field and declared limit of every registered provider has a row;
    3. every named test file and test title exists;
    4. no row says "unenforced".
  - Enforcement itself is proved by a **table-driven** test, `tests/integration/limits/enforcement.test.ts`. It derives violating fixtures from each registered provider's capabilities, so a changed value moves the test with it.
  - **Rationale:** SC-004 needs proof per entry and no drift between doc and code.
  - **Alternatives:**
    - Generating the doc from code would lose the human-written source and status columns.
    - A TypeScript inventory module would put prose in code.
- **D14 — What the enforcement test asserts.** Each row runs with a fetch spy that fails the test on any call to a platform host. The provider fakes stay installed so a stray call is caught, not silently answered.
  - **(a) Before scheduling:** `addToQueue` and `scheduleAt` return `ok: false, code: "validation"`, and the message names the limit. The generator, jobs and API go through the same `gate`, and one representative caller per kind is exercised: compose action, API `POST /posts/{id}/queue`, a job item and a generation save.
  - **(b) At publish time:** the target is scheduled while valid. Then the post's content is changed directly in the test database, or the registered provider object's `capabilities` value is lowered (restored in `afterEach`; the registry has no test-registration helper and none is added). One tick is run. The target is `failed`, the error names the limit, and no platform request was made.
  - **(c) Rate rows:** `publish_started_at` history is seeded up to the limit for the window and one tick is run. The target is deferred to the documented instant, a `deferred` attempt is written, `attempt_count` is unchanged, and there is no platform request.
  - **(d) Bluesky sessions (FR-019):** connect once, then publish N posts across ticks. `createSession` is hit exactly once (the connect) and `refreshSession` only when the token is near expiry. The fake PDS counts both.
- **D15 — Rows that are adaptations, not refusals.**
  - Instagram's `width 320–1440 (scaled outside)` is listed as follows:
    - over 1440 is downscaled by Docket (planner);
    - under 320 is accepted, because research says the platform scales it.
  - Threads' carousel minimum of 2 is listed as "one image publishes as an image post (post type inferred)". A one-item carousel cannot be built.
  - PNG→JPEG conversion and over-size compression are listed as adaptations, with the planner refusal (`image_too_small`, `aspect_ratio_out_of_range`, undecodable) as the enforced edge.
  - Each row cites its proving test. None is "unenforced".

### Security pass

- **D16 — One CSRF guard in the proxy.**
  - **Decision:** `src/lib/http/same-origin.ts` exports a pure `checkSameOrigin({ method, path, headers, appOrigin })`. `proxy()` calls it before anything else.
  - **Scope:** every method except GET, HEAD and OPTIONS, on every path except `/api/v1/*` (API-key bearer, no cookies used) and `/api/internal/tick` (bearer secret).
  - **Refused (403 JSON `{"error":"cross_origin"}`):**
    - `Origin` is present and not equal to `new URL(BETTER_AUTH_URL).origin`;
    - `Origin` is absent and `Sec-Fetch-Site` is `cross-site` or `same-site`;
    - neither header is present and the request carries a session cookie.
  - **Covers:** Server Actions (F4's missing-Origin hole), `compose/check`, and `/api/auth/*` on top of F6.
  - **Rationale:** one place covers all three surface types (FR-021). Comparing with the configured public URL rather than `Host` closes the `x-forwarded-host` spoof.
  - **Alternatives:**
    - `serverActions.allowedOrigins` is build-time and does not close the missing-Origin case.
    - A per-route check would mean many copies of the same check.
- **D17 — Security headers.**
  - **Static (`next.config.ts` `headers()`, source `/:path*`):**
    - `X-Content-Type-Options: nosniff`;
    - `X-Frame-Options: DENY`;
    - `Referrer-Policy: strict-origin-when-cross-origin`.

    The existing `/signup` `no-referrer` rule stays after it and wins (F2).
  - **Runtime (`proxy()`, from `src/lib/http/security-headers.ts`, pure):**
    - `Content-Security-Policy` with a per-request nonce:
      - `default-src 'self'`;
      - `script-src 'self' 'nonce-…' 'strict-dynamic'`, plus `'unsafe-eval'` in development;
      - `style-src 'self' 'unsafe-inline'`;
      - `img-src 'self' data: blob: https:`, plus `S3_PUBLIC_BASE_URL`'s origin when it is `http:`;
      - `connect-src 'self'`;
      - `font-src 'self'`;
      - `object-src 'none'`;
      - `base-uri 'self'`;
      - `frame-ancestors 'none'`;
      - `form-action 'self'` plus each registered OAuth group's login origin (F25).
    - `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`, no `preload`), only when `BETTER_AUTH_URL` is `https:`.
  - **Making every page dynamic:** the root layout becomes `async` and awaits `connection()` (F1), so no page is prerendered without a nonce.
  - **Rationale:**
    - Per-request values must come from the proxy (F2).
    - Nonces keep `'unsafe-inline'` out of `script-src`.
    - Styles keep `'unsafe-inline'` because React `style` attributes cannot carry nonces.
    - `img-src https:` covers both public and signed storage URLs, whose host depends on runtime storage config. An image cannot execute script.
    - `includeSubDomains` would affect hosts this app does not own (public repo, unknown domains).
  - **Alternatives:**
    - `'unsafe-inline'` scripts would make the CSP weak against XSS.
    - Experimental SRI is experimental.
    - An exact storage origin in `img-src` would need the storage module's URL logic in the proxy.
  - **Verification:**
    - unit tests of the pure header builder;
    - a proxy test calling `proxy(new NextRequest(...))`;
    - route tests asserting the static and runtime headers on a page, `/api/v1/…` and `/api/health`;
    - **a build smoke step** (quickstart §6) that runs `pnpm build && pnpm start` and checks that every `<script>` on `/login`, `/setup` and a project page carries the response's nonce.

    The browser-console check of the shipped screens is a quickstart step. It is reported as run or not run.
- **D18 — Tick endpoint: one refusal.**
  - **Decision:** every refusal returns the same `401 {"error":"unauthorized"}` with `WWW-Authenticate: Bearer` and `Cache-Control: no-store`. That covers no secret configured, missing or malformed header, wrong secret, and **any request with a non-empty query string**.
  - When no secret is configured, a fixed dummy digest is still compared, so timing matches. The presented value is never logged.
  - The `.env.example` text changes from "answers 404" to "refuses every call".
  - **Alternatives:** keeping 404 for "not configured" is exactly the distinguishable case FR-022 forbids.
- **D19 — Bounded body reader.**
  - **Decision:** `src/server/http/body.ts` exports `readBodyWithin(request, limit)`. It refuses a declared `Content-Length` over the limit. Otherwise it reads `request.body` through its stream reader, summing chunk sizes, and the moment the total crosses the limit it calls `reader.cancel()` and throws `BodyTooLargeError`.
  - It is used by the API pipeline's `readBytes` and by `compose/check`, with a 256 KB limit there (the composer state is text plus ids).
  - **Rationale:** closes 009 N15 and F21. F5 shows the proxy setting is not a guard.
  - **Alternatives:** `Content-Length` alone does not cover chunked bodies.
  - Server Actions keep Next's own `bodySizeLimit` (26 MB), and the findings record cites it.
- **D20 — Address policies.**
  - **Decision:** `safe-fetch.ts` gains the F22 ranges in `blocked`, and checks IPv4-compatible `::/96` and IPv4-mapped addresses by extracting the embedded IPv4 and testing it against the IPv4 list.
  - It has three policies:
    - `public`, used for media by URL;
    - `webhook`: everything in `public` is refused **except** the RFC 1918 ranges, CGNAT `100.64/10` and IPv6 ULA `fc00::/7`. Loopback, link-local (including `169.254.169.254`), unspecified, multicast, reserved, documentation, 6to4, Teredo, NAT64 and mapped forms are always refused;
    - `allow-loopback`, used only through test overrides.
  - A new `postGuarded(url, { body, headers, timeoutMs, policy })` in `safe-fetch.ts` replaces `fetch` in `sendDelivery`. It uses `node:http(s)` with the guarded `lookup` and no redirects, so a 3xx is still a failure (F8, F9).
  - **At save time:** `webhookUrlSchema` refuses literal refused IPs and `localhost`/`*.localhost`. The endpoints service then resolves the hostname once, with a 3 s timeout, and refuses with a field error if any address is refused. If resolution fails, the URL is saved with a warning that delivery will check it.
  - Tests use `setWebhookDeliveryOverridesForTests({ addressPolicy: "allow-loopback" })`.
  - **Alternatives:**
    - Adding `undici` for a custom dispatcher is a new dependency.
    - Refusing private ranges would break the owner's n8n on the LAN (spec decision).
- **D21 — Audit guard in the repository.**
  - **Decision:** `assertSafeDetails` moves into `createAuditRepo().insert`. `recordAudit` becomes a thin `scope.audit.insert` call, and its callers are unchanged. A test proves that a `tokenHash` detail key throws on the invitations path (001 F4).
- **D22 — Engine pre-call failures (002 F21).**
  - **Decision:** `execute()` sets a local `providerCalled = true` immediately before `provider.advance(...)`. In the `catch`, an error with `providerCalled === false` is never ambiguous:
    - `CredentialsUnreadable`, a new error wrapped around a `decryptCredentials` throw, and settings parse errors give `fatal_error` with a plain message ("The account's stored credentials can't be read. Reconnect <name>.", "The account settings are invalid.");
    - any other pre-call throw gives `retryable_error` ("Publishing could not start; will retry."). Nothing was sent, so a retry is safe, and the normal attempt budget ends it as `failed`.
  - The refresh path already has explicit outcomes.
  - **Rationale:** FR-012, "fail rather than ambiguous". A transient DB blip should not need a human, and it can never cause a duplicate.
  - **Alternatives:** making every pre-call error fatal would turn a 1-second connection drop into a manual retry.
- **D23 — The end-to-end secret scan.** In `tests/integration/security/secret-scan.test.ts`:
  - **Seeded values:** set through `vi.hoisted` before imports: `BETTER_AUTH_SECRET`, `CREDENTIALS_ENCRYPTION_KEY` (distinctive bytes), `TICK_SECRET`, `S3_SECRET_ACCESS_KEY` and `S3_ACCESS_KEY_ID` (memory storage plus a fake config), and `OPENAI_API_KEY` (fake LLM HTTP).
  - **Credentials:** the mock account's random token is read back by decrypting it. A Bluesky account connected through the fake PDS adds an app password and access and refresh JWTs, plus webhook secrets, API key plaintexts, invitation tokens and session tokens.
  - **Captured:**
    - `console.*` and `process.stdout`/`stderr` writes through spies;
    - every `Response` from route handlers (`/api/v1`, `/api/auth`, `/api/internal/tick`, `/api/health`, `compose/check`, `connect/callback`), with status, headers and body;
    - server-action results;
    - rendered pages via `renderToStaticMarkup`: failures, post detail, accounts, settings/API keys, webhooks, members;
    - every `publish_attempts` row;
    - webhook receiver bodies and headers;
    - `membership_audit_log` details.
  - **Forms scanned:** each value as is, base64, base64url, URL-encoded and hex where applicable.
  - **Allowed appearances:** the create and rotate responses that show a new key or secret once, asserted separately and then removed from the corpus.
  - **Self-check:** the test injects one deliberate `console.log(secret)` and asserts the scanner reports it, naming the secret and the place (SC-005).
  - **Rationale:** the "web and worker" logs are the same `console` in-process, because the test runs `runTick()` directly.
- **D24 — The findings record** is `docs/security.md`, a table with columns area, what was checked, finding, severity, fix or accepted reason, and test. It lists every FR-028 area. Accepted items include "Server Actions body limit is Next's 26 MB (by design for uploads)" and "Better Auth's own origin check is relied on in addition to D16".

### Configuration and startup

- **D25 — One configuration validator for every entry point.**
  - **Decision:** `src/server/startup/validate.ts` exports `validateConfiguration(source)`, which returns `{ ok, issues: EnvIssue[], disabled: string[] }`. It merges:
    - `parseEnv` (core and storage);
    - `providerEnvIssues` (G8);
    - `llmEnvIssues`, a new strict wrapper over `parseLlmConfig`:
      - a wholly absent group is `disabled`;
      - setting any LLM variable without `LLM_PROVIDER`, a malformed value, or a provider with no model or key is an **issue**;
    - the disabled-feature notes: media storage, generation, each unconfigured connect group, the HTTP tick trigger when `TICK_SECRET` is unset, and the mock provider when it is off.
  - **Used by:** `runStartup` (web), `src/worker.ts`, and **`scripts/prestart.mjs` before it migrates** (001 F7). `build:prestart` already bundles with esbuild, which resolves the `@/` paths; `--external:sharp` is added as in `build:worker`.
  - **Output:** all issues are printed at once, by name and reason, never values. Each disabled feature gets one line.
  - **Rationale:** this is the spec's strictness decision, applied identically in all three processes (edge case "worker only").
  - **Alternatives:**
    - Leaving prestart unvalidated keeps 001 F7.
    - Making prestart skip migration and leaving it to `runStartup` would let the server listen before migrating.
- **D26 — Validate every variable read.**
  - **Decision:** the env schema gains:
    - `NODE_ENV`: one of `development`, `production` or `test`, optional;
    - `PORT`: integer 1–65535, optional;
    - `HOSTNAME`: non-empty, no whitespace, optional.

    It exports `ENV_VARIABLES`, the schema's key list.
  - `src/server/llm/config.ts` exports `LLM_VARIABLES`. The connect groups already export `environment.variables`.
  - `src/server/config-registry.ts` exports `INTERNAL_VARIABLES` with reasons:
    - `NEXT_RUNTIME`: set by Next;
    - `DOCKET_PREMIGRATED`: set by prestart for its child;
    - `NEXT_TELEMETRY_DISABLED`: Next build/runtime, image only.

    It also exports `COMPOSE_ONLY_VARIABLES`: the `MINIO_*` variables.
- **D27 — The coverage check.** `tests/lint/env-coverage.test.ts` statically scans `src/**`, `scripts/**`, `drizzle.config.ts`, `next.config.ts`, `docker-compose.yml` and `Dockerfile`, excluding tests:
  - **Patterns:** `process.env.X`, `process.env["X"]`, `source.X`, `env.X`, `deps.env.X`, and Compose `${X…}`.
  - **First assertion:** every name found is in `ENV_VARIABLES ∪ LLM_VARIABLES ∪ provider variables ∪ INTERNAL_VARIABLES ∪ COMPOSE_ONLY_VARIABLES`.
  - **Second assertion:** every name in the first four sets appears in `.env.example`. A variable counts when it appears as `NAME=` or `# NAME=`. Each one must have a description comment, a `Required.` or `Optional.` marker, and a default or "no default".
  - **Third assertion:** every name in `ENV_VARIABLES ∪ LLM_VARIABLES ∪ provider variables` is reachable from `validateConfiguration`. A malformed probe value per variable must produce an issue naming it. Free-text variables are the exception: they are checked for "accepted", and the test lists them explicitly.
  - **Also enforced:** `.env.example` contains no real-looking secret. The test refuses base64 blobs of 32 bytes or more and `EAA…` and `sk-…` prefixes on uncommented lines.
- **D28 — Empty means unset everywhere.** `drizzle.config.ts` and `tests/setup/global-setup.ts` switch to `||` (001 F12). A unit test feeds `DATABASE_URL_DIRECT=""` to `parseEnv`, `migrationUrl` (prestart) and a small exported `directUrlOf(source)` that `drizzle.config.ts` uses, and expects the same answer from all three.

### Deployment and verification

- **D29 — Smoke script.**
  - **Decision:** `scripts/smoke.ts` is bundled by a new `build:smoke` (esbuild, like `build:worker`) into `.next/standalone/scripts/smoke.mjs`. It is run as `docker compose run --rm worker node scripts/smoke.mjs`. Against the live stack's database and services it:
    1. waits for `/api/health` on `SMOKE_BASE_URL` (default `http://web:3000`);
    2. ensures a smoke user exists (`BOOTSTRAP_ADMIN_*` or creates one through the setup service);
    3. creates a project `smoke-<date>`;
    4. connects a mock account;
    5. creates a text post and calls `publishNow`;
    6. polls until the **running worker** has published it (60 s budget);
    7. reads the scheduler health and asserts the last tick is under 2 minutes old;
    8. probes HTTP: security headers on `/login`; 401 for `/api/internal/tick` without the secret; 403 for a cross-origin POST to `/api/auth/sign-in/email`.

    It prints each step and its result and exits non-zero on the first failure.
  - **Rationale:** it drives the real worker container and real HTTP. Server actions cannot be driven by a script without their build-specific ids.
  - The **UI walkthrough** (sign in, create project, connect mock, publish now, see the tick indicator) stays a numbered manual list in `docs/deployment.md`. It is marked with who ran it and when, or "not run".
  - The script is not added to CI (spec decision). `SMOKE_BASE_URL` is a smoke-only variable, listed in `.env.example` under "Smoke script (not read by Docket)" and in `COMPOSE_ONLY_VARIABLES`.
  - **Alternatives:**
    - A Playwright-style browser driver is a new dependency.
    - An HTTP-only script would have to reproduce Server Action ids.
- **D30 — Backups.**
  - **Backup:** `docker compose exec -T postgres pg_dump -U docket -d docket -Fc > docket-$(date +%F).dump`.
  - **Restore:**
    1. `docker compose stop web worker`
    2. `docker compose exec -T postgres pg_restore -U docket -d docket --clean --if-exists < file`
    3. `docker compose start web worker`
  - The docs state what else must be kept: `.env`, above all `CREDENTIALS_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET`. The bucket is backed up separately.
  - The commands are the Postgres client tools inside the `postgres:17` image. They run in implement against the stack (FR-035), or are reported as not run.
- **D31 — Compose hardening that changes nothing functional.**
  - `ports: "127.0.0.1:3000:3000"` becomes the default, with a comment saying how to publish on the LAN or put a proxy in front (FR-036).
  - `MOCK_PROVIDER_ENABLED` is passed through, defaulting to unset. The local walkthrough sets `MOCK_PROVIDER_ENABLED=true` in `.env` and the docs say to remove it for real use (FR-038).
  - No new services.
  - **Alternatives:** binding to all interfaces by default exposes plain HTTP on the LAN with no proxy.
- **D32 — Unraid section.**
  - **Content:** generic Docker Compose steps that work on any Docker host:
    - the clone location;
    - a `.env` beside the Compose file;
    - named volumes, with a note on how to bind-mount to a chosen host path instead;
    - the backup commands;
    - reverse-proxy requirements (FR-036: `BETTER_AUTH_URL` = external https origin, `TRUSTED_IP_HEADERS`/`TRUSTED_PROXIES`, a body limit ≥ 26 MB, web not published directly);
    - `restart: unless-stopped` keeping the worker up;
    - the public bucket requirement.
  - Every Unraid-UI step (how Compose stacks are managed, its conventional appdata path, proxy apps) is written as "**Unverified — check against your Unraid version (U1)**", with no plugin names, menu paths or default paths.

### Docs

- **D33 — Provider guide coverage test.** `tests/integration/docs/provider-guide.test.ts` parses `src/providers/types.ts` with the installed `typescript` compiler API. It collects the member names of `SocialProvider`, `ProviderCapabilities` (including `media.*`), `OAuthConnectGroup`, `CredentialField` and `StepResult` kinds, plus `ConnectStrategy` strategies. It asserts that each appears in backticks in `docs/adding-a-provider.md`, and that the 004 F5 contradiction strings are absent:
  - `stepFor(state, settings)`;
  - "the next tick refreshes";
  - `blob.ipld()`.
  - It also asserts the 006 F7 note exists, matched by the anchor text "refresh hold".
- **D34 — The README** follows FR-039's order. Deployment, storage, Meta and n8n details link out rather than repeat. Commands come from the verified quickstart and are marked "(run on <date>)" or "(not run)" (US6-AS3). Owner-specific hostnames are removed (Owner answer 2). The current "Docker Compose", "Docker", "Neon" and "Running the scheduler" sections collapse into links to `docs/deployment.md`.

---

## 3. Still NEEDS RESEARCH (recorded, not guessed)

- **U1 — Unraid specifics:** stack management, appdata path, proxy apps. Labelled unverified in `docs/deployment.md` (D32).
- **U2 — Facebook Page publish limit:** not in `docs/research/meta.md`. The inventory says "no documented per-Page limit found; NEEDS RESEARCH". Only the account-level limit applies.
- **U3 — Bluesky rate figures are approximate:** the source page did not load. They are enforced as declared (D12) and marked approximate.
- **U4 — Caption-level limits not in research:** for example Instagram hashtag or mention counts, and Facebook link-preview rules. The inventory has a "Not in research" line per provider instead of a value.
- **U5 — CSP in a real browser:** whether any shipped screen triggers a console CSP violation can only be seen in a browser. Quickstart §6 has the check, and it is reported as run or not run (constitution II).
- **U6 — Docker availability in the implement environment** (F27). If it is unavailable, FR-037 and FR-035 are reported "not verified", and the exact steps are left ready for the owner.
