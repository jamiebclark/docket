# Feature Specification: X (formerly Twitter) provider

**Feature Branch**: `014-x-provider`

**Created**: 2026-10-06

**Status**: Draft

**Input**: User description: "Add an X publishing provider. The owner wants X available as a feature but will not use it or live-test it: it ships verified only against mocked HTTP, and the docs must say plainly it has not been checked against the real X API. Before specifying, read docs/research/x.md (authoritative for endpoints, scopes, limits, token rules, counting and the UNVERIFIED list), docs/adding-a-provider.md (contract and generic hooks G1-G14), src/providers/types.ts, src/providers/registry.ts, src/providers/threads/ and src/providers/meta/ (worked OAuth + refresh + custom counting rule examples), src/providers/bluesky/ (media upload then post), scripts/generate-icons.mjs and src/components/ui/Icon.tsx (platform marks), docs/limits.md, docs/accounts.md, docs/meta-setup.md (style for a setup guide), .specify/memory/constitution.md and docs/decisions.md. Must deliver: src/providers/x/ registered with one line in src/providers/registry.ts, key `x`, displayName `X` [...]; OAuth 2.0 Authorization Code with PKCE (S256), confidential client via X_CLIENT_ID / X_CLIENT_SECRET [...]; refresh [...]; account identity and card notes from GET /2/users/me [...]; a custom counting rule (G9) [...] maxLength 280 [...]; capabilities [...]; advance() step machine [...]; defaultPublishLimit {count: 100, windowSeconds: 900}; platform mark [...]; generator [...]; docs [...]; tests with mocked HTTP only [...]. Does NOT: post threads/replies, quote posts, video or animated GIF, polls, OAuth 1.0a, Premium long posts, or any live verification." (Full text in `.specify/roadmaps/docket.json`, entry `x-provider`.)

## Context and sources

- **Platform facts:** `docs/research/x.md` (checked 2026-10-06 against docs.x.com). It is authoritative for hosts, endpoints, scopes, token lifetimes, limits, counting and pricing. Where it and the request disagree, the research wins (constitution I) and the disagreement is listed below.
- **Framework contract:** `docs/adding-a-provider.md` and `src/providers/types.ts`; generic hooks G1–G16 in `docs/decisions.md`. The worked examples are Threads (OAuth connect group, encrypted credentials, custom counting rule G9, held refresh G11, account notes G13), Bluesky (rotating refresh token persisted every time, publish-time refresh G2, one non-publishing upload step per image before the create step) and Instagram (polling with `continue` + `notBefore`).
- **Engine facts relied on** (current code): the scheduled token-refresh section renews accounts whose stored credential expiry falls within `TOKEN_REFRESH_WINDOW_HOURS` (default 72); `needsRefresh` lets the publish engine renew under a lease before a step; a `retryable_error` with `credentialsExpired` makes the engine refresh and retry; a transient refresh failure with `retryAt` parks the refresh lease (G11). The engine re-validates content on a target's first step (G15) and defers targets over a publish limit. An OAuth group that is not configured is shown on the Accounts screen as "not configured on this server" with a link to its setup guide and no connect action, and a direct start is refused on the server. Uploaded media is limited to JPEG, PNG and WebP (`UPLOAD_MIME_TYPES`), so a GIF never reaches a post. The resolve-ambiguous flow (`resolveAmbiguous`) is manual only: it has no provider check.
- **Docker Compose:** both compose files pass `.env` to the containers through `env_file`, so the two new variables need no compose change. The Unraid template lists provider variables explicitly (Threads and Meta are there), so it gains two optional, empty X fields.

### Request vs research (research wins)

