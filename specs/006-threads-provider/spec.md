# Feature Specification: Threads provider (Meta, part 2)

**Feature Branch**: `006-threads-provider`

**Created**: 2026-10-04

**Status**: Draft

**Input**: User description: "Add the Threads provider, reusing the shared Meta OAuth module and Graph client from the meta-facebook-instagram entry. Before specifying, read docs/build-prompt.md ('Platform notes' -> Threads, 'The provider framework', 'Publishing as a step machine', 'Media', 'Owner answers' item 7), docs/research/meta.md Threads and local-OAuth sections (authoritative: separate Threads app id/secret THREADS_APP_ID/THREADS_APP_SECRET; testers must accept in Threads Settings -> Website permissions; hosts threads.com / graph.threads.com, base URL configurable via THREADS_GRAPH_BASE because the .net hosts are unverified; scopes threads_basic + threads_content_publish; short-lived 1h -> th_exchange_token 60 days -> th_refresh_token once >=24h old and unexpired; media_type TEXT|IMAGE|CAROUSEL, 500-char text with emoji counted by UTF-8 bytes, JPEG/PNG <=8 MB, width 320–1440, carousel 2–20 items, alt_text <=1000 chars, status polling via ?fields=status once a minute up to 5 min, 250 posts/24h via threads_publishing_limit; Threads redirects require HTTPS and do not accept localhost — use a hosts-file hostname plus an mkcert certificate as in Meta's sample app), docs/meta-setup.md, docs/adding-a-provider.md, .specify/memory/constitution.md and docs/decisions.md. Must deliver: src/providers/threads/ registered only via the registry; OAuth connect with an HTTPS redirect and server-side exchange to a long-lived token, encrypted storage; refresh inside runTick's token-refresh section once a token is >=24h old and near expiry, needs_reauth on failure; capabilities and validate() using the provider's own counting rule (500 chars, emoji by UTF-8 bytes); advance() step machine for TEXT, IMAGE and CAROUSEL containers: create (children first for carousels) -> poll status across ticks via `continue` with notBefore -> threads_publish; threads_publish timeout or unparseable response => ambiguous; publish-limit check against threads_publishing_limit plus our own counter; manual-token-paste fallback for tokens from the dashboard's token generator. Extend docs/meta-setup.md with the Threads use case, tester invites and acceptance, redirect URIs, and a local HTTPS walkthrough (hosts entry such as docket.local -> 127.0.0.1, mkcert certificate, running the dev server over HTTPS). Tests with mocked HTTP only: validate counting incl. emoji, every advance path incl. IN_PROGRESS/ERROR/EXPIRED, retryable, fatal, ambiguous, token exchange and refresh success/failure and the 24h refresh rule. Must NOT do: Facebook/Instagram changes beyond generic fixes to the shared Meta module, video, generator (generator entry), public API (public-api entry)."

## Context and sources

- Product behaviour: `docs/build-prompt.md` ("The provider framework", "Publishing as a step machine", "Scheduler rules", "Platform notes → Threads", "Media", "Owner answers" item 7: Threads local OAuth uses a hosts-file hostname plus an mkcert certificate, not a tunnel).
- Platform facts: `docs/research/meta.md` → "Threads" and "Local OAuth redirects" (checked 2026-10-02). Where it disagrees with the brief, the research wins.
- Framework contract: `docs/adding-a-provider.md` and the provider types; earlier framework fixes G1–G8 in `docs/decisions.md` (004, 005). The shared Meta module (`src/providers/meta/`: connect-group helpers, Graph client, error table, secret scrubbing) was built by 005 to be reused here.
- Engine facts relied on (from `docs/decisions.md` 002/004 and the current code): the scheduled token-refresh section claims accounts whose stored credential expiry falls within `TOKEN_REFRESH_WINDOW_HOURS` (default 72, maximum 720), at most 5 per tick; a definitive refresh failure marks the account `needs_reauth`, a `transient` one keeps it `active` (G3); the OAuth callback address is one fixed path, `<BETTER_AUTH_URL>/connect/callback` (G5).
- Local HTTPS: the installed Next.js documents `next dev --experimental-https` with `--experimental-https-key` and `--experimental-https-cert` (`node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md`).

**Brief vs research (research wins):**

| Topic | Brief says | Research says (used here) |
|---|---|---|
| OAuth and API hosts | not stated | Login dialog `https://threads.com/oauth/authorize`; token and API calls on `https://graph.threads.com`. The long-lived-token page still shows `graph.threads.net`, **UNVERIFIED** whether `.net` still works, so the API base is configurable (`THREADS_GRAPH_BASE`, default `https://graph.threads.com`). |
| Scopes | not stated | `threads_basic` (required) and `threads_content_publish` |
| Text limit | not stated | **500 characters, with emoji counted by their UTF-8 byte length** |
| Images | "media must be at a public URL" | JPEG or PNG, **≤ 8 MB**, width **320–1,440 px**, aspect ratio **≤ 10:1**; alt text up to **1,000 characters** |
| Carousels | not stated | **2–20 items** |
| Container readiness | "containers can take time to become ready" | Recommended wait ~30 s, or poll the container's `status` (same values as Instagram) **once a minute, up to 5 minutes** |
| Rate limit | 250 posts / 24 h | Same, readable via the account's `threads_publishing_limit` (`quota_usage`, `config`) |
| Local redirects | "document each platform's local options" | **No localhost, HTTPS required.** Hosts-file hostname + mkcert certificate, as in Meta's sample app (owner's choice) |
| Text-only shortcut | not stated | `auto_publish_text=true` would skip the publish call for text; **not used**, so every post type keeps the same two-step flow and the same ambiguity rule |

**UNVERIFIED in research** (covered by mocked tests and reported as such, never as "working"):

- U1: whether the `graph.threads.net` host still works. Docket defaults to `graph.threads.com` and lets the deployer change it.
- U2: the dashboard's "User Token Generator" (or Graph API Explorer "Generate Threads Access Token") as the source of a pasteable token, and whether it issues a short-lived or a long-lived token.

