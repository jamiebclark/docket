# Research: X provider (014)

Phase 0 of `/speckit-plan`. Platform facts come only from `docs/research/x.md`, checked 2026-10-06 (constitution I). Framework facts come from the current code, read while planning (paths cited). Runtime facts were checked on the installed Node 24.16 (noted where so). The plan's Technical Context had no `NEEDS CLARIFICATION`. This file records the design decisions and the interim values the spec asks for.

## 1. Framework facts checked while planning

| # | Fact | Where |
|---|---|---|
| F1 | `exchangeCode` receives `{ code, redirectUri, now, signal }` and no `state`. The raw state exists only in `startOAuthConnect` (handed to `authorizationUrl`) and in `handleOAuthCallback` (validated with `isWellFormedToken`, matched by hash, bound to user and session, consumed by one conditional UPDATE). `connect_attempts` stores only `stateHash`. | `src/providers/types.ts`, `src/server/services/connect.ts` |
| F2 | The state is `randomBytes(32).toString("base64url")`, which is 43 characters. That is under X's 500-character limit. | `src/server/crypto/tokens.ts` |
| F3 | `proxy.ts` calls every group's `authorizationUrl({ state: "x", redirectUri })` once to learn the CSP `form-action` origins. A throw (not configured) is caught. Proxy runs on the **Node.js runtime** by default in Next 16, so `node:crypto` is available there. | `src/proxy.ts`, `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` §Runtime |
| F4 | After a failed exchange, the callback shows the generic `exchange_failed` banner ("Could not finish signing in. Check the app id, secret and redirect address in the setup guide.") plus the group's `callbackHint` (G12). The provider's own `message` is not shown. | `src/app/p/[projectSlug]/accounts/page.tsx`, `services/connect.ts` |
| F5 | A `continue` result persists `state`, resets `attemptCount` and releases the lease. A target is handled at most once per tick, so each step costs one tick (`WORKER_INTERVAL_SECONDS`, default 60). | `scheduler/record.ts`, `scheduler/publishing.ts` |
| F6 | One `advance` call gets one `AbortSignal.timeout(SCHEDULER_PROVIDER_TIMEOUT_SECONDS)` (default 10 s, max 20 s) for all of its requests. | `scheduler/publishing.ts`, `server/env.ts` |
| F7 | Publish-time refresh (G2) runs before `advance` when `needsRefresh` is true. A transient failure becomes `retryable_error` with `notBefore = retryAt`. The scheduled section holds the refresh lease until `retryAt` (G11, `holdTransient: true`) and renews accounts whose `credentials_expires_at` falls within `TOKEN_REFRESH_WINDOW_HOURS`. | `scheduler/publishing.ts`, `scheduler/token-refresh.ts` |
| F8 | `secretValues(credentials)` collects every string leaf of at least 4 characters for redaction. Numbers are not collected, so timestamps should be stored as numbers (as Threads does). | `scheduler/redact.ts` |
| F9 | `stepFor` receives `content: { text, mediaCount }` only. It sees no alt text, no `now` and no media bytes. | `src/providers/types.ts` |
| F10 | The limits inventory test matches a `## <Heading>` to a provider by the first word of `displayName` ("X" → `## X`). Its generated text-length row is `"a".repeat(maxLength + 1)`, which counts 281 under `x-weighted`. | `tests/integration/docs/limits-inventory.test.ts`, `tests/helpers/limit-rows.ts` |
| F11 | The icon generator reads `node_modules/simple-icons/icons/<slug>.svg` and finds the entry by title or slug. Simple Icons 16.34.0 has slug `x`, title `X`, hex `000000`. | `scripts/generate-icons.mjs`, main checkout `node_modules/simple-icons` |
| F12 | The Unraid template test requires every optional `Variable` to have an empty `Default` and value, and every `Target` to be a known variable (registered group variables count as known). | `tests/integration/docs/deployment.test.ts` |
| F13 | The provider-guide doc test checks that every `OAuthConnectGroup` member, including nested input fields, appears in backticks in the guide, and that G1–G14 are mentioned. | `tests/integration/docs/provider-guide.test.ts` |
| F14 | This worktree has no `node_modules`. The main checkout does. Phases cannot reach the npm registry (decision #19). | `ls` while planning |

Runtime checks on Node 24.16 (planning):

- An HMAC-SHA256 digest in `base64url` is 43 characters, all in the RFC 7636 unreserved alphabet.
- `/^\p{RGI_Emoji}$/v` matches a ZWJ family, a flag, a keycap (`1️⃣`), a skin-tone emoji and `❤️`. It does **not** match a bare `©` (U+00A9, which has no VS16). `Intl.Segmenter` (grapheme) yields each of those emoji as one segment.

## 2. Design decisions

### D1. G17: carry the PKCE verifier by deriving it from the attempt's state

- **Decision:** Add `state: string` to `exchangeCode`'s input. `handleOAuthCallback` passes the state it has already validated and consumed. X derives:
  - `verifier = base64url(HMAC-SHA256(key = X_CLIENT_SECRET, "docket:x:pkce:v1:" + state))`, which is 43 characters;
  - `challenge = base64url(SHA-256(ASCII(verifier)))`.

  `authorizationUrl` computes the challenge and `exchangeCode` recomputes the verifier. The verifier is never stored or sent to the browser.
- **Rationale:**
  - No schema change.
  - The state is already random, single-use and bound to the user, session and project (F1).
  - An attacker who sees the state (it is in the browser URL) cannot derive the verifier without the client secret.
  - An authorization code injected into another session fails, because that session's state gives a different verifier.
  - Meta and Threads ignore the new field, so they behave exactly as before.
  - `node:crypto` works in both callers (F3).
  - The domain-separation prefix and the `v1` tag let the derivation change later without a framework change.
- **Alternatives considered:**
  - An encrypted per-attempt secret column on `connect_attempts`: a schema change plus a migration for one provider. Rejected because the derivation meets RFC 7636 without it.
  - A cookie: rejected by G5's own reasons (several instances, size, binding).
  - A framework-derived secret keyed by `CREDENTIALS_ENCRYPTION_KEY` and passed to both hooks: more framework surface (a new input on two hooks plus a server-side derivation). Rejected as larger than needed.
  - PKCE `plain` with verifier = state: rejected, because the state reaches the browser and the spec requires S256.
- **Reverse:** remove `state` from the `exchangeCode` input and the one argument in `connect.ts`. X would then need the column alternative.
- **Edge accepted:** if `X_CLIENT_SECRET` changes during a 10-minute attempt, the exchange fails and the user starts again.

### D2. Media upload: one step uploads an image, separate steps poll and describe

- **Decision:** Per image N, in order:
  1. `upload_image_N` (non-publishing). Runs `initialize` → `append` (`segment_index` 0, whole file, multipart) → `finalize` in one `advance`. Only the append carries image bytes (FR-024). Image bytes are read from the media URL first, as Bluesky does.
  2. `check_image_N` (non-publishing), only while finalize or STATUS reports `pending` or `in_progress`. One STATUS request. Returns `continue` with `notBefore = now + check_after_secs`.
  3. `describe_image_N` (non-publishing), only when the image had alt text at upload time. One `POST /2/media/metadata`.

  Then `create_post` (`mayPublish`).
- **Rationale:**
  - One step costs one tick (F5). A step per request would take 3–5 minutes per image.
  - initialize and finalize are small JSON calls, so three round trips plus one ≤5 MB upload fit the shared 10 s signal (F6) in normal conditions.
  - A failure in the middle returns `retryable_error`, which persists no state, so the image restarts from `initialize`. The orphaned media id expires on X's side. Upload cost is UNVERIFIED (U5) and is noted in the setup guide.
  - Alt text is a separate step, so a metadata failure never re-uploads the bytes.
- **Alternatives considered:**
  - One request per step: too slow (up to 17 ticks for four described images).
  - Upload plus metadata in one step: four requests in 10 s, and a metadata failure would redo the upload.
  - The one-shot `POST /2/media/upload`: its schema is UNVERIFIED (U1), and the spec forbids it.

### D3. Where "does this image need alt text" and media expiry are decided

- **Decision:** `stepFor` cannot see alt text or the time (F9), so:
  - `upload_image_N` records `alt: true|false` for the image in state, from `ctx.content.media[N-1].altText.trim() !== ""` at upload time. `stepFor` reads it.
  - `describe_image_N` sends the current alt text. If that alt text is now empty, it records the image as described and sends nothing.
  - Expiry is checked in `create_post`'s `advance`, **before** the request is built. If any image's `expiresAt` is within `X_MEDIA_EXPIRY_MARGIN_MS` (60 s) of `now`, the step returns `continue` with the state cut back to the images before the first expired one. `stepFor` then names `upload_image_k`. No request is sent, so this cannot publish.
- **Rationale:**
  - It keeps `stepFor` pure and total.
  - The expiry check happens at the only point where it matters, just before the post would attach the ids.
  - A `continue` from a `mayPublish` step is allowed (F5). It is safe because nothing was sent.
- **Alternative:** an extra non-publishing `check_media` step before `create_post`. Rejected: it costs a tick on every image post.

### D4. Results of `create_post` and the 429 rule

These follow FR-029 and FR-031. The transport outcome comes from one in-house fetch wrapper (`x/http.ts`), using the same pre-send detection as `meta/graph.ts`:

- **Not sent:** `fetch` rejected with a cause code of `ECONNREFUSED`, `ENOTFOUND` or `EAI_AGAIN` → `retryable_error`.
- **Lost:** a timeout or abort after sending, any other rejection, or a body that fails mid-read → `ambiguous` on `create_post`, `retryable_error` elsewhere.
- **Response:**
  - a 2xx with a readable string `data.id` → `done`;
  - any other 2xx → `ambiguous`;
  - 5xx → `ambiguous` on create, `retryable_error` elsewhere;
  - 401 → `retryable_error` with `credentialsExpired`;
  - 403 → `fatal_error` (create);
  - 429 → see below;
  - any other 4xx → `fatal_error`.

For a 429:

- `x-rate-limit-remaining: 0` with a readable `x-rate-limit-reset` (Unix seconds) → `notBefore` = that reset.
- Otherwise the message says X's rate limit or usage cap was hit (credits or the spending limit may be exhausted), and `notBefore = max(reset, now + X_USAGE_CAP_WAIT_MS)`, where the constant is 1 hour.

A 429 or 401 on `create_post` is retryable because X refused the request: it was not executed. The 005 precedent applies.

The duplicate message is shown when X's `detail` matches `/duplicate/i`. Matching is on status first (U2).

### D5. Token endpoint outcomes (exchange and refresh)

- **Success:** a 2xx whose JSON has a string `access_token`.
  - `expires_in`, when it is a positive number, else 7,200 s.
  - `refresh_token` is required at exchange. Without it the exchange is refused with "offline access was not granted".
  - `scope` is optional; when present it drives the FR-011 notes.
- **Refresh success without a `refresh_token`:** store the new access token and keep the old refresh token and its issue time.
  - *Why:* this keeps a working access token. If X did consume the old token, the next renewal is refused with `invalid_grant` and the account is flagged `needs_reauth`, which is the same recovery as the lost-reply edge case.
  - This is an interim judgement, logged in decisions.
- **Definitive refusal:** a 4xx whose JSON `error` is one of `invalid_grant`, `invalid_client`, `unauthorized_client`, `invalid_request`, `invalid_scope` (the RFC 6749 shape; X's exact body is UNVERIFIED, U3).
  - `invalid_client` and `unauthorized_client` name `X_CLIENT_ID` / `X_CLIENT_SECRET`.
  - At exchange this is a refusal that saves nothing. At refresh it is `ok: false` without `transient`, so the account is flagged `needs_reauth`.
- **Transient (refresh), "X could not be reached" (exchange):** 5xx, 429, a network error, a timeout, or an unreadable reply of any status.
  - Refresh `retryAt`: the `x-rate-limit-reset` time for a 429 when readable, otherwise `now + X_REFRESH_RETRY_MS` (5 minutes).
  - *Risk accepted (spec FR-014):* a permanently broken client could retry every 5 minutes. Each retry is one request under the G11 hold, and the targets fail visibly meanwhile.
- **Exchange refusal messages:** "Could not finish signing in with X (<reason>). Check X_CLIENT_ID, X_CLIENT_SECRET and the callback address (<docs link>)". The callback banner shows the generic text (F4), so the group also sets `callbackHint`: "If X refused the sign-in, check that the app's callback address matches exactly and that its permissions are Read and write."

### D6. `x-weighted` counting

All inputs are from `docs/research/x.md` (twitter-text v3).

**Algorithm.** Pure, total, linear.

1. `t = text.normalize("NFC")`. Return 0 for a non-string.
2. Find URL spans (D7). Each counts 23.
3. Split the rest into grapheme clusters with `Intl.Segmenter` (granularity grapheme).
   - A cluster matching `/^\p{RGI_Emoji}$/v` counts 2.
   - Any other cluster counts the sum over its code points: 1 when the code point is in 0–4351, 8192–8205, 8208–8223 or 8242–8247, and 2 otherwise.
4. Wrap the whole thing in `try`/`catch`. On an unexpected error, fall back to the code-point sum with weight 2 per code point, an over-estimate that never under-counts.

**Why RGI_Emoji.** It recognises every "emoji regardless of complexity" case the spec lists (ZWJ, flags, keycaps, skin tones), and it is built in.

**Drift accepted.** A text-presentation symbol such as a bare `©` counts by its code point (1). X's own emoji parser may treat some such symbols differently. The near-limit warning covers this (D8).

**Alternatives considered:**

- `\p{Extended_Pictographic}`: misses flags and keycaps (checked: false for `🇬🇧`, `1️⃣`).
- The `twitter-text` dependency: it looks unmaintained (research) and constitution VI applies. Rejected, as the spec says.

### D7. URL detection for counting

- **Decision:** One regular expression, built from a TLD list in `src/providers/x/tlds.ts`.
  - **Scheme form:** `https?://` followed by non-space characters.
  - **Scheme-less form:** at the start of the text or after a character that is not a letter, digit, `@`, `.`, `/` or `_`, then `(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+<tld>`, matched case-insensitively. The match must not be followed by a letter, digit or `-`. An optional `:port`, path, query and fragment follow, running to the next whitespace.
  - **Trailing characters:** sentence punctuation (`. , ; : ! ? ' "`) and a closing bracket without a matching opener inside the URL are removed from the end of the match.
- **TLD list:** generic TLDs (`com net org info biz io co ai app dev me tv xyz edu gov mil int` and a few dozen common gTLDs) plus every two-letter country code that appears in the spec's examples or is in common use. The full list is fixed in the file, lower case, and covered by a test that shows `example.com`, `www.example.org/path` and `bbc.co.uk` count 23 and `file.txt` and `v1.2` do not.
- **Rationale:** FR-019 asks for a fixed list kept in the provider folder. This is an approximation of twitter-text's validator. Drift is accepted (spec assumption) and covered by the warning.
- **Alternative considered:** the full IANA list (~1,500 entries). Rejected: a large, stale-prone file for little gain against a parser Docket cannot match exactly anyway.

### D8. `validate`

- The shared `validateAgainstCapabilities(content, caps)` handles the counting rule, images, types, bytes, alt text and the empty-post rule.
- The media planner turns oversize images and unaccepted types into notes, as `validateThreads` does with `mediaConstraintsOf` and `planImage`.
- X adds one `warning`, code `x_count_may_differ`, when `countXText(text) > X_COUNT_WARNING_THRESHOLD` (270) and the text has a URL span or an emoji cluster. Message: "X counts links and emoji its own way; this post is close to the 280 limit and X's count may differ slightly."
- A warning never blocks.

### D9. Capabilities and publish limit

- **Capabilities (FR-021):**
  - text: `maxLength: 280`, `countingRule: xCountingRule`;
  - media: `maxImages: 4`, `allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"]`, `outputMimeType: "image/jpeg"`, `maxBytesPerFile: 5_000_000`, `maxAltTextLength: 1000`, `required: false`;
  - `textOnlyAllowed: true`;
  - `postTypes: ["text", "image", "carousel"]`.
- No dimension limits: none is in the research.
- **Publish limit:** `defaultPublishLimit: { count: 100, windowSeconds: 900 }`.
- **Per-app limit:** the 10,000 / 24 h per-app limit is documented only.

### D10. Interim values (one constant each, all in `src/providers/x/config.ts`)

| Constant | Value | Why |
|---|---|---|
| `X_REFRESH_TOKEN_LIFETIME_MS` | 180 days | "~6 months" (U3). Account `credentials_expires_at` = issue + this, so the scheduled refresh (72 h window) renews an idle account at about day 177. |
| `X_REFRESH_MARGIN_MS` | 5 minutes | `needsRefresh` margin for the 2 h access token (research "about 5 minutes"). |
| `X_REFRESH_RETRY_MS` | 5 minutes | `retryAt` for a transient refresh without a readable reset. Short enough not to stall publishing for long (F7). |
| `X_DEFAULT_ACCESS_SECONDS` | 7,200 | `expires_in` default. |
| `X_USAGE_CAP_WAIT_MS` | 1 hour | 429 not attributable to the rate window (FR-031). |
| `X_COUNT_WARNING_THRESHOLD` | 270 | FR-020. |
| `X_MEDIA_EXPIRY_MARGIN_MS` | 60 s | Redo uploads whose id expires within a minute of create (D3). |
| `X_DEFAULT_MEDIA_EXPIRY_SECONDS` | 3,600 | Used when neither initialize nor finalize returned a readable `expires_after_secs`; conservative, so an unknown expiry leads to a re-upload, not a rejected post. |
| `X_DEFAULT_CHECK_AFTER_SECONDS` / `X_MAX_CHECK_AFTER_SECONDS` | 5 / 300 | `check_after_secs` when missing / upper bound on a single wait. |
| `X_MAX_STATUS_CHECKS` | 30 | After 30 STATUS polls still pending, the step fails fatally ("X did not finish processing image N"). |
| `X_ERROR_DETAIL_MAX` | 300 characters | X's `title`/`detail` are truncated and scrubbed before display. |

### D11. Hosts are constants, not configuration

`https://api.x.com` and `https://x.com/i/oauth2/authorize` are fixed constants. There is no `X_API_BASE`.

- **Why:** the research names one host. Threads' `THREADS_GRAPH_BASE` existed only because its host was unverified.
- **Tests:** they stub `fetch` and match on the URL, so no override is needed.

### D12. Shared helpers: self-contained provider folder

`src/providers/x/` imports only `../types`, `../validation`, `../media`, `../text` and `@/lib/docs`, all generic. It has its own small `scrub` and fetch wrapper.

- **Why:** X is not a Meta product, so coupling it to `meta/` would make a Meta refactor break X.
- **Cost:** about 40 lines of similar helper code, accepted.

### D13. Post URL

- `https://x.com/<username>/status/<id>` when `settings.username` matches `^[A-Za-z0-9_]{1,15}$`.
- Otherwise `https://x.com/i/status/<id>`.
- U6 is listed in the setup guide.

### D14. Ambiguity check

None is added (FR-032). The setup guide tells the resolver to open the X profile, or `https://x.com/<username>`, and look for the post near the attempt time before choosing "Mark as published" or "Mark as failed".

## 3. Unverified items: how each is handled

| Item | Handling | Test |
|---|---|---|
| U1 one-shot upload | Not used. | `media upload` tests assert only `/initialize`, `/{id}/append` and `/{id}/finalize` (and STATUS) are requested. |
| U2 403 duplicate, 429 and 401 bodies | Matched on status. The body is read only for `detail`/`title`. | Each case runs with a Problem-shaped body **and** an empty/non-JSON body. |
| U3 refresh-token lifetime and reuse body | 180-day estimate. A readable OAuth `error` is definitive; anything else is transient. | `invalid_grant` JSON body → `needs_reauth`; a 400 with an empty body → transient. |
| U4 callback rules and app permission | G10 https + public host. The setup guide says to choose "Read and write" (UNVERIFIED) and documents `http://127.0.0.1` as X's rule, which Docket refuses. | `redirectUriProblem` with the X group. |
| U5 media and `users/me` costs, daily per-user cap | Setup guide only. | — |
| U6 post URL | D13. | URL tests with and without a username. |
| U7 timeline params | Not used. | — |
| U8 legacy tiers | Setup guide note. | — |
| U9 credits exhausted → 429 or 403 | 429 → usage-cap wait; 403 → fatal with `detail`. | Both paths are mocked. |

## 4. Docs and config touch list (no compose change)

- `docs/x-setup.md` (new), `docs/limits.md`, `docs/accounts.md`, `docs/adding-a-provider.md`, `docs/decisions.md`, `docs/index.md`, `README.md` and `mkdocs.yml` (navigation).
- `src/lib/docs.ts`: add `"x-setup"` to `DocPage`.
- `.env.example`: an X block, both variables empty, with a comment pointing at `docs/x-setup.md`.
- `unraid/docket.xml`: two optional, empty, `Display="advanced"` fields. `X_CLIENT_SECRET` is `Mask="true"`.
- The Unraid change is a user-visible template change. Per the owner's standing note, the implement phase reports the exact added XML. `docker-compose.yml` does not change (both files pass `.env` through `env_file`).