| Topic | Request says | Research says (used here) |
|---|---|---|
| Media upload | "simple upload when within limits; chunked only if needed" | The one-shot `POST /2/media/upload` schema is **UNVERIFIED** (page unreachable). Safe design: the **chunked flow for every image** (`initialize`, one `append` with `segment_index` 0, since a 5 MB image fits one segment, `finalize`, then `STATUS` polling only if `processing_info` is returned). The one-shot endpoint is not used. |
| 5xx on the create-post call | "5xx => retryable" | "Do not retry a create that may have been sent" (no idempotency key on `POST /2/tweets`), and the contract forbids `retryable_error` from a `mayPublish` step once the request was sent. A 5xx **on create** is therefore `ambiguous`. 5xx on every earlier (non-publishing) step is `retryable_error`, as requested. Bluesky already treats a 5xx on its create call the same way. |
| 403 duplicate | "403 duplicate => fatal with a clear message" | The duplicate body is **UNVERIFIED** (third-party detail `You are not allowed to create a Tweet with duplicate content.`). **Every 403 on create is fatal**, showing X's `detail`; when the detail mentions duplicate content the message says so plainly. Matching is on status, never on body alone. |
| 429 | "retryable with retryAt from x-rate-limit-reset" | Same, but 429 can also mean the spending limit or credits are exhausted ("Rate limit or usage cap exceeded"). A 429 whose `x-rate-limit-remaining` is not `0`, or which has no readable reset, is not retried quickly (FR-031). |
| Refresh "clearly invalid_grant" | needs_reauth | The error body for a reused or expired refresh token is **UNVERIFIED**. Only a readable OAuth error code (`invalid_grant` and other client-side OAuth errors) is treated as definitive; anything unreadable is transient (FR-014). |
| GIF | "GIF only if it fits the shared media model as a still; otherwise exclude" | Docket's media library accepts only JPEG, PNG and WebP uploads, so a GIF never reaches a post. **GIF is excluded** from X's allowed types. |
| New generic hook number | "record it as G15" | G15 (publish-time validation) and G16 (Bluesky's two publish limits) are already taken in `docs/decisions.md`. The next free number is **G17**. |
| Post URL | `https://x.com/<username>/status/<id>` | Same form, but **UNVERIFIED** (no official page); `https://x.com/i/status/<id>` also resolves and is the fallback when no username is known. |
| URL counting | "any URL counts 23" | Same, and twitter-text also counts a scheme-less domain such as `example.com` as a URL. Docket's own URL detection will drift slightly from X's parser; leave a warning margin (FR-020). |
| Ambiguity check | "may check GET /2/users/:id/tweets if the existing ambiguity flow supports a provider check" | The existing flow has no provider check, so none is added. The person resolving checks the X profile themselves; the setup guide says how. |
| Constitution scope | — | The constitution lists four platforms and puts "other platforms" out of scope "until a spec says otherwise". This spec says otherwise for X only. The constitution itself is not amended here. |

### UNVERIFIED in research (covered by mocked tests that tolerate both shapes, reported as "verified with mocks only")

- U1: the one-shot `POST /2/media/upload` schema (not used, see above).
- U2: the duplicate-content 403 body; the 429 body; the 401 body for an expired access token (matching is on status).
- U3: refresh-token lifetime (~6 months) and the error body for a reused or expired refresh token.
- U4: callback-URL rules (max 10, https in production, `http://127.0.0.1` rather than `localhost` for local development) and the app permission level ("Read and write") needed to post.
- U5: media upload and `GET /2/users/me` costs; whether any daily per-user post cap exists beyond the 100 / 15 min rate limit.
- U6: the post URL form.
- U7: `GET /2/users/:id/tweets` parameter ranges (not used).
- U8: legacy Basic/Pro subscription tiers (not mentioned in the docs; only pay-per-use is described).
- U9: whether running out of credits surfaces as 429 or 403.

### Framework gap this feature exposes

- **G17: an OAuth group cannot carry a per-attempt PKCE verifier from the authorize redirect to the code exchange.** `authorizationUrl` receives the attempt's `state` but `exchangeCode` does not, and `connect_attempts` stores only a hash of the state. X requires PKCE (`code_challenge` on the authorize URL, `code_verifier` on the token call). The fix is generic: the framework passes the attempt's raw `state` (already validated, single-use and bound to the user and session) to `exchangeCode` as well, so a group can derive its verifier from the state with a key only the server holds. No schema change. *Default derivation for X*: verifier = base64url of a keyed hash of the state under `X_CLIENT_SECRET`, which is 43 characters and meets RFC 7636; a stolen code injected into another session fails because that session's state yields a different verifier. If planning finds this unworkable, the alternative is an encrypted per-attempt secret on `connect_attempts` (a schema change), which must then be justified in the plan. Either way it is recorded as G17 in `docs/decisions.md` (what, why, how to reverse) and added to the hooks index in `docs/adding-a-provider.md`, and existing groups (Meta, Threads) behave exactly as before.

No other scheduler, service, composer or schema change is expected. Anything else planning finds is a framework defect handled the same way (numbered G18 onwards).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect an X account (Priority: P1)

A self-hoster who has created their own X developer app sets `X_CLIENT_ID` and `X_CLIENT_SECRET`, restarts Docket, and an owner or admin of a project chooses **Connect X** on the Accounts screen. They approve Docket on X's login page and come back to the chooser, which shows their X account as `@username`. They pick it and it appears in the project's accounts with the X mark, ready to schedule.

**Why this priority**: nothing else in this feature is usable without a connected account.

**Independent Test**: with mocked HTTP for the token endpoint and `GET /2/users/me`, start a connect, follow the callback with a code and the attempt's state, and check that one candidate (`@username`, external id = X user id) reaches the chooser, that saving it stores encrypted credentials, and that the authorize URL carried the right scopes and an S256 challenge matching the verifier sent on the token call.

**Acceptance Scenarios**:

1. **Given** both X variables are set and the deployment address is HTTPS on a public host, **When** an owner starts Connect X, **Then** they are sent to `https://x.com/i/oauth2/authorize` with `response_type=code`, the client id, the exact callback address, scope `tweet.read tweet.write users.read media.write offline.access`, the state, a `code_challenge` and `code_challenge_method=S256`.
2. **Given** X redirects back with a code, **When** the callback is handled, **Then** Docket exchanges the code at `https://api.x.com/2/oauth2/token` on the server with HTTP Basic client authentication, the callback address and the matching `code_verifier`, reads `GET /2/users/me`, and offers one candidate named `@<username>` whose external id is X's user `id`.
3. **Given** the chooser shows the candidate, **When** the user saves it, **Then** the account is stored with encrypted credentials, its name shows as `@<username>`, its card notes show the X display name, and it renders with the X platform mark wherever other accounts show theirs.
4. **Given** X answers the exchange with an error, an unreadable reply, or the user cancelled on X's page, **When** the callback is handled, **Then** nothing is saved, the user returns to Accounts with a plain message (cancelled, or "Could not finish signing in with X" with a pointer to the setup guide), and no secret appears in the message.
5. **Given** the granted `scope` in the token response lacks `tweet.write` or `media.write`, **When** the candidate is shown, **Then** it carries a note that posting (or image) permission was not granted and the user should connect again and allow it.
6. **Given** an X account already connected in the project is `needs_reauth`, **When** the same X user connects again, **Then** the chooser offers it as a reconnect and saving restores it to `active` with new credentials.

---

### User Story 2 - Publish a text post to X (Priority: P1)

An editor schedules a text post for an X account. At the scheduled time Docket publishes it, the target becomes `published`, and the post links to it on X.

**Why this priority**: publishing is the feature's purpose; text-only is the simplest path and must work in one tick.

**Independent Test**: with mocked `POST /2/tweets`, advance a text-only target and check every result: 201 with `data.id` → done with the URL; timeout, reset or unreadable 2xx after sending → ambiguous; 5xx → ambiguous; 401 → retryable with `credentialsExpired`; 403 (duplicate and other) → fatal with X's detail; 429 → retryable with `notBefore` from `x-rate-limit-reset`; other 4xx → fatal; connection refused before sending → retryable.

**Acceptance Scenarios**:

1. **Given** a text post within 280 counted characters, **When** its target is due, **Then** the first and only step is the create-post step (marked as one that may publish), Docket sends `POST https://api.x.com/2/tweets` with a bearer token and `{"text": "..."}`, and on HTTP 201 `{"data":{"id":"…","text":"…"}}` the target is `published` with external id = that id (kept as a string) and URL `https://x.com/<username>/status/<id>`.
2. **Given** the create request was sent and the connection timed out, was reset, or X returned a 2xx Docket cannot read, **When** the step ends, **Then** the target is `ambiguous`, it is never retried automatically, and the Failures screen offers the existing manual resolve actions.
3. **Given** X answers 401, **When** the step ends, **Then** the result is retryable with `credentialsExpired`, so the engine renews the token and retries; nothing was published.
4. **Given** X answers 403 with a detail mentioning duplicate content, **When** the step ends, **Then** the target fails at once with a message that X refused it as a duplicate of a recent post; any other 403 fails at once showing X's `detail`.
5. **Given** X answers 429 with `x-rate-limit-remaining: 0` and a readable `x-rate-limit-reset`, **When** the step ends, **Then** the result is retryable with `notBefore` at that reset time.
6. **Given** the text counts over 280 by X's weighted rule, **When** someone schedules or publishes it, **Then** it is refused before any call to X (composer, scheduling gate and publish-time validation all use the same count).

---

### User Story 3 - Publish a post with images and alt text (Priority: P2)

An editor attaches up to four images with alt text to an X post. Docket uploads each image to X, sets its alt text, then creates the post with those images attached.

**Why this priority**: images are common but text posts already deliver value on their own.

**Independent Test**: with mocked media endpoints, advance a two-image post through every step and check that each upload step is non-publishing, uses `initialize` → `append` (segment 0) → `finalize` (→ `STATUS` polling when `processing_info` is present), sets alt text through `POST /2/media/metadata` only when the image has alt text, and that the final create sends `media.media_ids` in image order.

**Acceptance Scenarios**:

1. **Given** a post with N images (1 ≤ N ≤ 4), **When** it publishes, **Then** each image is uploaded in its own non-publishing step(s) and the create-post step runs last with `{"text": "...", "media": {"media_ids": [ids in image order]}}`.
2. **Given** finalize returns `processing_info` with `state` `pending` or `in_progress`, **When** the step ends, **Then** it returns `continue` with `notBefore` after `check_after_secs`, and a later step polls `GET /2/media/upload?command=STATUS&media_id=<id>` until `succeeded`; `failed` is fatal with a plain message naming the image.
3. **Given** an image has alt text, **When** its upload is done, **Then** Docket sends `{"id": "<media id>", "metadata": {"alt_text": {"text": "..."}}}` to `POST /2/media/metadata` before the post is created; an image with no alt text skips the call.
4. **Given** an upload or metadata call fails with a 5xx, a 429, a timeout or a network error, **When** the step ends, **Then** it is retryable (with `notBefore` from `x-rate-limit-reset` for a 429) and nothing was published; a 401 is retryable with `credentialsExpired`; another 4xx is fatal naming the image.
5. **Given** a fifth image, an image over 5,000,000 bytes that cannot be compressed under it, or alt text over 1,000 characters, **When** the post is validated, **Then** it is refused (or adapted by the shared media planner, as for other providers) before any call to X.
6. **Given** an uploaded media id has expired (past `expires_after_secs`) before the create step is sent, **When** the next step is chosen, **Then** the expired uploads are redone; after the create request was sent, nothing is redone.

---

### User Story 4 - Keep the account signed in (Priority: P2)

An X account connected weeks ago keeps publishing without the user doing anything: Docket renews X's two-hour access token before it is needed and stores X's new single-use refresh token every time.

**Why this priority**: without renewal every account fails two hours after connecting.

**Independent Test**: with a mocked token endpoint, check `needsRefresh` near expiry, a successful refresh storing both new tokens, a second refresh using the new refresh token (rotation), `invalid_grant` → needs_reauth, and 5xx/network/429 → transient with a held retry.

**Acceptance Scenarios**:

1. **Given** the access token expires within 5 minutes (or has expired), **When** a target for that account is about to run, **Then** `needsRefresh` is true and the engine renews it under its refresh lease before the step.
2. **Given** a renewal succeeds, **When** credentials are stored, **Then** the new access token, the **new** refresh token, the new access expiry and a new refresh-token issue time replace the old ones, and the next renewal sends the new refresh token.
3. **Given** X refuses a renewal with a readable `invalid_grant` (or another client-side OAuth error), **When** the result is applied, **Then** the account becomes `needs_reauth` with a plain reason and its targets stop until it is reconnected.
4. **Given** a renewal fails with a 5xx, a 429, a network error, a timeout or an unreadable reply, **When** the result is applied, **Then** the account stays `active` and the refresh lease is held until a `retryAt` (the `x-rate-limit-reset` time for a 429, otherwise a short fixed delay), as G11 allows.
5. **Given** an X account has not published for months, **When** the scheduled refresh runs, **Then** it renews the account within the refresh window before the refresh token's estimated expiry, so an idle account does not lapse.

---

### User Story 5 - Self-hoster sets up X, or leaves it off (Priority: P2)

A self-hoster reads `docs/x-setup.md`, which says up front that X support has not been checked against the real X API, then explains how to create an X developer app, the pay-per-use credit model and per-post costs, the callback address, the scopes and the two variables. A self-hoster who does not want X leaves the variables empty and sees no way to connect X.

**Why this priority**: the owner will not live-test X, so honest, complete docs are what makes it usable for others.

**Independent Test**: with the X variables absent, the Accounts screen offers no Connect X action (only the generic "not configured" notice with the setup-guide link) and a direct start is refused; with only one variable set, startup reports the missing one by name without its value; the docs tests (limits inventory, provider guide, README and deployment) pass with X included.

**Acceptance Scenarios**:

1. **Given** neither `X_CLIENT_ID` nor `X_CLIENT_SECRET` is set, **When** Docket starts, **Then** startup succeeds, X is not configured, the Accounts screen offers no connect action for X, and starting an X connect is refused on the server.
2. **Given** only one of the two is set, **When** Docket starts, **Then** startup reports an issue naming the missing variable (never a value), exactly as for Threads and Meta.
3. **Given** the deployment address is `http://` or a local host, **When** the Accounts screen loads with X configured, **Then** X is shown as unavailable with a plain reason and a link to the relevant section of `docs/x-setup.md`, and a start is refused on the server.
4. **Given** a reader opens `docs/x-setup.md`, **Then** it opens with a plain notice that X support is verified with mocked tests only and has not been checked against the live X API, and covers: creating the app and its "Read and write" permission, pay-per-use credits with the costs as of 2026-10-06, the callback address, the two variables, the scopes, what happens when credits run out, the 280-character limit and counting drift, how to check an ambiguous post, and every UNVERIFIED item.

---

### User Story 6 - Generate posts for an X account (Priority: P3)

An editor generates a post with an X account among the targets. The model is told X's hard rules (280 characters by X's counting rule, up to four images, alt text up to 1,000 characters, text-only allowed) exactly as it is for other platforms.