**NEEDS RESEARCH** (not in `docs/research/meta.md`; phases cannot fetch the web, so either the `platform-researcher` agent adds them to the research file before planning, or planning uses the interim value shown, records it in `docs/decisions.md` as an unverified assumption, keeps it in one constant, and covers it with mocks):

- R1: The API version segment in Threads publishing paths, and which token paths are unversioned. The research shows `/access_token` and `/refresh_access_token` without a version. *Interim*: one constant for the publishing version (`v1.0`), token paths unversioned; recorded as unverified.
- R2: How to read the connected user's Threads id and username after login (the token exchange may or may not return the user id). *Interim*: one profile read (`/me` with `id,username`) using the long-lived token.
- R3: The exact request shape of the code exchange (form body vs query, field names) and the fields of the long-lived and refresh responses (`access_token`, `expires_in`, `token_type`). *Interim*: form-encoded `POST /oauth/access_token` with `client_id`, `client_secret`, `grant_type=authorization_code`, `redirect_uri`, `code`; responses read defensively; a missing `expires_in` on a long-lived or refreshed token is assumed to be 60 days.
- R4: Threads error body shape and codes (rate limiting, temporary, invalid token). *Interim*: the shared Meta error table and body parser from 005; code 190 means the token is invalid.
- R5: Carousel item parameters (an "is carousel item" flag on each child, a `children` list on the parent), whether each child container must be `FINISHED` before the parent is created, and whether the container's `ERROR` state carries a readable reason field. *Interim*: mirror Instagram (child flag + ordered `children`); only the container that will be published is status-checked; a reason field is read if present and the message stays generic otherwise.
- R6: How long an unpublished Threads container lives before `EXPIRED`. *Interim*: assume 24 hours, like Instagram, with the same "recreate only before any publish request was sent" rule.
- R7: The response fields of `threads_publishing_limit` (`quota_usage`, `config.quota_total`, `config.quota_duration`). *Interim*: read defensively; an unreadable quota never blocks, and Docket's own counter still applies.
- R8: Whether the Threads use case's "Redirect Callback URLs" accept a non-default port (e.g. `https://docket.local:3000/...`), and whether the dashboard also requires "Uninstall" and "Delete" callback URLs. *Interim*: docs show the port-3000 form and say what to try if it is refused; no uninstall or delete callback endpoint is built in this entry, and if the dashboard insists on one the docs say to enter the deployment's base address (recorded).
- R9: The precise "emoji counted by UTF-8 bytes" rule: which characters count as emoji, and whether non-emoji characters count per code point or per grapheme. *Interim*: see FR-020.
- R10: The public post URL (permalink) for a published Threads post. *Interim*: no URL is stored; only the platform's post id (same as 005's R5 outcome).

## Framework gaps this feature exposes

