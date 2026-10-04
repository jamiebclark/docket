# Research: Facebook Pages and Instagram providers (Meta, part 1)

**Feature**: `005-meta-facebook-instagram` | **Date**: 2026-10-03 | **Plan**: [plan.md](./plan.md)

Sources used, in priority order (constitution I):

1. `docs/research/meta.md` (checked 2026-10-02). Authoritative for every Meta endpoint, scope, limit and token rule below that is marked **[R-meta]**.
2. The installed code: `src/providers/types.ts`, `src/providers/{validation,media}.ts`, `src/server/scheduler/*`, `src/server/services/accounts.ts`, `src/server/dal/{accounts,tokens,scope}.ts`, `src/server/env.ts`, `src/server/startup/index.ts`, `src/proxy.ts`, `src/lib/auth-gate.ts`.
3. Next.js 16.3.8 bundled docs: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` (Route Handlers, `GET(request)`), `.../04-functions/redirect.md` ("`redirect` also accepts absolute URLs and can be used to redirect to external links"; Server Action form posts get a 303; call `redirect` outside `try`).
4. `docs/decisions.md` (001–004) and `specs/004-bluesky-provider/research.md` for engine rules already settled.

No web access is available to this phase. Every fact that is not in (1)–(3) is listed under **NEEDS RESEARCH** with the interim value the implementation uses. Each interim value lives in **one constant** in the shared Meta module, is covered by mocked tests, and is recorded in `docs/decisions.md` as unverified. The `platform-researcher` agent should confirm them before the owner's live check.

---

## 1. Unknowns from the Technical Context and how they are resolved

There is no `NEEDS CLARIFICATION` left. The spec's R1–R6 and this plan's R7–R10 cannot be settled offline. Each is resolved as an interim decision, as the spec allows ("planning picks the conservative interim value shown, records it in `docs/decisions.md` as an assumption, and covers it with mocks").

| Id | Question | Interim decision (used by the code) | Where it lives |
|---|---|---|---|
| R1 | Text limits | Facebook **10,000** code points (conservative, well under limits commonly quoted). Instagram caption **2,200** code points. No hashtag or mention cap is enforced. | `facebook/capabilities.ts`, `instagram/capabilities.ts` |
| R2 | Facebook photo rules | JPEG and PNG accepted, output JPEG, **8,000,000** bytes, at most **10** photos per post. No alt text is sent to Facebook. | `facebook/capabilities.ts` |
| R3 | Graph error codes and body shape | Body read as `{ error: { message, type, code, error_subcode, is_transient, fbtrace_id } }`. Invalid token: code **190** [R-meta]. Rate limited: codes **4, 17, 32, 613**. Temporary: codes **1, 2**, or `is_transient: true`. Everything else with a parsed error is a rejection. | `meta/errors.ts` (`GRAPH_ERROR_TABLE`) |
| R4 | `scope` vs login configuration id | Both. When `META_LOGIN_CONFIG_ID` is set, the dialog gets `config_id` and **no** `scope`. Otherwise it gets `scope` with the five permissions. | `meta/oauth.ts` |
| R5 | `content_publishing_limit` fields, slot release, permalinks and post URLs | Request `fields=quota_usage,config` (the same names as Threads' limit endpoint [R-meta]). Read `data[0].quota_usage` (number) and `data[0].config.quota_total` (number), defaulting the total to 100. Anything else means "unknown". When full, retry no earlier than **1 hour** later. **No post URL** is stored for either provider (the URL would need an extra request, or a URL pattern that is not verified). | `instagram/quota.ts`, `facebook/publish.ts` |
| R6 | App secret proof | Not sent. `docs/meta-setup.md` says to leave "Require App Secret" off. | `docs/meta-setup.md` |
| R7 | Login dialog URL and code exchange | Dialog: `https://www.facebook.com/{META_GRAPH_VERSION}/dialog/oauth` with `client_id`, `redirect_uri`, `state`, `response_type=code`, plus `scope` or `config_id`. Exchange: `GET https://graph.facebook.com/{version}/oauth/access_token` with `client_id`, `client_secret`, `redirect_uri`, `code`, returning `{ access_token, token_type, expires_in? }`. Research only covers the **long-lived** exchange (`grant_type=fb_exchange_token`), which uses the same path. | `meta/oauth.ts` (`META_DIALOG_BASE`, `exchangeCode`) |
| R8 | Instagram display name | The research listing returns `instagram_business_account` as `{ id }` only. The display name is **"`<Page name>` · Instagram"**. A username lookup is deferred until the research covers it. | `meta/candidates.ts` |
| R9 | Pagination of `/me/accounts` | Request `limit=100`. Follow `paging.next` at most **4** times, only when its origin is `https://graph.facebook.com`, so at most 500 Pages. Stop silently after that, and the chooser says some Pages may be missing. | `meta/candidates.ts` |
| R10 | Request encoding, and keeping the token out of URLs | POSTs send every parameter, `access_token` included, as an `application/x-www-form-urlencoded` body. GETs must carry `access_token` in the query, because a bearer header is not in the research. URLs are never logged or summarised, and the client strips `access_token`, `client_secret`, `code` and `fb_exchange_token` from anything it reports. `attached_media` and `children` are sent as `attached_media=[{"media_fbid":"…"}]` (JSON, per research) and `children=<id>,<id>`. | `meta/graph.ts` |