**Why this priority**: generation already works generically from capabilities; this only confirms X flows through.

**Independent Test**: a prompt-assembly test with an X target shows X's platform rules built from its capabilities, with no prompt change.

**Acceptance Scenarios**:

1. **Given** generation targets an X account, **When** the prompt is assembled, **Then** the platform hard rules for X carry display name `X`, max length 280, its counting rule's unit and name, text-only allowed, media not required, 4 images and alt-text limit 1,000.
2. **Given** a generated variant for X is over 280 counted characters, **When** it is checked, **Then** it is flagged by the same validation as a typed post.

### Edge Cases

- **Authorization code lifetime is 30 seconds.** The code is exchanged immediately in the callback; a late exchange that X refuses ends with the plain "could not finish signing in" message and a suggestion to try again.
- **A refresh whose response is lost.** If a renewal was sent and the reply never arrived, X may have consumed the old refresh token. The failure is transient; the next renewal with the old token either works or is refused (`invalid_grant`) and the account becomes `needs_reauth`. Accepted: reconnecting is the recovery.
- **Two renewals at once.** Renewals for one account are serialised by the existing refresh lease, so a single-use refresh token is never sent twice concurrently.
- **Credits or spending limit exhausted.** X may answer 429 (or possibly 403, U9). A 429 that is not a plain rate-window exhaustion waits at least an hour before the retry and its message mentions credits and the spending limit; a 403 fails showing X's detail.
- **Text with URLs near the limit.** Every URL counts 23 regardless of length; Docket's URL detection may differ slightly from X's, so text close to the limit gets a non-blocking warning.
- **Emoji sequences.** A ZWJ family, a flag, a keycap or a skin-tone emoji counts 2, however many code points it has.
- **Empty text with images.** X allows media without text; the shared validator's empty-post rule decides as for other providers.
- **Media rejected at post time after a good upload.** A 4xx on create is fatal with X's detail; the media is not re-uploaded.
- **Account username changed on X.** The stored username can be stale; the post URL may then redirect. Accepted; reconnecting refreshes it.
- **Unknown username.** If no username is stored, the post URL uses `https://x.com/i/status/<id>`.
- **Stored state from an edited post.** If a step's saved state no longer fits the post's media (an image was added or removed), the step machine restarts from the first upload, but only before the create step was sent.
- **Secrets in errors.** Tokens, the client secret, the authorization code and the PKCE verifier never appear in messages, attempt summaries, step state, logs or test snapshots.
- **Per-app daily limit.** X's per-app 10,000 / 24 h create limit spans every X account on the install and is not enforced by Docket (the engine limits per account); it is documented, not enforced.