Threads is the first provider whose text limit is counted by a rule the shared counter does not know, and the first OAuth group whose platform refuses plain-HTTP or localhost redirect addresses. Reading the current framework shows two gaps (numbered after 005's G5–G8). Each is a **framework defect**: it is fixed generically for every provider, recorded in `docs/decisions.md` (what, why, how to reverse), and must not be implemented with Threads-specific code outside the provider folder and the shared Meta module.

- **G9: a provider cannot bring its own text counting rule.** The capability's counting rule is a closed list (graphemes, code points, UTF-8 bytes) and both the shared validator and the composer's live counter switch on it. Threads counts ordinary characters one each but emoji by their UTF-8 bytes. The fix lets a provider declare its own counting rule in its own folder, and the shared validator and the composer counter use it, so the count shown while typing always equals the count that validation and publish gates enforce.
- **G10: a connect group cannot say the deployment's callback address is unusable.** Threads refuses non-HTTPS and localhost redirect addresses, so on a deployment whose public URL is `http://…` or `localhost` the Threads login would always fail at the platform with an unhelpful page. The fix lets a connect group declare what callback address it accepts (for example "HTTPS only, not localhost"). When the deployment's address does not qualify, the accounts screen shows that group's connect action as unavailable with a plain reason and a link to the setup doc, a direct start request is refused on the server before any redirect, and the group's paste-token fallback stays available. Start-up does not fail because of it, since other providers may not need HTTPS.

No other scheduler, composer or schema change is expected. Facebook and Instagram behaviour must not change. Changes to the shared Meta module (for example a configurable API base, unversioned token paths, a parameterised token exchange) are allowed only as generic, provider-neutral fixes whose existing Facebook and Instagram tests keep passing unchanged. Anything else planning finds is a further framework defect handled the same way.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect a Threads account (Priority: P1)

A project owner or admin opens the accounts screen and chooses "Connect Threads". Docket sends them to Threads' login page over HTTPS, where they approve the two permissions. Back in Docket they see their Threads profile in the chooser, confirm it, and the account appears as Connected. Behind the scenes the short-lived token is exchanged on the server for a 60-day token, which is stored encrypted and never reaches the browser.

**Why this priority**: Nothing else works without a connected account.

**Independent Test**: With all Threads HTTP stubbed, start the connect action, follow the redirect, call the callback with the returned state and a fake code, and submit the chooser. Confirm one account row exists for the project with provider key `threads`, the Threads user id as external id and the username as display name; that its credentials decrypt to the long-lived token with its issue and expiry times; that its stored expiry is about 60 days ahead; that the code exchange and long-lived exchange were made server-side with the Threads app secret; and that no token, code or secret appears in any response, log, page or attempt record.

**Acceptance Scenarios**:

1. **Given** an owner on the accounts screen with Threads configured and an HTTPS public address, **When** they start the connect action, **Then** they are redirected to Threads' authorization page for the Threads app id, with the scopes `threads_basic` and `threads_content_publish`, a single-use state value and the deployment's fixed HTTPS callback address.
2. **Given** a valid callback (matching state, same signed-in user, still owner or admin), **When** it is handled, **Then** the code is exchanged server-side for a short-lived token, that token is exchanged for a long-lived token, the profile (id, username) is read, and one candidate is offered in the chooser.
3. **Given** the chooser, **When** the person confirms, **Then** the account is saved with only the long-lived token (encrypted), its issue time and its expiry; the short-lived token and the code are not stored anywhere.
4. **Given** the same Threads account is already connected in this project, **When** it is connected again, **Then** it is updated in place (new token and expiry, reactivated, last error cleared), not duplicated, and the chooser marks it "already connected".
5. **Given** an editor, **Then** no connect action is shown and direct requests to start, call back or choose are refused on the server (existing G5 rules).
6. **Given** the Threads app id and secret are missing, **Then** the Threads connect action is not offered, the screen says Threads is not configured and points to `docs/meta-setup.md`, and Facebook, Instagram and every other provider keep working.
7. **Given** the deployment's public address is not HTTPS or is a localhost address, **Then** the Threads connect action is shown as unavailable with the reason "Threads needs an HTTPS address that is not localhost" and a link to the local HTTPS walkthrough; a direct start request is refused before any redirect (G10); the paste-token form remains available.
8. **Given** the person cancels on Threads' page or Threads returns an error, **Then** they return to the accounts screen with a plain message and nothing changes (existing G5 callback rules).
9. **Given** a person who has not accepted the tester invite, **When** Threads refuses the login, **Then** the message reminds them to accept the invite in Threads under Settings → Website permissions.

---

### User Story 2 - Publish text, image and carousel posts through the container step machine (Priority: P1)

An editor writes a post, targets a connected Threads account and queues, schedules or publishes it now. The unchanged scheduler publishes it in several short ticks: create the container (for a carousel, each item first, then the carousel), check in later ticks until Threads says it is ready, check the publishing quota, then send one publish request. No tick waits or sleeps.

**Why this priority**: This is the feature's purpose and the riskiest part (the publish step decides between published and ambiguous).

**Independent Test**: Run the real scheduler tick against a test database with Threads HTTP stubbed. Publish (a) a text-only post, (b) a one-image post whose container is `IN_PROGRESS` on the first check and `FINISHED` on the second, (c) a five-image carousel. Assert the request sequence and parameters for each, that every step is a separate tick, that each status check is scheduled with a not-before time rather than a sleep, that the quota check happens before publishing, that exactly one publish request is sent, that only the publish step is may-publish, and that each target ends `published` with the returned post id.

**Acceptance Scenarios**:

1. **Given** a due text-only target, **When** the tick advances it, **Then** the steps are: create a `TEXT` container with the text, check its status in a later tick, check the quota, and send one publish request with the container id. Only the publish step is may-publish.
2. **Given** a due single-image target, **Then** the create step sends an `IMAGE` container with the image's public URL (the Threads variant from the media pipeline when the original is not acceptable), the text, and the image's alt text when it is not empty; then status check, quota check and publish as above.
3. **Given** a due target with N images (2 ≤ N ≤ 20), **Then** one item container is created per image, in order, each in its own non-publishing step and each carrying its alt text; then one `CAROUSEL` container listing the items in order with the text; then status check, quota check and publish.
4. **Given** a status check returns `IN_PROGRESS`, **Then** the step returns `continue` with a not-before time and the next check happens in a later tick. The first check is about 30 seconds after the container was created; later checks are about one minute apart.
5. **Given** a container is still `IN_PROGRESS` 5 minutes after it was created, **Then** the target fails with "Threads did not finish processing the post" and no publish request is ever sent.
6. **Given** a status check returns `ERROR`, **Then** the target fails (`fatal_error`) with the platform's reason when one is given (secrets removed), and no publish request is sent.
7. **Given** a status check returns `EXPIRED` and no publish request has been sent for this target's current containers, **Then** the containers are created again from the first step, at most twice per publish attempt; after that the target fails with a clear message.
8. **Given** a status check returns `PUBLISHED` before Docket sent a publish request, **Then** the target is `ambiguous`, because something already published that container.
9. **Given** the publish request is answered with a definitive rejection (including "container expired"), **Then** the target fails with the reason; containers are never recreated automatically after a publish request was sent.
10. **Given** the publish request succeeds, **Then** the target is `done` with the returned post id as its external id.

---

### User Story 3 - Unknown, rate-limited and rejected outcomes behave safely (Priority: P1)

If the publish request times out, drops mid-response, gets a server error, or returns a reply Docket cannot understand, the target is `ambiguous` and never retried automatically. Earlier steps cannot make a post public, so their transient failures are simply retried. Rate limits wait; rejections fail with the reason; a dead token flags the account.

**Why this priority**: A missed post beats a duplicate post (constitution V).

**Independent Test**: For the publish step and for each non-publishing step (item create, container create, carousel create, status check, quota check), stub: timeout after send, connection reset, 5xx, 2xx unparseable, 2xx without an id, a rate-limit error, a validation or permission error, error code 190, and a pre-send connection failure. Assert the mapping below.

**Acceptance Scenarios**:

1. **Given** the publish request was sent and no usable reply came back (timeout, abort, reset), **Then** `ambiguous`.
2. **Given** the publish request gets a 2xx whose body cannot be parsed or has no post id, **Then** `ambiguous`.
3. **Given** the publish request gets a 5xx or an error marked unknown or temporary (R4), **Then** `ambiguous`.
4. **Given** any step gets an error identified as rate limiting (R4), **Then** `retryable_error`, with the platform's not-before time when given and the engine's backoff otherwise.
5. **Given** any step gets a validation or permission rejection, **Then** `fatal_error` with the platform's message, secrets removed.
6. **Given** a non-publishing step times out, resets, gets a 5xx or an unparseable reply, **Then** `retryable_error`; nothing is ambiguous because nothing could have been published.
7. **Given** a connection failure known to be before sending (DNS failure, connection refused), **Then** `retryable_error` on any step, including publish.
8. **Given** any step is answered with error code 190 (invalid or expired token), **Then** `fatal_error` with the credentials-invalid flag (G7): the account becomes `needs_reauth`, the target is not retried, and the result is never `ambiguous`. A Threads token cannot be renewed once it has expired or been revoked, so no refresh is attempted.

---

### User Story 4 - Tokens are renewed before they expire (Priority: P1)

Threads tokens last 60 days. The scheduler's token-refresh section renews each Threads account's token when it is close to expiry, as long as the token is at least 24 hours old and has not expired. If Threads refuses, the account is flagged "needs reconnection" in the existing prominent banner and stops publishing until the owner reconnects.

**Why this priority**: Without renewal every Threads account silently stops working after 60 days.

**Independent Test**: With Threads HTTP stubbed and the database clock set, (a) put an account's expiry inside the refresh window with a token issued 50 days ago and run the token-refresh section: assert one refresh request, new encrypted token, new issue time and an expiry about 60 days ahead; (b) stub a refusal: assert `needs_reauth` with a readable, secret-free reason; (c) stub a 5xx or network failure: assert the account stays `active` and is tried again on a later tick; (d) give the account a token issued 2 hours ago but an expiry inside the window: assert no request is sent and the account stays `active`; (e) give it an already-expired token: assert no request is sent and the account becomes `needs_reauth`.

**Acceptance Scenarios**:

1. **Given** a Threads account whose stored expiry is within the refresh window, whose token is at least 24 hours old and not expired, **When** the token-refresh section runs, **Then** the token is renewed server-side, the new token is stored encrypted with its new issue time and expiry, and the account stays `active` with the last error cleared.
2. **Given** Threads refuses the renewal (invalid token, revoked access, any definitive rejection), **Then** the account becomes `needs_reauth` with a readable reason, its due targets stop with the existing "Reconnect … to publish" message, and no token appears in the reason.
3. **Given** the renewal fails with a network error, timeout or 5xx, **Then** the failure is transient: the account stays `active`, the last error records the temporary failure, and a later tick tries again; once the token's expiry passes without a successful renewal, the next attempt marks it `needs_reauth` (scenario 5).
4. **Given** a token less than 24 hours old, **When** the refresh section reaches it, **Then** no request is sent to Threads and the account is not flagged; the renewal waits until the token is old enough.
5. **Given** a token whose expiry has passed, **Then** no request is sent, and the account becomes `needs_reauth` with "The Threads token expired. Reconnect the account."
6. **Given** a successful renewal response with an unreadable body or no token, **Then** the old credentials are kept unchanged and the failure is treated as transient (the old token is still valid until its expiry).
7. **Given** a reconnect of a `needs_reauth` account through the connect flow or the paste form, **Then** it becomes `active` with the new token and failed targets can be retried with the existing retry action.

---

### User Story 5 - Threads' own counting and media rules in the composer (Priority: P2)

While composing, an editor sees the Threads character count using Threads' own rule (emoji count by their UTF-8 bytes), clear errors over 500, and Threads' image rules (JPEG or PNG, up to 8 MB, 320–1,440 px wide, at most 20 images, alt text up to 1,000 characters) with notes where an image will be adapted.

**Why this priority**: It stops posts that would fail at publish time; the publish gates already enforce the same checks.

**Independent Test**: Call the provider's validation directly with crafted content (plain text, accented letters, single emoji, emoji with skin tone, flags, family ZWJ sequences, keycaps), then the composer's existing check endpoint with a Threads target, and compare counts and issues.

**Acceptance Scenarios**:

1. **Given** 500 plain ASCII characters, **Then** no text error. **Given** 501, **Then** `text_too_long` with count 501 and limit 500.
2. **Given** text containing "😀" (4 UTF-8 bytes), **Then** that emoji counts 4. **Given** "👍🏽" (8 bytes), **Then** it counts 8. **Given** the family emoji "👨‍👩‍👧‍👦" (25 bytes), **Then** it counts 25. **Given** a flag "🇫🇷", **Then** it counts 8.
3. **Given** 496 plain characters plus one "😀", **Then** the count is 500 and allowed; with two such emoji, the count is 504 and blocked.
4. **Given** accented and non-Latin letters ("é", "日"), **Then** each counts 1 (only emoji are counted by bytes).
5. **Given** the composer shows a live count for a Threads target, **Then** it equals the count validation uses (G9).
6. **Given** 21 images, **Then** `too_many_images` with limit 20. **Given** 20, **Then** allowed.
7. **Given** a text-only post, **Then** no media error. **Given** an empty post (no text, no images), **Then** `empty_post`.
8. **Given** an image narrower than 320 px, **Then** a blocking `image_too_small` error naming that image. **Given** one wider than 1,440 px, a WebP/GIF/HEIC, or one over 8 MB, **Then** an informational note says it will be downscaled, converted to JPEG or compressed.
9. **Given** an image with an aspect ratio beyond 10:1 (in either orientation), **Then** `aspect_ratio_out_of_range` is a blocking error naming that image.
10. **Given** alt text over 1,000 characters on any image, **Then** `alt_text_too_long` is a blocking error.

---

### User Story 6 - Threads publishing limits are respected (Priority: P2)

Docket never sends more than 250 posts for one Threads account in a rolling 24 hours. Its own counter holds targets back before any call, and just before publishing it also asks Threads how much of the quota is used.

**Why this priority**: Going over the limit fails posts; most accounts never reach it.

**Independent Test**: (a) Fill Docket's own counter to 250 starts in the window and assert the 251st target waits with no provider call. (b) Stub the quota read to report the limit reached and assert the target is retried later with a not-before time and no publish request. (c) Stub an unreadable quota and assert publishing proceeds on Docket's own counter.

**Acceptance Scenarios**:

1. **Given** the Threads provider, **Then** it declares a default publish limit of 250 per 86,400 seconds, enforced by the existing engine counter; an account-level override still works.
2. **Given** the quota read reports the account at or over its limit, **Then** `retryable_error` with a not-before time of at least one hour, no publish request is sent, and the attempt summary records the reported usage.
3. **Given** the quota read fails or cannot be parsed, **Then** it does not block publishing on its own; Docket's own counter remains the guard, and the summary records that the quota was unknown.
4. **Given** a wait for quota outlasts the container's assumed lifetime (R6), **Then** the container is recreated before publishing, since no publish request was sent.

---

### User Story 7 - Paste a token from the Threads token generator (Priority: P2)

When the HTTPS redirect cannot be set up (for example on a laptop without a local certificate), an owner or admin generates a token for their Threads tester account in the Meta dashboard and pastes it into the accounts screen. Docket turns it into a long-lived token on the server, reads the profile and shows the same chooser. The same paste can reconnect an account that needs it.

**Why this priority**: It is the documented fallback; the main flow works without it.

**Independent Test**: Stub the exchange, refresh and profile endpoints. Paste (a) a short-lived token that exchanges successfully, (b) a token the exchange refuses but the renewal accepts, (c) a token both refuse but the profile read accepts, (d) a token everything refuses. Assert the chooser or message for each, the stored issue time and expiry, and that the pasted token is never echoed, logged or kept beyond what is saved as the account's credential.

**Acceptance Scenarios**:

1. **Given** a pasted short-lived token, **When** submitted, **Then** it is exchanged server-side for a long-lived token, the profile is read, and the chooser shows the account; the long-lived token (not the pasted one) is what is saved.
2. **Given** the exchange refuses the token (for example because it is already long-lived), **Then** Docket tries a renewal; if that succeeds the renewed token, with its known 60-day expiry, is what is saved.
3. **Given** both the exchange and the renewal refuse but the token can read the profile, **Then** the pasted token itself is saved, with its issue time recorded as the paste time and its expiry estimated as 60 days after the paste; the chooser and the account say the expiry is estimated, and the docs advise pasting a freshly generated token.
4. **Given** a token nothing accepts (expired, wrong app, malformed), **Then** a clear message is shown, the field is cleared and nothing changes.
5. **Given** an editor, **Then** the paste form is not shown and a direct request is refused on the server.
6. **Given** the paste form, **Then** its help text names the permissions to grant and where to generate the token (marked unverified, U2).

---

### User Story 8 - Owner can set up Threads, including local HTTPS, from written steps (Priority: P2)

The owner (or anyone deploying Docket) follows the new Threads section of `docs/meta-setup.md` to add the Threads use case to their Meta app, invite each Threads account as a tester and have it accept, register the HTTPS redirect addresses, set the env vars, and, for local development, give their machine an HTTPS name with a hosts-file entry and an mkcert certificate and run the dev server over HTTPS.

**Why this priority**: Without it nobody can connect a real Threads account, but it is documentation.

**Independent Test**: Review the document against FR-041 and FR-042 and confirm every env var it names exists in `.env.example` and in the Threads group's start-up validation, and that the dev-server command it gives uses only flags documented by the installed Next.js.

**Acceptance Scenarios**:

1. **Given** a deployer with a Meta app from the Facebook steps, **When** they follow the Threads section, **Then** they end with a Threads app id and secret, invited and accepted testers, and the redirect address registered, without App Review.
2. **Given** local development, **Then** the document walks through: adding `127.0.0.1 docket.local` to the hosts file, installing mkcert's local CA and creating a certificate for `docket.local`, setting the public address to `https://docket.local:3000`, starting the dev server over HTTPS with that certificate and key, registering `https://docket.local:3000/connect/callback`, and what to try if the port or the hostname is refused (R8).
3. **Given** the redirect cannot be made to work, **Then** the document gives the token-paste fallback (US7), marked unverified (U2).

---

### Edge Cases

- **Person declines `threads_content_publish` in the login dialog**: the account connects (if `threads_basic` was granted), and the first publish fails with a clear permission `fatal_error`; the chooser notes which permissions were granted when the platform says so.
- **Same Threads account connected in two projects**: allowed; each project has its own row and encrypted token, and each is renewed independently. Renewing one does not invalidate the other (UNVERIFIED; if it does, the other gets `needs_reauth` on its next call and can be reconnected).
- **Facebook configured but Threads not, or the reverse**: each group is configured, shown and validated on its own; neither blocks the other.
- **Threads app id set without its secret (or the reverse)**: a start-up error naming the missing variable, never its value (all-or-none, like Meta).
- **`THREADS_GRAPH_BASE` set to a non-HTTPS URL, or one with a path, query or credentials**: a start-up error; the default is used when it is empty.
- **Public address is HTTPS but uses an IP address or `localhost`**: treated as unusable for Threads (G10).
- **Text exactly 500 counted units with emoji**: allowed; 501 blocked. **Text over 500 in a carousel**: blocked the same way.
- **Exactly 20 images / exactly 8 MB / width exactly 320 or 1,440 px / alt text exactly 1,000 characters / aspect exactly 10:1**: allowed; one more is an error (or adapted, for bytes and wide images).
- **Image-only post with empty text**: allowed; the container is created without text.
- **Media unreachable by Threads** (private bucket, localhost): the create step's rejection is a `fatal_error` whose message says media must be at a public URL (existing 003 rule: use a real bucket in every environment).
- **Image deleted or variant missing at publish time**: existing 003 rules (regenerate, or fail before any provider call).
- **Killed tick mid-step**: existing lease recovery; a non-publishing step retries, the publish step becomes `ambiguous`.
- **Manual retry of a failed Threads target**: step state is cleared (existing behaviour), so fresh containers are created.
- **Post edited between steps so the image count no longer matches the step state**: the step machine restarts from the first create step rather than publishing a mismatched container (as Instagram does).
- **Token renewed while a publish is mid-flight**: the publish uses the credentials it was given; a 190 caused by a just-rotated token marks `needs_reauth` only if the stored ciphertext is still the one used (existing G7 conditional rule).
- **Refresh window configured larger than the token's age allows** (impossible with today's 720-hour maximum, but defended): a token under 24 hours old is never sent for renewal.
- **Tokens or codes in platform error bodies or URLs**: removed from every stored error, summary and log; the secret scrubber also covers the Threads token parameter names.