**Why these are safe defaults.** Getting R1, R2 or R5 wrong at worst blocks a valid post, or skips a URL. Neither can cause a duplicate. R3 is the one with a duplicate-safety angle, and its default is conservative where it matters:

- On a `mayPublish` step, only a parsed **rate-limit** code is retryable. A rate-limited request is not executed.
- Temporary codes, unparsed errors and 5xx stay `ambiguous` on `mayPublish` steps, exactly as US6 requires.
- A wrong code list therefore causes a missed post or a human review, never a duplicate.

R7 and R10 affect only connect and request formatting. A mistake there fails loudly on the first live call. It cannot silently misbehave.

---

## 2. Decisions

### D1. Shared Meta module at `src/providers/meta/`, not registered

- **Decision**: `src/providers/meta/` holds `config.ts` (env), `graph.ts` (HTTP client), `errors.ts` (classification table), `oauth.ts` (dialog URL, code exchange, long-lived exchange), `candidates.ts` (Pages listing → candidates) and `connect-group.ts` (the `meta` connect group object both providers reference). It exports no `SocialProvider` and has no registry line. Everything is parameterised by a `MetaApp` value, `{ appId, appSecret, graphBase, dialogBase, version }`, so the Threads entry can build its own `MetaApp` (different app, `graph.threads.com` host, `th_exchange_token`) without copying code.
- **Rationale**: FR-001 and FR-004. `src/providers/**` must not import `src/server/**`, which the existing lint rule enforces. The module is a leaf like the providers.
- **Alternatives**: Put the shared code inside `facebook/` and import it from `instagram/`. Rejected because it couples two providers, and Threads would have to import from `facebook/`. A `src/server/meta/` module was rejected because providers could not import it.

### D2. Meta env settings are declared by the connect group (framework fix **G8**)

- **Decision**:
  - Env settings: `META_APP_ID`, `META_APP_SECRET` (all-or-none), `META_GRAPH_VERSION` (default `v26.0`, must match `^v\d{1,3}\.\d{1,2}$`) and the optional `META_LOGIN_CONFIG_ID` (digits).
  - They are parsed by `metaConfig(source)` in `meta/config.ts`. The function is pure and reads `process.env` by default. Issue messages carry names, never values.
  - A **connect group** declares an `environment` with:
    - `variables`: names and a `secret` flag, documentation only;
    - `issues(source): EnvIssue[]`;
    - `configured(source): boolean`.
  - A new generic `src/server/provider-env.ts` collects `issues` from every registered group. `runStartup` merges them with `parseEnv` issues into one formatted error, then exits.
  - `listConnectableProviders` hides a group whose `configured()` is false and reports "not configured".