## Requirements *(mandatory)*

### Functional Requirements

**Registration and configuration**

- **FR-001**: The provider MUST live in `src/providers/x/` with key `x` and display name `X`, and be registered by one line in `src/providers/registry.ts`. It MUST NOT import from `src/server/**`.
- **FR-002**: Connecting MUST use an OAuth connect group (key `x`, display name `X`) that declares its own environment (G8): `X_CLIENT_ID` (not secret) and `X_CLIENT_SECRET` (secret), both optional as a pair. Both absent = not configured, with no startup issue. Exactly one present = a startup issue naming the missing variable. Issues MUST never carry values. Both variables MUST be documented in `.env.example` (empty, with a comment pointing at `docs/x-setup.md`) and added to the Unraid template as optional, empty fields.
- **FR-003**: When X is not configured, the Accounts screen MUST NOT offer a Connect X action (the generic "not configured on this server" notice with a link to the setup guide is shown instead), and starting an X connect MUST be refused on the server. Other providers MUST be unaffected.
- **FR-004**: The group MUST declare a callback-address requirement (G10) of HTTPS and a public host, with a plain reason and a link to the matching section of `docs/x-setup.md`. The group offers no paste-token fallback.

**Connect**

- **FR-005**: The authorize URL MUST be `https://x.com/i/oauth2/authorize` with `response_type=code`, `client_id`, the exact `redirect_uri`, `scope=tweet.read tweet.write users.read media.write offline.access` (space separated), `state`, `code_challenge` and `code_challenge_method=S256`.
- **FR-006**: Each connect attempt MUST use its own PKCE verifier (43–128 characters from the RFC 7636 alphabet) whose S256 challenge is in the authorize URL and which is sent as `code_verifier` on the token call. The verifier MUST never reach the browser and MUST never be stored in plaintext. Carrying it to the exchange is the G17 change (see "Framework gap").
- **FR-007**: The code exchange MUST run on the server: form-encoded `POST https://api.x.com/2/oauth2/token` with `grant_type=authorization_code`, `code`, `redirect_uri` and `code_verifier`, authenticated with `Authorization: Basic base64(client_id:client_secret)` (confidential client).
- **FR-008**: After the exchange, Docket MUST read `GET https://api.x.com/2/users/me` with the new access token and return one candidate: external id = `data.id`, display name = `@<data.username>`, non-secret settings holding `username` and `name`, and the credentials of FR-010. A failed or unreadable profile read MUST return a refusal and save nothing.
- **FR-009**: A cancelled login (`error=access_denied`) MUST map to "cancelled"; any other callback error to a plain platform error. A transient failure (network, 5xx, 429) during the exchange MUST say X could not be reached and nothing changed. No message may contain a token, code, verifier or the client secret.
- **FR-010**: Stored credentials (encrypted at rest, as for Threads) MUST be a versioned record holding the access token, the refresh token, the access token's expiry (now + `expires_in`, 7,200 s when unreadable) and the refresh token's issue time, with timestamps as epoch milliseconds. The account's stored credential expiry MUST be the refresh token's **estimated** expiry (issue time + 180 days, UNVERIFIED U3), so the scheduled refresh keeps an idle account alive. If the token response has no refresh token, the exchange MUST be refused (offline access was not granted).
- **FR-011**: When the token response's granted `scope` is present and lacks `tweet.write` or `media.write`, the candidate MUST carry a plain note saying which permission is missing.