## Requirements *(mandatory)*

### Functional Requirements

**Scope and registration**

- **FR-001**: The Threads provider MUST live in its own provider folder and be enabled by exactly one registry entry. It MUST reuse the shared Meta module (Graph client, error classification, secret scrubbing, outcome-to-result mapping, token-exchange helpers) rather than copying it, and MUST NOT import server code (existing lint rule).
- **FR-002**: The feature MUST NOT add Threads- or Meta-specific code to the scheduler, composer, services, routes or schema. Every change outside the Threads folder and the shared Meta module MUST be a generic framework fix (G9, G10 or any newly found gap), MUST work for any provider, and MUST be recorded in `docs/decisions.md` with what, why and how to reverse it.
- **FR-003**: Changes to the shared Meta module MUST be provider-neutral (for example a configurable API base, optional version segment, parameterised token exchange) and MUST leave Facebook and Instagram behaviour unchanged; their existing tests MUST pass without modification to their expectations.
- **FR-004**: A test MUST show that the unchanged engine publishes a Threads text, image and carousel target end to end (claim → steps → published) with only HTTP stubbed.
- **FR-005**: Video, replies, quote posts, link attachments, topic tags, polls, the generator and the public API MUST NOT be implemented. The step state MUST name the container's media type so video containers (which need longer polling) can be added later as new step kinds without changing the scheduler.