- **Rationale**: FR-005 needs start-up validation with Zod and `.env.example` documentation (constitution VII). Adding `META_*` to `src/server/env.ts` would be Meta-specific code in the server, which FR-002 forbids. Importing the registry into `env.ts` would drag every provider (and `@atproto/api`) into every module that reads env. Startup already runs once before serving, so it is the right hook.
- **Alternatives**:
  - `META_*` in `env.ts`: rejected by FR-002.
  - Unvalidated `process.env` reads in the provider: rejected by constitution VII.
  - A provider-level `environment` instead of a group-level one: rejected because the settings belong to the shared app, not to one provider.
- **Recorded** in `docs/decisions.md` as G8. **Reverse**: delete `environment` from the group type and `provider-env.ts`, and move the group's checks into `env.ts`.

### D3. Generic OAuth connect (framework fix **G5**) — connect groups and candidates

- **Decision**:
  - `ConnectStrategy`'s `oauth` member becomes `{ strategy: "oauth"; group: OAuthConnectGroup }`. Several providers may reference the **same** group object.
  - The group (see [contracts/providers.md](./contracts/providers.md)) has:
    - `key` and `displayName`;
    - `environment`;
    - `authorizationUrl({ state, redirectUri })`;
    - `exchangeCode({ code, redirectUri, now, signal })`;
    - optional `describeCallbackError(params)`;
    - optional `pasteToken` (G6).
  - Each exchange returns `CandidatesResult = { ok: true; candidates; notices? } | { ok: false; message }`.
  - A `ConnectCandidate` carries `providerKey`, `externalId`, `displayName`, `settings`, `credentials`, `expiresAt`, optional `parent: { providerKey, externalId }` and `notes`.
  - The framework checks every candidate: its `providerKey` must be a registered provider in the same group, it is parsed through that provider's `settingsSchema`, and duplicates are dropped.
  - The accounts screen shows **one connect action per group**. The registry exports `listConnectGroups()`, which de-duplicates by `key`, and a registry test asserts that one key never maps to two different objects.
- **Rationale**: Spec G5 and FR-014. One Facebook login must yield accounts for two providers. Having candidates carry their own `providerKey` is the smallest generic shape that expresses this.
- **Alternatives**:
  - Each provider runs its own OAuth: rejected, two logins (US1).
  - A "meta" pseudo-provider that creates rows for others: rejected because it is not a provider, and it would need Meta code in the service.

### D4. Connect state lives in a new generic table `connect_attempts` (justified schema change)

- **Decision**: Add one migration with a project-owned table `connect_attempts`. The columns are in [data-model.md](./data-model.md):
  - `id`, `project_id`, `user_id`, `session_id`, `group_key`;
  - `state_hash` (unique, SHA-256 of a 32-byte random state);
  - `candidates_encrypted` (AES-256-GCM, AAD `connect_attempt:<id>`, null until the exchange succeeds and again after completion);
  - `expires_at` (created + 10 min);
  - `callback_at`, `completed_at`, `created_at`.
  - It is registered in `projectOwnedTables`. Lookups by state hash are cross-project with a reason, as for invitation tokens.
- **Rationale**: FR-010 says candidates and their tokens are "held only on the server, encrypted". The spec's G5 permits generic storage if justified.
  - A cookie is client-held. It would also overflow with many Page tokens (about 200+ characters each, 4 KB cookie limit).
  - Process memory breaks with two web instances, and on restart.
  - Better Auth's `verification` table belongs to Better Auth and has no project scope.
  - A table is the only option that is server-side, multi-instance safe, single-use under concurrency (a conditional `UPDATE … RETURNING`) and scoped.
- **Alternatives**:
  - An encrypted cookie: rejected for FR-010 and its size.
  - Storing state in `social_accounts`: rejected, because there is no row before the choice.
  - Redis: rejected by constitution VI.
- **Recorded** as a framework change in `docs/decisions.md`. **Reverse**: drop the table in a new migration and remove the repo.

### D5. State: unguessable, hashed, single-use, bound, 10 minutes