**Refresh**

- **FR-012**: `needsRefresh` MUST be true when the access token expires within 5 minutes or has expired, and false otherwise (and false for unreadable credentials, which `refreshCredentials` reports).
- **FR-013**: `refreshCredentials` MUST send form-encoded `grant_type=refresh_token` and `refresh_token` to the token endpoint with Basic client authentication, and on success return credentials holding the **new** access token, the **new** refresh token (X's refresh tokens are single-use), the new access expiry and a new refresh-token issue time, with `expiresAt` = the new estimated refresh-token expiry. It MUST never throw.
- **FR-014**: A refresh refused with a readable OAuth error code (`invalid_grant`, `invalid_client`, `unauthorized_client`, `invalid_request`, `invalid_scope`) MUST be a definitive failure (`needs_reauth`) with a plain reason; `invalid_client` and `unauthorized_client` MUST point at `X_CLIENT_ID` / `X_CLIENT_SECRET`. A 5xx, 429, network error, timeout or unreadable reply MUST be transient with a `retryAt`: the `x-rate-limit-reset` time for a 429 when readable, otherwise now + 5 minutes. Stored credentials that cannot be read MUST be definitive.
- **FR-015**: A refresh MUST NOT run inside a step that may publish (G2 already guarantees this).

**Account card and post URL**

- **FR-016**: `accountNotes` MUST show the X display name (`name`) when stored. Notes MUST be plain text with no secrets.
- **FR-017**: A published post's URL MUST be `https://x.com/<username>/status/<id>`, or `https://x.com/i/status/<id>` when no username is stored.

**Counting and capabilities**

- **FR-018**: Text MUST be counted by a custom counting rule (G9) named `x-weighted`, unit `characters`, implemented in-house from the twitter-text v3 values in `docs/research/x.md` (no `twitter-text` dependency): normalise to NFC; each URL counts 23; each emoji grapheme counts 2; every other code point counts 1 if it is in 0–4351, 8192–8205, 8208–8223 or 8242–8247 (decimal) and 2 otherwise. `capabilities.text.maxLength` MUST be 280. The rule MUST be pure, total and never throw.
- **FR-019**: URL detection MUST count text starting `http://` or `https://`, and scheme-less hostnames ending in a known top-level domain from a list kept in the provider folder (e.g. `example.com`, `www.example.org/path`), each as one URL including its path, query and fragment. Trailing sentence punctuation is not part of a URL.
- **FR-020**: `validate` MUST use the shared validator with these capabilities and add a non-blocking `warning` when the counted length is above 270 and the text contains a URL or emoji, saying X's own count may differ slightly.
- **FR-021**: Capabilities MUST be: text-only posts allowed; media not required; up to 4 images; allowed types `image/jpeg`, `image/png`, `image/webp` (output type `image/jpeg`); at most 5,000,000 bytes per file; alt text at most 1,000 characters; post types `text`, `image` and `carousel` (a multi-image post). No GIF, video or animated media.
- **FR-022**: `defaultPublishLimit` MUST be `{ count: 100, windowSeconds: 900 }`.

**Publishing step machine**

- **FR-023**: `stepFor` MUST be pure and total. A post with no images goes straight to `create_post` (the only step with `mayPublish: true`). A post with images runs non-publishing upload steps for each image in order, then `create_post`. State that does not fit the current media count restarts from the first upload.
- **FR-024**: Each step MUST do one bounded unit of work (at most one request carrying image bytes per step, no sleeps or polling loops) and honour `ctx.signal` on every call. Waits use `continue` with `notBefore`.
- **FR-025**: Each image MUST be uploaded with the v2 chunked endpoints: `POST /2/media/upload/initialize` (JSON `media_type`, `total_bytes`, `media_category: "tweet_image"`), one `POST /2/media/upload/{id}/append` with the whole image as `segment_index` 0, `POST /2/media/upload/{id}/finalize`, and, only when `processing_info` is returned, `GET /2/media/upload?command=STATUS&media_id=<id>` after `check_after_secs` until `succeeded` (`failed` is fatal). Media ids MUST be kept as strings. The one-shot `POST /2/media/upload` and the old `command=INIT|APPEND|FINALIZE` form MUST NOT be used.
- **FR-026**: When an image has alt text, `POST /2/media/metadata` with `{"id": "<media id>", "metadata": {"alt_text": {"text": "<alt text>"}}}` MUST be sent after finalize (and processing) and before `create_post`.
- **FR-027**: State MUST hold each finished image's media id and its expiry (from `expires_after_secs`), and nothing secret. If any media id has expired before `create_post` is sent, the uploads MUST be redone from the first expired image.
- **FR-028**: `create_post` MUST send `POST https://api.x.com/2/tweets` with `Authorization: Bearer <access token>`, `Content-Type: application/json` and `{"text": "..."}`, plus `"media": {"media_ids": [...]}` in image order when there are images. Empty text with images omits `text`.
- **FR-029**: Results of `create_post`:
  - HTTP 201 (any 2xx) with a readable string `data.id` → `done` with that id and the FR-017 URL;
  - a 2xx Docket cannot read, a timeout or abort after sending, a connection reset mid-response, or any 5xx → `ambiguous` (never retried);
  - a connection refused or DNS failure before sending → `retryable_error`;
  - 401 → `retryable_error` with `credentialsExpired: true`;
  - 403 → `fatal_error` showing X's `detail` (truncated, scrubbed); a detail mentioning duplicate content gets a plain "X refused this as a duplicate of a recent post" message;
  - 429 → `retryable_error` per FR-031;
  - any other 4xx → `fatal_error` showing X's `title`/`detail`.
- **FR-030**: Results of upload, status and metadata steps: 2xx readable → `continue`; 401 → `retryable_error` with `credentialsExpired`; 429 → per FR-031; 5xx, timeout, network error or unreadable 2xx → `retryable_error`; other 4xx → `fatal_error` naming the image number; `processing_info.state` `failed` → `fatal_error` naming the image.
- **FR-031**: A 429 on any step MUST be `retryable_error`. When `x-rate-limit-remaining` is `0` and `x-rate-limit-reset` is a readable Unix time in seconds, `notBefore` is that time. Otherwise (remaining not 0, or no readable reset) the message MUST say X's rate limit or usage cap was hit (credits or the spending limit may be exhausted) and `notBefore` MUST be at least now + 1 hour (or the reset time if later).
- **FR-032**: Ambiguous X posts MUST be resolved through the existing manual flow only; no provider check against `GET /2/users/:id/tweets` is added.
- **FR-033**: No token, client secret, code or verifier may appear in a `StepResult` error, summary or state, a thrown message, a log line or a test snapshot. Attempt summaries record only non-secret request facts (endpoint, image number, status).

**Platform mark and UI**

- **FR-034**: `scripts/generate-icons.mjs` MUST map `x: "x"` in `PROVIDERS`, and `src/components/ui/icons.generated.ts` MUST be regenerated from the installed Simple Icons package (not hand-edited). X accounts MUST render with `ProviderIcon` wherever other providers' accounts do (Accounts screen, composer, account picker and any other existing use).

**Generator**

- **FR-035**: X's capabilities MUST reach prompt assembly through the existing platform-rules path; a test MUST confirm the X rules. The prompt code MUST NOT change for X.

**Docs**

- **FR-036**: `docs/x-setup.md` MUST open with a plain notice that X support is verified with mocked HTTP only and has not been checked against the real X API, and cover, in the style of `docs/meta-setup.md`: creating an X developer app (OAuth 2.0, confidential "Web App" type, "Read and write" permission, UNVERIFIED); pay-per-use credits bought in advance, auto-recharge and the spending limit, per-request costs as of 2026-10-06 ($0.015 per post, $0.20 for a post containing a URL, owned reads $0.001), the promotional credits note, and that prices changed several times in 2026; the callback address `<BETTER_AUTH_URL>/connect/callback` (exact match, HTTPS on a public host; the `http://127.0.0.1` local rule as UNVERIFIED and refused by Docket); `X_CLIENT_ID` / `X_CLIENT_SECRET`; the five scopes and why each is needed; token lifetimes and what "Needs reconnecting" means; limits (280 characters by X's weighted count, URLs 23, emoji 2, counting drift; 4 images; 5 MB; alt text 1,000; 100 posts per 15 minutes per account; the 10,000 per day per-app limit not enforced); what happens when credits run out; how to check an ambiguous post on the X profile; the out-of-scope list; and every UNVERIFIED item U1–U9.
- **FR-037**: `docs/limits.md` MUST gain an X section whose rows match X's declared capabilities and publish limit (text length 280 `x-weighted`, images 4, bytes per file, formats, alt text length, media required, text only, publish limit `100 / 900 s`), citing `docs/research/x.md`, so the limits inventory and generated enforcement tests pass.
- **FR-038**: `docs/accounts.md` MUST gain X in its connect table and a short X section (link to `docs/x-setup.md`, what is stored, needs reconnecting, unverified live). README and `docs/index.md` MUST list X wherever providers are listed (including the docs table and the docs-site navigation), and `docs/adding-a-provider.md` MUST list G17 in the hooks index and gain a short X worked example.
- **FR-039**: `docs/decisions.md` MUST gain a "014 — X" section recording G17, every request-vs-research disagreement above, the interim choices (180-day refresh estimate, 5-minute refresh hold, 1-hour usage-cap wait, 270 warning threshold, TLD list), and "verified with mocks only; no live check is owed".

**Tests (mocked HTTP only)**

- **FR-040**: Tests MUST stub HTTP only, using the request and response shapes in `docs/research/x.md` exactly, and where a shape is UNVERIFIED (U2, U3) MUST cover both a documented-looking body and an empty or unreadable one. They MUST cover: env parsing (none, one, both); the authorize URL (scopes, S256 challenge matching the verifier); code exchange (Basic auth, body fields, success, refusal, transient, missing refresh token, missing scope note); profile read; refresh (needsRefresh edges, rotation across two refreshes, `invalid_grant`, other OAuth errors, 5xx/429/network → transient with `retryAt`); the counting rule (ASCII, CJK, Cyrillic, the weight-1 ranges' edges, emoji including ZWJ, flags, keycaps and skin tones, scheme and scheme-less URLs, NFC, mixed text, exactly 280 and 281); `stepFor` for every state; every `advance` result for upload, status, metadata and create steps, including 429 `notBefore`, the usage-cap path, 401 `credentialsExpired`, 403 duplicate and other 403, other 4xx, 5xx on create (ambiguous) and on upload (retryable), timeout and reset after send, unreadable 2xx, expired media ids; the post URL; and a no-secrets check. Registry, import-boundary lint, provider-guide, limits-inventory, README and deployment doc tests MUST still pass.

### Key Entities

- **X credentials** (secret, encrypted): version, access token, refresh token, access expiry, refresh-token issue time.
- **X account settings** (non-secret): username (for the post URL), display name (for card notes).
- **X step state** (non-secret, persisted between ticks): per image, its media id, expiry and progress (initialized, appended, finalized, processing, alt text set), and which step comes next.
- **Connect attempt** (existing): now also hands its raw state to the group's exchange (G17).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With mocked X responses, connecting an X account takes one approval on X's page and one choice in the chooser, and the connected account shows `@username` with the X mark.
- **SC-002**: A text-only X post publishes in exactly one engine step; a post with N images publishes after the image steps and one create step, and no step other than create can publish.
- **SC-003**: For a corpus of at least 30 test strings (ASCII, CJK, emoji incl. ZWJ, URLs, mixed), Docket's count equals the value computed by hand from the twitter-text v3 rules for every string, and the composer's count equals the enforced count for every string.
- **SC-004**: 100% of the `advance` outcomes listed in FR-029 to FR-031 have a mocked test, and every path where the create request may have been sent ends `ambiguous`, never retried.
- **SC-005**: An account renewed twice in a row sends the second renewal with the refresh token returned by the first (100% of rotation tests).
- **SC-006**: With the X variables absent, a deployment offers no way to connect X and every existing test passes unchanged.
- **SC-007**: Outside `src/providers/x/`, tests, docs, `.env.example`, the Unraid template, the icon script and its generated file, `src/lib/docs.ts` and specs, the diff touches only the registry line (and its test) and the G17 files; no schema file changes unless planning justifies G17's fallback.
- **SC-008**: No fake token, client secret, code or verifier appears in any stored plaintext column, attempt summary, step state, log line or error message in tests.
- **SC-009**: A reader of `docs/x-setup.md` learns in its first paragraph that X support has not been checked against the real X API, and finds every UNVERIFIED item listed.

## Assumptions

- The owner does not use X and owes no live check; the feature is reported as "verified with mocks only" everywhere, and no live verification step is planned.
- A self-hoster registers their own X app, so the confidential client with Basic authentication is used; public-client mode is not supported.
- 180 days is an estimate of the refresh token's lifetime ("~6 months", UNVERIFIED); if it is shorter, an idle account may lapse to `needs_reauth` and must be reconnected.
- The 5-minute refresh margin, 5-minute transient refresh hold, 1-hour usage-cap wait and 270-character warning threshold are interim judgement calls, each kept in one constant and logged in `docs/decisions.md`.
- The prompt's counting note for X names the `x-weighted` rule and its unit, as for Threads; making the note more descriptive would be a prompt change and is out of scope.
- The scheme-less URL detection uses a fixed list of common top-level domains; drift from X's parser is accepted and covered by the near-limit warning.
- Docket's per-account publish limit does not model X's per-app daily limit; it is documented only.
- Out of scope, with no later entry planned: threads and replies, quote posts, video and animated GIF, polls, OAuth 1.0a, Premium long posts, deleting posts, reading timelines, and any live verification.