**Configuration**

- **FR-006**: Threads settings MUST come from the environment and be declared by the Threads connect group (G8): `THREADS_APP_ID`, `THREADS_APP_SECRET` (all-or-none; without both, Threads is "not configured" and its connect actions are hidden) and `THREADS_GRAPH_BASE` (optional, an `https://` origin with no path, query or credentials; default `https://graph.threads.com`). All MUST be documented in `.env.example` and validated at start-up; the secret MUST never be logged or sent to the browser, and issues MUST name variables only.
- **FR-007**: The Threads authorization page address MUST be a single constant (`https://threads.com/oauth/authorize` per research); the API base MUST be read from `THREADS_GRAPH_BASE` for every token and publishing call.

**Connect (reusing G5/G6, plus G10)**

- **FR-008**: Threads MUST be its own connect group (separate app id and secret from the Facebook and Instagram group), using the existing generic start, state, callback, chooser and paste machinery unchanged except for G10.
- **FR-009**: The group MUST declare that it accepts only an HTTPS callback address whose host is not `localhost`, a loopback address or another IP address (G10). When the deployment's callback address does not qualify, the connect action MUST be shown as unavailable with that reason and a link to the local HTTPS walkthrough, and a start request MUST be refused on the server before any state is created or redirect sent.
- **FR-010**: The authorization request MUST carry the Threads app id, the fixed callback address, the scopes `threads_basic,threads_content_publish`, `response_type=code` and the single-use state.
- **FR-011**: The callback MUST exchange the code on the server with the Threads app secret for a short-lived token (R3), then exchange that for a long-lived token (`th_exchange_token`), then read the profile (id and username, R2). Any failure MUST create or change nothing and MUST show a message that says what to check (app id and secret, redirect address, tester invite accepted) without exposing secrets.
- **FR-012**: The connect result MUST be one candidate with provider key `threads`, external id = Threads user id, display name = `@username` (falling back to the id), credentials = { long-lived token, issue time, expiry, whether the expiry is estimated }, and the expiry also returned as the account's credential expiry so the scheduled refresh can find it.
- **FR-013**: **Decision**: only the long-lived token is stored, encrypted. The authorization code and the short-lived token MUST NOT be stored anywhere. Why: the long-lived token is the only one any later call uses, and the shorter-lived ones would only widen what a leak exposes. Recorded in `docs/decisions.md`.
- **FR-014**: A callback error or login refusal MUST return the person to the accounts screen with a plain message; a refusal that suggests the person is not an accepted tester MUST say to accept the invite in Threads under Settings → Website permissions.
- **FR-015**: The group MUST offer a paste-token fallback (owners and admins only). A pasted token MUST be tried, in order: exchange for a long-lived token; renewal; profile read with the token as is. The first that works decides what is saved (US7 scenarios 1–3). When the pasted token itself is saved, its issue time MUST be the paste time and its expiry estimated at 60 days later, marked as estimated, and shown as such on the account. The pasted token MUST NOT be echoed after submit or logged.