- **Decision**:
  - `state = randomBytes(32).toString("base64url")`. Only `sha256(state)` is stored.
  - The callback runs in this order:
    1. Checks the shape (`^[A-Za-z0-9_-]{43}$`).
    2. Looks the row up by hash (cross-project).
    3. Refuses it if it is missing, expired (`expires_at <= now`), already called back (`callback_at` set), or bound to a different `user_id` or `session_id`.
    4. Re-resolves the project scope with the current session and requires `account:manage`.
    5. Consumes the state with a conditional `UPDATE … SET callback_at = now WHERE id = $1 AND callback_at IS NULL AND expires_at > now AND user_id = $2 AND session_id = $3 RETURNING id`.
    6. Only then exchanges the code.
  - A replay or a racing second callback loses the `UPDATE` and is refused before any exchange (US2, SC-002).
  - The session id is Better Auth's `session.session.id`.
- **Rationale**: FR-007 and FR-008, US2 (a)–(f).
- **Alternatives**: Signed stateless state (HMAC). Rejected because it cannot be single-use without storage, and the storage exists anyway (D4).

### D6. One fixed callback address: `/connect/callback`

- **Decision**:
  - The redirect URI is `${BETTER_AUTH_URL}/connect/callback`, a Route Handler (`src/app/connect/callback/route.ts`, `GET`).
  - The path is **not** public in `auth-gate.ts`. A request without a session cookie goes to `/login?next=…`. After sign-in that session is new, so binding fails and the person is told to start again. That is safe, if a little unfriendly; it is rare and documented.
  - The browser keeps the session cookie on the top-level GET back from Facebook, because Better Auth's cookie is `SameSite=Lax`.
  - The accounts screen shows the address with the existing `CopyField` when Meta is not configured, and `docs/meta-setup.md` gives it too.
- **Rationale**: FR-006. The project travels in the state row, so one URI serves every project and every OAuth group.
- **Alternatives**:
  - A per-project path: rejected, because every project would need its own registered URI.
  - `/api/...`: rejected, because `/api/auth/*` and `/api/internal/*` are public prefixes, and keeping the callback under the session gate is simpler.

### D7. Start, choose and paste are Server Actions; the chooser is a page

- **Decision**:
  - `startOAuthConnectAction(slug, { groupKey })` creates the attempt and calls `redirect(authorizationUrl)`. The Next 16 docs say `redirect` accepts absolute external URLs, and Server Actions already carry Next's origin check.
  - The callback finishes with a 303-style redirect to `/p/<slug>/accounts/connect/<attemptId>`, or to `/p/<slug>/accounts?connect=<code>` on a handled failure. Codes are a fixed set (`cancelled`, `exchange_failed`, `no_candidates`, `not_allowed`), and the page maps each to a fixed message, so no platform text travels in a URL.
  - An unknown, expired, reused or foreign state redirects to `/connect/invalid`. That small page says "This connection attempt has expired or is not valid. Start again." and links to the projects list. The project is not revealed.
  - The chooser page (`/p/[slug]/accounts/connect/[attemptId]`) is a server component. It decrypts the candidates on the server, drops credentials and renders only `{ providerKey, externalId, displayName, parent, notes, alreadyConnected }`. A small client form submits `chooseConnectCandidatesAction`.
  - `pasteConnectTokenAction(slug, { groupKey, token, accountId? })` runs the group's `pasteToken.exchange`, creates a ready attempt (state hash random, never issued; `callback_at` = now) and redirects to the chooser.
- **Rationale**: These follow 003/004 conventions: server components by default, client leaves for forms, `runAction` for errors, and the `docket-ui` skill.
- **Alternatives**: A Route Handler for start. Rejected because a GET start link is CSRF-able (it could drop someone into a login flow), and a POST route handler would duplicate Next's Server Action origin check.

### D8. Choosing saves accounts atomically and discards every candidate token