**Token renewal**

- **FR-016**: The provider MUST implement credential renewal used by the existing scheduled token-refresh section. Renewal MUST call `th_refresh_token` only when the token is at least 24 hours old (by its stored issue time) and not yet expired.
- **FR-017**: A token under 24 hours old MUST NOT be sent for renewal; the result MUST be transient (account stays `active`) with a retry time of issue time + 24 hours. A token past its expiry MUST NOT be sent; the result MUST be a definitive failure ("The Threads token expired. Reconnect the account.") so the account becomes `needs_reauth`.
- **FR-018**: A successful renewal MUST store the new token with issue time = renewal time and expiry from the response (60 days when the response gives none, R3), clearing the estimated-expiry mark. A definitive refusal (invalid token, revoked access, rejected request) MUST be a definitive failure (`needs_reauth`) with a readable, secret-free reason. A network error, timeout, 5xx or unreadable success body MUST be transient, keeping the old credentials.
- **FR-019**: The provider MUST NOT request a refresh ahead of individual publishes (60-day tokens are renewed by the scheduled section). An invalid-token answer during publishing MUST use the credentials-invalid flag (G7), because an expired or revoked Threads token cannot be renewed.

**Capabilities and validation (G9)**

- **FR-020**: The provider MUST declare its own text counting rule (G9): each emoji counts as the UTF-8 byte length of its whole user-perceived character (an emoji grapheme: any grapheme cluster containing an Extended_Pictographic character, a regional-indicator pair, or a keycap sequence, including its modifiers, variation selectors and joiners); every other user-perceived character counts as one per code point. The limit is 500. The rule and its examples MUST be recorded as an interim reading of the research (R9).
- **FR-021**: The shared validator and the composer's live counter MUST both use the provider's declared rule, so the displayed count equals the enforced count for every provider.
- **FR-022**: Capabilities MUST declare: post types text, image and carousel; text-only allowed; media not required; at most 20 images (one image = image post, 2–20 = carousel); JPEG and PNG allowed, others converted to JPEG; at most 8,000,000 bytes per image (interim reading of "8 MB", recorded); minimum width 320 px and maximum width 1,440 px (wider images downscaled, narrower refused); aspect ratio between 1:10 and 10:1 inclusive (interim reading of "≤ 10:1", recorded); alt text up to 1,000 characters; and a default publish limit of 250 per 86,400 seconds.
- **FR-023**: `validate` MUST return the shared capability checks, counted with the declared rule. Any Threads-only check added beyond what the capabilities express MUST be recorded in `docs/decisions.md`.

**Step machine**

- **FR-024**: `stepFor` MUST be pure and total. The step order MUST be: for a carousel, one non-publishing item-create step per image in order, then one non-publishing carousel-create step; for a single image or text, one non-publishing create step; then one or more non-publishing status-check steps; then one non-publishing quota-check step; then exactly one may-publish publish step.
- **FR-025**: Create steps MUST send the media type (`TEXT`, `IMAGE` or `CAROUSEL`), the text where present, the Threads variant's public URL for images, each image's alt text when non-empty, and for a carousel the ordered child container ids (R5). Step state MUST hold only non-secret data: media type, container ids in order, container creation time, status-check count, recreation count and whether the quota was checked.
- **FR-026**: Status checks MUST read only the container's `status`. They MUST return `continue` with a not-before time while `IN_PROGRESS` (first check about 30 seconds after creation, then about 60 seconds apart), MUST move on when `FINISHED`, MUST fail on `ERROR`, MUST recreate containers on `EXPIRED` (from the first step, at most twice per publish attempt) because no publish request has been sent, MUST return `ambiguous` on `PUBLISHED`, and MUST fail with "Threads did not finish processing the post" once 5 minutes have passed since creation while still `IN_PROGRESS`. No step may loop, poll in-process or sleep.
- **FR-027**: The quota-check step MUST read the account's `threads_publishing_limit` (R7). At or over the limit it MUST return `retryable_error` with a not-before time of at least one hour and send nothing else; an unreadable quota MUST NOT block. Before publishing, a container older than its assumed safe lifetime (R6) MUST be recreated.
- **FR-028**: The publish step MUST send exactly one `threads_publish` request with the ready container id. A timeout, abort, reset, 5xx, unknown or temporary error, or a 2xx without a parseable post id MUST be `ambiguous`. A rate-limit error MUST be `retryable_error` (the request was not executed). A definitive rejection, including an expired container, MUST be `fatal_error`; containers are never recreated after a publish request was sent.
- **FR-029**: On success the result MUST be `done` with the returned post id as the external id (no URL, R10).
- **FR-030**: State that no longer fits the post (image count changed, unknown shape) MUST restart from the first create step instead of publishing a mismatched container.

**Outcomes, secrets and summaries**

- **FR-031**: Every outcome MUST follow the framework table in `docs/adding-a-provider.md` §7 as refined by US3. Every network call MUST honour the engine's abort signal.
- **FR-032**: Attempt summaries MUST record the step, image index, media type, container ids, container status, quota usage when known, HTTP status, error code, subcode and trace id. They MUST NOT record tokens, the app secret, authorization codes or full response bodies.
- **FR-033**: Tokens, the Threads app secret and authorization codes MUST NOT appear in the browser, logs, attempt records, step state, account last-error text, error messages, thrown messages or test snapshots. Tokens MUST travel in request bodies rather than URLs wherever the platform allows, and the shared scrubber MUST cover every Threads token parameter name. A test MUST assert this for connect, callback, paste, renewal and every advance path.

**Tests (mocked HTTP only)**

- **FR-034**: Tests MUST stub HTTP and make no live calls. They MUST cover:
  - counting: plain ASCII, accented and CJK letters, single emoji, skin-tone modifier, flag, keycap, family ZWJ sequence, text-presentation symbols, and the 500/501 boundary with emoji; the composer count equals the validator count (G9);
  - `validate` edges: empty post, text-only, 20/21 images, width 319/320 and 1,440/1,441, 8 MB boundary, aspect 10:1 boundary both ways, alt text 1,000/1,001, non-JPEG/PNG conversion note;
  - connect: start (authorization address, scopes, state), the HTTPS/localhost refusal (G10), callback success, code-exchange failure, long-lived exchange failure, profile failure, tester-not-accepted message, chooser save and in-place update, role refusal;
  - paste: each branch of FR-015 and the all-refused case;
  - renewal: success (new token, issue time, expiry), definitive refusal → `needs_reauth`, transient failure → stays `active`, unreadable success → transient, token under 24 hours → no request, expired token → no request and `needs_reauth`, run through the real token-refresh section;
  - every advance path: text, image and carousel happy paths; `IN_PROGRESS` then `FINISHED`; `ERROR`; `EXPIRED` with recreation and its cap; `PUBLISHED` before publish; the 5-minute processing cap; quota reached and quota unreadable; publish success; publish ambiguous (timeout, reset, 5xx, unparseable 2xx, missing id); publish rejected; rate limit on any step; pre-send network failure; transient failures on every non-publishing step; token invalid (190) on any step; mismatched state restart;
  - the generic fixes G9 and G10 with a throwaway provider, proving no Threads-specific code is needed in the engine, validator, composer or connect service;
  - Facebook and Instagram suites unchanged and passing after any shared-module change.

**Documentation**