- **Decision**: `chooseConnectCandidates(scope, { attemptId, selected[] })` runs in one project transaction:
  1. It locks the attempt `FOR UPDATE` and requires it to be the same user and session, `callback_at` set, `completed_at` null and `expires_at > now`.
  2. It decrypts the candidates and keeps those whose `(providerKey, externalId)` is selected. An unknown selection is refused.
  3. It upserts each kept candidate through the existing `upsertConnected` + `setCredentials` path, which is what `saveConnectedAccount` does, reused by extracting its transaction body into `saveConnectedAccountTx(tx, …)`.
  4. It sets `completed_at = now` and `candidates_encrypted = null`.
  - Selecting nothing is allowed. It just discards the attempt ("Nothing was connected").
- **Rationale**: FR-010, FR-011 and US1 AS3/AS5. Doing it all in one transaction means a failure saves nothing and leaves the attempt usable until expiry. The unique index `social_accounts_external_uq` plus update-in-place handles re-choosing a connected account.
- **Alternatives**: Calling `saveConnectedAccount` once per account (a separate transaction each). Rejected because a partial save is possible.

### D9. Discarding expired attempts

- **Decision**: Expired attempts are unreadable at once, because every read requires `expires_at > now`. Their rows (and ciphertext) are deleted by `purgeExpiredConnectAttempts()`, a cross-project `DELETE … WHERE expires_at < now() - interval '1 hour'` with the reason "purge expired connect attempts". It runs at the start of every `startOAuthConnect`, `pasteConnectToken` and callback, and it does not touch the scheduler.
- **Rationale**: FR-010 and US2 AS5 ("held candidate tokens are discarded"). The purge piggybacks on connect traffic, so the scheduler is untouched. The ciphertext is useless without the key and is never read after expiry.
- **Alternatives**: A scheduler section. Rejected because it is a scheduler change for housekeeping. **Accepted limit**: in a deployment where nobody connects again, expired encrypted rows stay until the next connect. Recorded.

### D10. Manual token paste (framework fix **G6**)

- **Decision**:
  - The group's optional `pasteToken: { field: CredentialField; help; exchange({ token, now, signal }) → CandidatesResult }` is how a pasted token produces candidates.
  - For Meta, `exchange`:
    1. calls the long-lived exchange [R-meta] with the pasted token;
    2. lists Pages with the long-lived user token;
    3. builds candidates.
  - Neither the pasted token nor the long-lived user token is returned, stored or logged. The token is trimmed and must be 20–2048 characters of `[A-Za-z0-9_.|-]`; anything else is refused before any request.
  - The form clears its field after submit (US8 AS2).
  - Reconnect uses the same paste or the same login. The chooser marks the existing account "already connected" and updates it in place (US7 AS2).
- **Rationale**: The spec's G6, FR-013 and US8.
- **Alternatives**: Extending `manual-token` + `connectAccount` to return several accounts. Rejected because the token belongs to the group, not to one provider.

### D11. Credentials-invalid result flag (framework fix **G7**)

- **Decision**:
  - `fatal_error` gains `credentialsInvalid?: true`. When it is set, the engine (`publishing.ts`, after `recordStepResult`) calls a new `accounts.markCredentialsInvalid(id, { expectedCiphertext, reason })`. That is one conditional `UPDATE`: `status = 'needs_reauth'`, `last_error = reason`, **only while** `credentials_encrypted = expectedCiphertext` and `removed_at IS NULL`. A reconnect that landed meanwhile is therefore never flagged by a stale token.
  - The target's error becomes `Reconnect <account name> to publish: <reason>`.
  - Nothing is retried, and no refresh is attempted.
  - Because `fatal_error` is never `ambiguous`, a provider may return it from a `mayPublish` step only when the platform's error response proves nothing was published. A Graph error body with code 190 does.
- **Rationale**: The spec's G7, FR-017 and US7.
  - The existing `credentialsExpired` asks for a refresh that Page tokens do not have.
  - `fatal_error` gives "no automatic retry" for free.
  - Other targets of the account then hit the existing claim rule (`status !== 'active'` → failed without a provider call). That satisfies "other due targets are not sent".
- **Alternatives**:
  - A new `StepResult` kind: rejected as a larger change for every consumer.
  - Overloading `credentialsExpired` without a `refreshCredentials` hook: rejected because the meaning is unclear.