- **FR-035**: `docs/meta-setup.md` MUST replace its Threads placeholder with exact manual dashboard steps: adding the Threads use case to the Meta app; the two permissions; where the Threads app id and secret are (separate from the Meta app's); inviting each Threads account as a "Threads Tester" and accepting the invite in Threads under Settings → Website permissions; registering the HTTPS redirect callback addresses for production and local use (and the R8 note on uninstall/delete callback fields); the env vars to set; and the token-generator paste fallback (U2).
- **FR-036**: `docs/meta-setup.md` MUST include a local HTTPS walkthrough: a hosts-file entry (`127.0.0.1 docket.local`, with the file's location on macOS/Linux and Windows); installing mkcert and its local CA and creating a certificate and key for `docket.local`; setting the deployment's public address (the existing `BETTER_AUTH_URL`) to `https://docket.local:3000`; starting the dev server over HTTPS with that certificate and key using the flags documented by the installed Next.js; registering `https://docket.local:3000/connect/callback`; and troubleshooting (browser certificate warnings, a refused port or hostname per R8, the existing sign-in cookie needing the new address). It MUST say this is the owner's chosen approach (not a tunnel) and that media still needs a public bucket.
- **FR-037**: A convenience script for running the dev server over HTTPS MAY be added if it needs no new dependency; mkcert itself is a developer tool the deployer installs, not a project dependency.
- **FR-038**: The README MUST gain a "Connecting Threads" section: what is stored, the 60-day token and automatic renewal, what "needs reconnection" means, the HTTPS requirement, the public-bucket requirement, and how to remove Docket's access in Threads' Website permissions.
- **FR-039**: `docs/adding-a-provider.md` MUST document provider-declared counting rules (G9) and callback-address requirements (G10), and add a Threads worked example: an expiring-token provider with the 24-hour renewal rule, a three-container-type step machine, and the publish-only ambiguity rule.
- **FR-040**: `docs/decisions.md` MUST record FR-013, G9 and G10 (what, why, how to reverse), the interim values for R1–R10 and FR-020/FR-022's readings, the polling cadence and 5-minute cap, the recreation rule and cap, the paste-fallback order and estimated expiry, not using `auto_publish_text`, and the "verified with mocks only" status of live Threads connect, renewal and publishing, U1 and U2.

### Key Entities *(include if feature involves data)*

- **Threads account**: an existing social account row with provider key `threads`. External id = Threads user id. Display name = `@username`. Settings: none required. Credentials (encrypted) = long-lived token, issue time, expiry, estimated-expiry mark. Credential expiry (the existing column) = the token's expiry, so the scheduled refresh finds it. Status `active` / `needs_reauth`.
- **Threads connect group**: a second connect group beside the Facebook/Instagram one, with its own app id and secret, authorization address, callback-address requirement (G10) and paste fallback.
- **Provider counting rule** (G9): a provider-declared function from text to a count, used by validation and the composer counter.
- **Publish step state** (plain, non-secret): media type, container ids in order (items then carousel), container creation time, status-check count, recreation count, quota-checked flag.
- **Published reference**: the Threads post id (external id) on the post target; no URL.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An owner with a configured Threads app and an HTTPS address can connect a Threads account in under 2 minutes, with one login and one confirmation.
- **SC-002**: Following the local HTTPS walkthrough, a developer on macOS or Linux can reach Docket at `https://docket.local:3000` with a trusted certificate in under 15 minutes.
- **SC-003**: With platform responses simulated, 100% of the specified outcomes (success, retryable, fatal, ambiguous, token invalid, container `IN_PROGRESS`/`ERROR`/`EXPIRED`/`PUBLISHED`, quota reached/unknown) produce the specified target and account status, and zero ambiguous outcomes are retried automatically.
- **SC-004**: A Threads text or single-image post whose container is ready at the first check publishes within 4 ticks after it is due; an N-image carousel within N + 4 ticks. No tick makes more than one platform request per step or waits for a container.
- **SC-005**: 100% of simulated Threads accounts nearing expiry with tokens at least 24 hours old are renewed by the token-refresh section before their expiry; zero renewal requests are sent for tokens under 24 hours old or already expired; every definitive refusal ends in `needs_reauth`.
- **SC-006**: Docket never sends a 251st Threads publish for one account within 24 hours, in a simulated run of 300 queued targets.
- **SC-007**: For every counting test string, the composer's displayed Threads count equals the validator's count, and posts at 500 counted units are accepted while 501 are blocked.
- **SC-008**: Zero occurrences of any token, Threads app secret or authorization code in the database (outside encrypted credential storage), logs, attempt records, step state, pages or responses across the whole test suite.
- **SC-009**: Outside the Threads folder and the shared Meta module, the diff contains only the registry line, the generic fixes G9 and G10 recorded in `docs/decisions.md`, tests and docs; Facebook and Instagram tests pass with unchanged expectations.
- **SC-010**: Lint, typecheck and the full test suite pass. Live Threads connect, renewal and publishing, the `.net` host question (U1) and the token generator (U2) are reported as "verified with mocks only" / "unverified" (constitution II), since no real Threads credentials are available to the build.

## Assumptions

- No live Threads app or tester account is available to the build. Everything is verified with mocks only; the owner checks live connect, renewal and publishing after merge and records "verified live on <date>" in `docs/decisions.md`.
- One Meta app serves every project; its Threads use case has its own app id and secret. Every Threads account is an invited and accepted tester, so no App Review is needed.
- The deployment's public address is the existing `BETTER_AUTH_URL`, and the callback is the existing fixed `/connect/callback`; for Threads it must be HTTPS and not localhost. Locally that means `https://docket.local:3000` (hosts file + mkcert), per the owner's answer 7.
- With the default 72-hour refresh window (maximum 720 hours) and 60-day tokens, an exchanged or renewed token is always at least 24 hours old when it enters the window; the 24-hour guard matters for estimated-expiry pasted tokens and as a defence.
- A transient renewal failure keeps the account `active` and is retried on later ticks (existing G3 behaviour); "needs_reauth on failure" applies to definitive refusals and to tokens that have expired.
- The engine's existing claim, lease recovery, backoff, attempt cap, own publish-limit counter, `needs_reauth` banner, ambiguous resolution UI, retry action, media variants and public bucket are reused unchanged, except for G9 and G10.
- Docket's tick runs about once a minute, so status checks scheduled sooner simply happen on the next tick. Status checks and quota reads do not count against the publishing limit.
- No new runtime dependency is needed; HTTP uses the platform `fetch`, and emoji detection uses the runtime's built-in Unicode support. If a dependency turns out to be needed, it is marked `NEEDS DEPENDENCY`.
- Content is not edited while a target is mid-publish (existing engine behaviour); FR-030 covers the case defensively.
- Profile pictures, insights, replies, mentions or link previews, and Threads' own scheduling are out of scope.