- **Reverse**: Ignore the flag in `publishing.ts`.

### D12. Graph client with typed outcomes

- **Decision**: `graphRequest(app, { method, path, params, token?, signal })` builds `https://graph.facebook.com/{version}/{path}` from the `MetaApp`. Its only side effect is one `fetch`. It returns a discriminated `GraphOutcome`:
  - `ok` with `status` and the parsed JSON `body`;
  - `graph_error` with `status` and `{ code, subcode, type, message, traceId, transient }`;
  - `http_error`: a non-2xx without a parseable Graph error;
  - `unparseable`: a 2xx that is not JSON;
  - `network` with `phase: "before_send" | "after_send"`. `before_send` means `ECONNREFUSED`, `ENOTFOUND` or `EAI_AGAIN` in the cause chain (the same rule as Bluesky). Everything else, aborts and timeouts included, is `after_send`.

  `classifyGraph(outcome, { mayPublish, now })` in `errors.ts` maps every outcome to a `StepResult` error, or returns null for `ok`. It implements US6 and FR-016 in **one** place. Every message is built from the Graph `message`, run through the shared redaction (tokens, `code`, the app secret), and capped at 500 characters.
- **Rationale**: FR-015, FR-016 and FR-032. Both providers share it, and Threads will too.
- **Alternatives**: A Meta SDK. Rejected because none is installed (constitution VI), and the surface is small.

**Classification table** (`mayPublish` = M; ✱ marks interim R3 code lists):

| Outcome | Non-publishing step | `mayPublish` step |
|---|---|---|
| `network` before send | `retryable_error` | `retryable_error` |
| `network` after send (timeout, abort, reset) | `retryable_error` | `ambiguous` |
| `http_error` 5xx / `unparseable` 2xx / `ok` without the expected id | `retryable_error` | `ambiguous` |
| `graph_error` code 190 | `fatal_error` + `credentialsInvalid` | `fatal_error` + `credentialsInvalid` |
| `graph_error` rate limit ✱ (4, 17, 32, 613) | `retryable_error` | `retryable_error` |
| `graph_error` temporary ✱ (1, 2, `is_transient`) | `retryable_error` | `ambiguous` |
| `graph_error` other, or `http_error` 4xx | `fatal_error` | `fatal_error` |

- **Rate limits and `notBefore`**: The research documents no reset header for Graph, so `notBefore` is left unset and the engine's backoff applies. That is US6 AS4: "the engine's backoff otherwise".
- **Status 429 without a Graph body**: this is `retryable_error` on any step, because a 429 means the request was refused. It matches the 004 table, which classes 429 like a 5xx before create.

### D13. Facebook publishing

- **Decision**: Three shapes, chosen by `stepFor(state, settings, content)` from `content.mediaCount` (G4):

| Content | Steps | `mayPublish` |
|---|---|---|
| text (0 images) | `publish_feed`: `POST /{page-id}/feed` with `message`, plus `link` = the first `https?://` URL in the text | yes |
| 1 image | `publish_photo`: `POST /{page-id}/photos` with `url`, `caption` | yes |
| N images (2–10) | `upload_photo_<i>` × N: `POST /{page-id}/photos` with `url`, `published=false` (state keeps `photoIds[]`), then `publish_feed` with `message` + `attached_media=[{"media_fbid":…}…]` **(U1)** | only the last |

  - Images take precedence over the link, so a post with images sends no `link`.
  - The first-URL regex is `https?:\/\/[^\s<>"]+`, with trailing `.,;:!?)]}'"` trimmed.
  - Success is `done` with `externalId = body.post_id ?? body.id` (photo) or `body.id` (feed). There is no URL (R5).
  - Native scheduling parameters are never sent (FR-022), and a unit test asserts that `scheduled_publish_time` never appears in a request.
- **Rationale**: [R-meta], FR-018–FR-023 and the spec's edge cases.

### D14. Instagram step machine

- **Decision**: State is `{ v: 1, mediaType: "IMAGE" | "CAROUSEL", items: string[], container: string | null, createdAt: ISO | null, checks: number, ready: boolean, quotaChecked: boolean, recreations: number }` (plain, non-secret). [data-model.md](./data-model.md) gives the exact schema. `stepFor`:

| State | Step | `mayPublish` |
|---|---|---|
| `null` or invalid, with 1 image | `create_container` | no |
| `null`, N images (2–10) | `create_item_1` | no |
| `items.length < N`, carousel | `create_item_<items.length+1>` | no |
| carousel, all items, no `container` | `create_carousel` | no |
| `container` set and not yet `FINISHED` (`ready` false) | `check_status` | no |
| `ready: true`, `quotaChecked` false | `check_quota` | no |
| `quotaChecked: true` | `publish` | **yes** |
| 0 images or more than 10 | `invalid` (advance → `fatal_error`) | no |

  - **Create**: `POST /{ig-id}/media` with `image_url` (the variant's public URL), `alt_text` (when non-empty), and `caption` on the single-image or carousel container only. Carousel items are sent with `is_carousel_item=true`. The carousel container gets `media_type=CAROUSEL`, `children=<ids in order>` and `caption`. The first status check is set for `createdAt + 10 s`.
  - **`check_status`**: `GET /{container}?fields=status_code`.
    - `IN_PROGRESS`: `continue`, with `checks + 1` and `notBefore = now + min(10 s × 2^checks, 300 s)` (10, 20, 40, 80, 160, 300, 300 …).
    - `FINISHED`: `continue` with `ready: true` and no delay.
    - `ERROR`: `fatal_error` "Instagram could not process the media", plus the redacted status message when one is present.
    - `EXPIRED`: if `recreations < 2`, `continue` with fresh state (`items: []`, `container: null`, `recreations + 1`). Otherwise `fatal_error`.
    - `PUBLISHED`: `ambiguous`.
    - Anything still `IN_PROGRESS` 60 minutes after `createdAt` is `fatal_error` "Instagram did not finish processing the media."
  - **`check_quota`**: `GET /{ig-id}/content_publishing_limit?fields=quota_usage,config` (R5).
    - Usage at or over the total: `retryable_error` with `notBefore = now + 1 h`. The summary records `{ quotaUsage, quotaTotal }`.
    - Unreadable (any non-ok outcome except 190, or a bad shape): `continue` to `publish` with `quota: "unknown"` in the summary.
    - 190: `credentialsInvalid`.
    - Container age guard: if `now − createdAt ≥ 23 h`, the container would expire before or while publishing. No publish has been sent, so the step recreates it (the same rule and the same cap of 2) instead of reading the quota (US5 AS4).
  - **`publish`**: `POST /{ig-id}/media_publish` with `creation_id`. A 2xx `{ id }` is `done` with `externalId = id`. Every other outcome follows the table in D12.
- **Rationale**:
  - FR-026–FR-031 and SC-004/SC-005.
  - Each step makes exactly one request. A single-image post whose container is ready at the first check takes 4 ticks (create, check, quota, publish). A carousel takes N + 4.
  - `mediaType` in state, plus step names keyed by kind, let a later `VIDEO`/`REELS` kind add its own create step and polling cadence without a scheduler change (US4 AS10).
- **Why the quota check is a separate step**: SC-005 allows one request per step, and the check must be the last thing before `publish`.

### D15. Instagram validation

- **Decision**: `validateInstagram` = `validateAgainstCapabilities(content, caps)` with these changes:
  - `text_only_not_allowed` is renamed to **`media_required`** (blocking), with the message "Instagram posts need at least one image." (US9 AS1);
  - plus an `info` issue `carousel_crop` when the carousel images' aspect ratios differ by more than 0.01 (FR-025);
  - an empty caption with images is allowed.
  - Conversion, compression and downscaling notes, and the aspect-ratio errors, come from 003's `planImage` through `validateTargetContent` (already in the composer and gates), driven by the capabilities: `allowedMimeTypes: ["image/jpeg"]`, `outputMimeType: "image/jpeg"`, `maxBytesPerFile: 8_000_000`, `maxWidth: 1440`, `minAspectRatio: 0.8`, `maxAspectRatio: 1.91`, `maxAltTextLength: 1000`. There is no `minWidth`, because Meta scales narrow images [R-meta].
- **Rationale**: FR-024, FR-025 and US9. Image adaptation is never re-implemented in a provider (`docs/adding-a-provider.md` §3).

### D16. Candidates from the Pages listing

- **Decision**: `GET /me/accounts?fields=id,name,access_token,instagram_business_account&limit=100` [R-meta] with the long-lived user token, following pagination per R9. For each Page with an id, name and token:
  - a `facebook` candidate: externalId = Page id, name = Page name, credentials `{ pageToken }`, settings `{}`, `expiresAt: null`;
  - if `instagram_business_account.id` is present, an `instagram` candidate: externalId = IG id, name per R8, settings `{ pageId }`, credentials `{ pageToken }` (the linked Page's token, per decision 3), `parent = facebook:<pageId>`;
  - otherwise the Page candidate carries the note "No Instagram professional account is linked."

  Malformed entries are skipped. If there are no Pages, the result is `{ ok: false, message: "No Facebook Pages were found for this login. The token needs pages_show_list, pages_manage_posts, pages_read_engagement, instagram_basic and instagram_content_publish." }` (US8 AS3).

  The chooser also lists the project's `needs_reauth` accounts in this group that are **not** among the candidates, with the note "`<name>` was not found for this login" (US7 AS3).
- **Rationale**: FR-009, FR-011 and FR-012. Credentials hold only the Page token. The long-lived user token is dropped after the listing (FR-012).

### D17. Secrets

- **Decision**: Secrets are the app secret, the authorization `code`, the short-lived and long-lived user tokens, pasted tokens and Page tokens.
  - They exist only in request bodies and query strings built inside `graph.ts`/`oauth.ts`, in `candidates_encrypted` and in `social_accounts.credentials_encrypted`.
  - `graph.ts` never puts a URL or request body into an outcome.
  - Messages are built from the Graph `message`, run through a `scrub(text, secrets)` that replaces any known secret, plus any `access_token=…`/`client_secret=…`/`code=…` pattern, with `[redacted]`.
  - Connect and paste results never include tokens.
  - `pageToken` keys match the engine's `SENSITIVE_KEY` regex, so `redact()` stays a backstop, and the engine's `secretValues(credentials)` already covers the Page token.
  - A dedicated test (`tests/integration/meta/no-secrets.test.ts`) scans attempts, step state, `last_error`, account rows (outside the ciphertext), `connect_attempts` (outside the ciphertext), action results, rendered chooser HTML and captured `console` output for every fake secret.
- **Rationale**: FR-033, FR-034, SC-007 and constitution VII.

### D18. Tests: one scripted Graph fake

- **Decision**: `tests/helpers/fake-graph.ts`, modelled on `fake-pds.ts`, is a `fetch` stub keyed by method + path, with the version prefix stripped. It scripts status, JSON, raw text, a hang until abort, a reset mid-body (the body stream errors), and pre-send failures (`ECONNREFUSED`). It records requests with their parsed form bodies and query, so tests can assert on parameters and on `scheduled_publish_time` never being sent. Provider unit tests call `advance` directly. Integration tests drive `runTick` against Postgres, and the connect flow through the actions and the route handler (Next modules mocked as in `tests/helpers/actions.ts`).
- **Rationale**: FR-035, constitution II. There are no live calls.

---

## 3. Unverified items (reported as "verified with mocks only")

| Id | Item | How covered |
|---|---|---|
| U1 | Facebook multi-photo posts (unpublished photos + `attached_media`) | Mocked request sequence. Flagged in docs, decisions, the README and the PR. |
| U2 | `http://localhost` redirect in development mode with "Enforce HTTPS" on | `docs/meta-setup.md` gives a test procedure and two fallbacks (hosts-file + mkcert, and token paste). |
| U3 | Live connect and publish for both providers | Mocks only. The owner's live check is quickstart §8. |
| R1–R10 | Interim values above | Single constants plus mocked tests, recorded in `docs/decisions.md`. |
