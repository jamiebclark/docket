# Feature Specification: Facebook Pages and Instagram providers (Meta, part 1)

**Feature Branch**: `005-meta-facebook-instagram`

**Created**: 2026-10-03

**Status**: Draft

**Input**: User description: "Add Facebook Pages and Instagram providers using one Facebook Login for Business connect flow. Before specifying, read docs/build-prompt.md ('Platform notes', 'The provider framework', 'Publishing as a step machine', 'Scheduler rules', 'Media'), docs/research/meta.md (authoritative: Graph v26.0 via META_GRAPH_VERSION env; Facebook Login for Business covering a Page and its linked IG professional account via /me/accounts?fields=id,name,access_token,instagram_business_account; scopes pages_show_list, pages_manage_posts, pages_read_engagement, instagram_basic, instagram_content_publish; long-lived user token exchange then non-expiring Page tokens; IG container status_code EXPIRED|ERROR|FINISHED|IN_PROGRESS|PUBLISHED, 10-item carousels, JPEG only, 8 MB, aspect 4:5–1.91:1, alt_text, 100 posts/24h via content_publishing_limit, 24h container expiry; Facebook allows http://localhost redirects in development mode — unverified, test and document), docs/adding-a-provider.md, .specify/memory/constitution.md and docs/decisions.md. Must deliver, in this order: (1) a shared Meta OAuth module reusable by the later Threads entry (state + CSRF-safe callback, server-side code exchange, encrypted token storage, Graph client with version from env and typed error mapping: code 190 => needs_reauth, rate-limit codes => retryable) and a manual-token-paste fallback in account settings for tokens generated in Graph API Explorer (exchanged to long-lived server-side); (2) facebook provider: connect via Facebook Login, choose which Pages to add as accounts, long-lived Page tokens, text/link posts via /{page-id}/feed, single photo via /{page-id}/photos, multi-photo via unpublished photos + attached_media (flagged unverified in research — cover with mocks and say so); (3) instagram provider: the same connect flow offers each Page's linked IG professional account; container create -> poll status_code across ticks via `continue` with notBefore (never sleeping in-process) -> media_publish; carousels; JPEG variants from entry 3's variant pipeline; alt_text; expired-container handling (recreate only if publish was never attempted); publish-limit check against content_publishing_limit plus our own counter; media_publish timeout or unparseable response => ambiguous; (4) docs/meta-setup.md with exact manual dashboard steps for the Meta app (app creation, Facebook Login for Business use case, permissions, app roles for every account, Standard Access without App Review, valid OAuth redirect URIs for local and production) — Threads setup is added by the next entry. Providers registered only via the registry; no scheduler/composer/schema changes (a needed change is a framework defect: fix generically, log in decisions.md). Tests with mocked HTTP only for every validate/advance path incl. container IN_PROGRESS/ERROR/EXPIRED, retryable, fatal, ambiguous, token invalidation. Must NOT do: Threads (next entry, meta-threads), video/reels/stories (out of scope; keep the step machine extensible), generator (generator entry), public API (public-api entry)."

## Context and sources

- Product behaviour: `docs/build-prompt.md` ("The provider framework", "Publishing as a step machine", "Scheduler rules", "Platform notes → Shared Meta setup / Facebook Pages / Instagram", "Media").
- Platform facts: `docs/research/meta.md` (checked 2026-10-02). Where it disagrees with the brief, the research wins.
- Framework contract: `docs/adding-a-provider.md` and `src/providers/types.ts`; engine rules and earlier framework fixes (G1–G4) in `docs/decisions.md` (002, 003, 004).
- Decision 3 in `docs/decisions.md`: Instagram is connected through **Facebook Login for Business**, not Instagram Login.

**Brief vs research (research wins):**

| Topic | Brief says | Research says (used here) |
|---|---|---|
| Graph API version | "make it an env var" | `META_GRAPH_VERSION`, default **v26.0** |
| Instagram images | "JPEG only, convert on upload" | JPEG only (no MPO/JPS), **≤ 8 MB**, aspect ratio **4:5 to 1.91:1**, width 320–1440 px (scaled by Meta outside that range), sRGB |
| Instagram alt text | "passed to every platform that supports it" | `alt_text` up to **1,000 characters** on images and carousel items |
| Instagram carousels | "up to 10 items" | Same; all items are **cropped to the first image's aspect ratio** |
| Facebook multi-photo | "the photos edge for images" | Unpublished photos + `attached_media` on the feed — **UNVERIFIED** in the official docs |
| Local OAuth redirect | "document each platform's local options" | `http://localhost` allowed in development mode — **UNVERIFIED** in the current dashboard |
| Page permissions | `pages_manage_posts` | Also `pages_show_list` and `pages_read_engagement`; Pages reached only through Business Manager may also need `ads_management` / `ads_read` |

**UNVERIFIED in research** (covered by mocked tests and reported as such, never as "working"):

- U1: Facebook multi-photo posts via unpublished photo uploads followed by one feed post with `attached_media`.
- U2: `http://localhost` OAuth redirects in development mode with "Enforce HTTPS" on.

**NEEDS RESEARCH** (not in `docs/research/meta.md`; phases cannot fetch the web, so these must be added to the research file by the `platform-researcher` agent, or planning picks the conservative interim value shown, records it in `docs/decisions.md` as an assumption, and covers it with mocks):

- R1: Facebook Page post text limit and Instagram caption limit (and any hashtag/mention caps). *Interim*: a conservative limit per platform, counted in code points, recorded as unverified.
- R2: Facebook photo constraints (accepted types, byte limit, maximum photos in one multi-photo post) and whether Facebook photos accept alt text. *Interim*: JPEG and PNG, ≤ 8 MB, up to 10 photos, no alt text sent to Facebook (recorded).
- R3: Which Graph error codes mean "rate limited" or "temporarily unavailable", and the error body shape (code, subcode, type, message, trace id). *Interim*: one table in the shared Meta module, easy to change, covered by mocked tests; code 190 (from research) always means invalid token.
- R4: Whether Facebook Login for Business takes `scope` in the login dialog or a login **configuration id** (with permissions chosen in the dashboard). *Interim*: support both, with an optional configuration-id env var; `docs/meta-setup.md` describes the dashboard step either way.
- R5: The response fields of Instagram's `content_publishing_limit` and when a used slot frees up; the permalink field for a published Instagram media item and the public URL pattern for a Facebook Page post. *Interim*: quota read defensively (an unreadable quota falls back to Docket's own counter); post URLs are best-effort and omitted when unknown.
- R6: Whether the Meta app should sign server calls with an app-secret proof ("Require App Secret"). *Interim*: not required; noted in `docs/meta-setup.md`.

## Framework gaps this feature exposes

The brief says adding a provider must be "one folder plus one registry line", with no change to the scheduler, composer or schema. Facebook and Instagram are the first providers whose connect flow is an OAuth redirect, whose one sign-in yields several accounts across two providers, and whose tokens can be revoked without any refresh path. Reading the current framework shows three gaps (numbered after 004's G1–G4). Each is a **framework defect**: it is fixed generically for every provider, recorded in `docs/decisions.md` (what, why, how to reverse), and must not be implemented with Meta-specific code outside the provider folders and the shared Meta module.

- **G5: no generic OAuth connect.** The `oauth` connect strategy exists only as a type; the accounts screen hides it and nothing handles a redirect. The framework needs, for any OAuth provider: a start action that creates a CSRF-safe state and redirects to the platform; **one fixed callback address per deployment** (the project travels in the state, so one redirect URI works for every project); a server-side exchange of the returned code for tokens; a list of **candidate accounts** the person can choose from; and a generic chooser that saves the chosen accounts through the existing `saveConnectedAccount` path. One flow must be able to offer candidates for **more than one provider** (a Facebook Page and its linked Instagram account), so providers can declare a shared connect group and the accounts screen shows one connect action per group. Candidate tokens held between callback and choice stay on the server, encrypted, and expire with the state. If that needs storage that does not exist yet, the storage is generic (any OAuth provider can use it), it is justified in plan.md, and it is recorded as a framework change.
- **G6: a pasted token cannot produce candidates.** The `manual-token` strategy today can only turn fields into **one** account. A token pasted from Graph API Explorer must go through the same exchange and the same chooser as G5, and must be usable to reconnect an existing account. The fix is generic: a manual-token provider (or connect group) may return candidates instead of one account.
- **G7: no way to say "these credentials are dead".** A publish step can only signal `credentialsExpired`, which asks the engine to refresh. Page tokens have no refresh: when the platform says the token is invalid (code 190), the account must become `needs_reauth` at once, with a readable reason, and the target must stop without being retried against a dead token. The fix is a generic result flag (or equivalent) any provider can use. The response proves nothing was published, so this never yields `ambiguous`.

No other scheduler, composer or schema change is expected. Anything else planning finds is a further framework defect handled the same way.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect Facebook Pages and linked Instagram accounts with one login (Priority: P1)

A project owner or admin opens the project's accounts screen and chooses "Connect Facebook Pages and Instagram". Docket sends them to Facebook's login dialog, where they grant the requested permissions. Back in Docket they see every Page they manage and, under each Page, its linked Instagram professional account if it has one. They tick the ones this project should publish to and confirm. Each ticked Page becomes a Facebook account and each ticked Instagram account becomes an Instagram account, all shown as Connected. Tokens are stored encrypted and never reach the browser.

**Why this priority**: Nothing else works without connected accounts, and this delivers the shared Meta connect module (deliverable 1) that the Threads entry reuses.

**Independent Test**: With all Meta HTTP stubbed, start the connect action, follow the redirect, call the callback with the returned state and a fake code, and submit the chooser with one Page and one Instagram account ticked. Confirm two account rows exist for the project (provider keys `facebook` and `instagram`) with the Page id and Instagram account id as external ids, that their credentials decrypt to the non-expiring Page token, that the code exchange and long-lived exchange were made server-side with the app secret, and that no token appears in any response, log, page or attempt record.

**Acceptance Scenarios**:

1. **Given** an owner on the accounts screen with Meta configured, **When** they start the connect action, **Then** they are redirected to Facebook's login dialog for the configured app, with the requested permissions (`pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`), a single-use state value and the deployment's fixed callback address.
2. **Given** a valid callback (matching state, same signed-in user, still owner or admin of the project), **When** it is handled, **Then** the code is exchanged server-side for a user token, that token is exchanged for a long-lived user token, and the person's Pages are listed with their linked Instagram accounts.
3. **Given** the chooser, **When** the person ticks some Pages and some Instagram accounts and confirms, **Then** exactly those become accounts in the project, each with a non-expiring Page token stored encrypted; unticked candidates are not saved anywhere.
4. **Given** a Page with no linked Instagram professional account, **Then** only the Page is offered, with a note that no Instagram professional account is linked.
5. **Given** an account already connected in this project (same provider and external id), **When** it is chosen again, **Then** it is updated in place (new token, reactivated, last error cleared), not duplicated, and the chooser marks it "already connected".
6. **Given** an editor, **When** they view the accounts screen, **Then** they see no connect action, and direct requests to start, call back or choose are refused on the server.
7. **Given** Meta app settings are missing from the environment, **Then** the connect action is not offered and the screen says Meta is not configured, pointing to `docs/meta-setup.md`; every other provider keeps working.

---

### User Story 2 - The callback is safe against forgery and replay (Priority: P1)

The connect flow cannot be hijacked: a callback with a missing, wrong, expired or already-used state does nothing, a callback completed by a different signed-in user does nothing, and a cancelled login leaves everything unchanged.

**Why this priority**: The callback is a public endpoint that stores credentials into a project. A forged or replayed callback could attach someone else's Page to a project or leak a token.

**Independent Test**: Call the callback with (a) no state, (b) a state from another session, (c) an expired state, (d) a state already used, (e) a Facebook error response such as a cancelled login, (f) a valid state after the user lost the owner/admin role. Assert that no token exchange is attempted in (a)–(d) and (f), no account changes in any case, and each case shows a clear message.

**Acceptance Scenarios**:

1. **Given** a callback whose state is missing, unknown, expired (older than 10 minutes) or already used, **Then** no code exchange is made and the person sees "This connection attempt has expired or is not valid. Start again."
2. **Given** a valid state created by user A, **When** the callback arrives in user B's session, **Then** it is refused and nothing is exchanged.
3. **Given** Facebook returns an error instead of a code (for example the person cancelled), **Then** the person returns to the accounts screen with a plain message and nothing changes.
4. **Given** the code exchange or the long-lived exchange fails, **Then** no account is created or changed, and the message says what to check (app settings, permissions) without exposing secrets.
5. **Given** the chooser is left unsubmitted, **When** the state lifetime passes, **Then** the held candidate tokens are discarded and the choice can no longer be submitted.

---

### User Story 3 - Publish to a Facebook Page (Priority: P1)

An editor writes a post, targets a connected Facebook Page and queues it, schedules it or publishes it now. The unchanged scheduler publishes it: text (with or without a link) goes out as a feed post, one image goes out as a photo post with the text as its caption, and several images go out as one multi-photo post. The target shows as Published.

**Why this priority**: Facebook is the first deliverable provider and the simplest Meta publish path.

**Independent Test**: Run the real scheduler tick against a test database with Graph HTTP stubbed. Publish (a) a text post containing a URL, (b) a one-image post, (c) a three-image post. Assert the request sequence for each, that only the final request is treated as may-publish, and that each target ends `published` with the returned post id.

**Acceptance Scenarios**:

1. **Given** a due text-only target, **When** the tick advances it, **Then** one feed post request is sent with the text as the message and, when the text contains a URL, the first URL as the link; the target becomes published with the returned post id.
2. **Given** a target with one image, **Then** one photo request is sent with the image's public URL and the text as the caption, and the target becomes published.
3. **Given** a target with N images (2 ≤ N ≤ the Facebook maximum), **Then** each image is uploaded as an unpublished photo in its own non-publishing step, and one final feed post attaches all N in order. This path is flagged **unverified with the real platform** (U1) in docs and decisions.
4. **Given** an image is uploaded as unpublished and a later step fails, **Then** nothing becomes public, and the result follows the outcome rules (US6).
5. **Given** Facebook's native scheduling exists, **Then** it is never used; Docket's scheduler alone decides when the request is sent.

---

### User Story 4 - Publish to Instagram through the container step machine (Priority: P1)

An editor attaches one or more images (with alt text) and targets an Instagram account. At publish time Docket creates the media container(s), checks over later ticks until Instagram says the container is ready, checks the account's publishing quota, and then publishes it. No tick waits or sleeps; each tick does one step and returns.

**Why this priority**: Instagram is the main reason for the two-step publishing design and the hardest provider in scope.

**Independent Test**: With Graph HTTP stubbed, publish (a) one image whose container is `IN_PROGRESS` on the first check and `FINISHED` on the second, (b) a four-image carousel. Assert that each step is a separate tick, that each status check is scheduled with a not-before time rather than a sleep, that the quota check happens before publishing, that exactly one publish request is sent, and that the target is published with the returned media id.

**Acceptance Scenarios**:

1. **Given** a due single-image target, **When** the scheduler advances it, **Then** the steps are: create the image container (with the JPEG variant's public URL, the caption and the alt text), check its status in a later tick, check the publishing quota, and send one publish request. Only the publish step is may-publish.
2. **Given** a status check returns `IN_PROGRESS`, **Then** the step returns `continue` with a not-before time, and the next check happens in a later tick. Checks back off from about 10 seconds to at most 5 minutes apart.
3. **Given** a container stays `IN_PROGRESS` for more than 60 minutes, **Then** the target fails with "Instagram did not finish processing the media", and no publish request is ever sent.
4. **Given** a status check returns `ERROR`, **Then** the target fails (`fatal_error`) with the platform's reason, secrets removed, and no publish request is sent.
5. **Given** a status check returns `EXPIRED` and no publish request has been sent for this target's current containers, **Then** the containers are created again from the first step (at most twice per publish attempt; after that the target fails with a clear message).
6. **Given** the publish request is answered with "container expired", **Then** the target fails with a message saying to retry; containers are recreated only by a manual retry, never automatically after a publish request was sent.
7. **Given** a status check returns `PUBLISHED` before Docket sent a publish request, **Then** the target is `ambiguous`, because something already published that container.
8. **Given** a carousel of N images (2 ≤ N ≤ 10), **Then** one item container is created per image in its own non-publishing step, then one carousel container listing the items in order, then the status check, quota check and publish steps as above.
9. **Given** an image whose source is not JPEG, too large, or wider than allowed, **Then** the published container uses the Instagram variant from the media pipeline (JPEG, within the limits), never the original.
10. **Given** the step design, **Then** the step state names the container's media type, so video containers (which need longer polling) can be added later as new step kinds without changing the scheduler.

---

### User Story 5 - Instagram publishing limits are respected (Priority: P2)

Docket never sends more than 100 API-published posts for one Instagram account in a rolling 24 hours. Its own counter holds targets back before any call, and just before publishing it also asks Instagram how much of the quota is used.

**Why this priority**: Going over the platform limit fails posts; this protects busy accounts. A typical account never reaches the limit, so it is P2.

**Independent Test**: (a) Fill Docket's own counter to 100 starts in the window and assert the 101st target waits without any provider call. (b) Stub the quota check to report the limit reached and assert the target is retried later with a not-before time and no publish request. (c) Stub an unreadable quota response and assert publishing proceeds on Docket's own counter.

**Acceptance Scenarios**:

1. **Given** the Instagram provider, **Then** it declares a default publish limit of 100 per 86,400 seconds, enforced by the existing engine counter, and an account-level override still works.
2. **Given** the quota check reports the account at its limit, **Then** the result is retryable with a not-before time, no publish request is sent, and the attempt summary records the reported usage.
3. **Given** the quota check fails or cannot be parsed, **Then** the step does not block publishing on that alone; Docket's own counter remains the guard, and the summary records that the quota was unknown.
4. **Given** a wait for quota outlasts the container's 24-hour life, **Then** the expired container is recreated per US4 scenario 5, since no publish request was sent.

---

### User Story 6 - Unknown, rate-limited and rejected outcomes behave safely (Priority: P1)

If a request that can make a post public (Facebook feed or photo post, Instagram publish) times out, drops mid-response, gets a server error, or returns a reply Docket cannot understand, the target is `ambiguous` and never retried automatically. If Meta says the app or account is rate limited, the target waits and retries. If Meta rejects the content or the permissions, the target fails with the reason.

**Why this priority**: A missed post beats a duplicate post (constitution V). This is the property most likely to do visible harm if wrong.

**Independent Test**: For each may-publish step (Facebook feed, Facebook photo, Instagram publish) and each non-publishing step (photo upload, container create, status check, quota check), stub: timeout after send, connection reset, 5xx, 2xx unparseable, 2xx missing the id, a rate-limit error, a validation/permission error, error code 190, and a pre-send connection failure. Assert the mapping below.

**Acceptance Scenarios**:

1. **Given** a may-publish request was sent and no usable reply came back (timeout, abort, reset), **Then** `ambiguous`.
2. **Given** a may-publish request gets a 2xx whose body cannot be parsed or has no post/media id, **Then** `ambiguous`.
3. **Given** a may-publish request gets a 5xx, or a Graph error marked as unknown or temporary (R3), **Then** `ambiguous`.
4. **Given** any step gets a Graph error identified as rate limiting (R3), **Then** `retryable_error`, with a not-before time when the platform gives one and the engine's backoff otherwise.
5. **Given** any step gets a validation or permission rejection, **Then** `fatal_error` with the platform's message, secrets removed.
6. **Given** a non-publishing step (unpublished photo upload, container create, status check, quota check) times out, resets or gets a 5xx, **Then** `retryable_error`; nothing is ambiguous because nothing could have been published.
7. **Given** a connection failure known to be before sending (DNS failure, connection refused), **Then** `retryable_error` on any step.

---

### User Story 7 - Revoked tokens are flagged and can be fixed (Priority: P1)

When Meta says an account's token is no longer valid (password changed, Page role removed, app removed), Docket marks the account "needs reconnection" in the existing prominent banner and stops publishing to it. The owner reconnects through the same login flow or by pasting a token, and the account becomes active again.

**Why this priority**: Page tokens never expire but can be invalidated at any time; without this, posts fail silently forever.

**Independent Test**: Stub a publish step to return Graph error code 190. Assert the account becomes `needs_reauth` with a readable reason, the target stops with the existing "Reconnect … to publish" message, no refresh is attempted, and other due targets for that account are not sent. Then reconnect via the chooser and assert the account is `active` with the new token.

**Acceptance Scenarios**:

1. **Given** any step for a Facebook or Instagram account is answered with error code 190, **Then** the account becomes `needs_reauth` (G7), the target fails with "Reconnect … to publish" without an automatic retry, and the result is never `ambiguous`.
2. **Given** an account in `needs_reauth`, **When** the owner completes the connect flow and chooses that same Page or Instagram account, **Then** it is updated in place and becomes `active`.
3. **Given** a reconnect in which the person no longer manages the Page, **Then** that account is not offered, stays `needs_reauth`, and the screen says the Page was not found for this login.
4. **Given** a failed target from a revoked token, **When** the account is reconnected, **Then** the target can be retried with the existing retry action.

---

### User Story 8 - Paste a token from Graph API Explorer instead of logging in (Priority: P2)

When the OAuth redirect cannot work (for example on a local machine), an owner or admin generates a user token in Meta's Graph API Explorer with the required permissions and pastes it into the accounts screen. Docket exchanges it server-side for a long-lived user token and shows the same chooser of Pages and Instagram accounts. The same paste can reconnect an account that needs it.

**Why this priority**: It is the documented fallback for local development and for when redirects misbehave, but the main flow works without it.

**Independent Test**: Stub the long-lived exchange and the Pages listing. Paste a token and assert the chooser lists the Pages and Instagram accounts, that the pasted token was sent only in the server-side exchange, and that it is not stored, echoed or logged.

**Acceptance Scenarios**:

1. **Given** a valid pasted user token, **When** submitted, **Then** it is exchanged server-side for a long-lived user token and the same chooser as US1 is shown.
2. **Given** a token that cannot be exchanged (expired, wrong app, malformed), **Then** a clear message is shown, the field is cleared, and nothing changes.
3. **Given** a token that yields no Pages, **Then** the message says no Pages were found and lists the permissions the token needs.
4. **Given** an editor, **Then** the paste form is not shown and a direct request is refused on the server.
5. **Given** a pasted token, **Then** neither it nor the long-lived user token is stored after the Page tokens are derived; only the Page tokens of chosen accounts are kept, encrypted.

---

### User Story 9 - Live validation in the composer (Priority: P2)

While composing, an editor sees Instagram's rules (an image is required, at most 10, accepted shapes, alt text up to 1,000 characters, caption limit) and Facebook's rules, with clear errors before scheduling and notes where an image will be adapted.

**Why this priority**: It stops posts that would fail at publish time, but the publish gates already enforce the same checks.

**Independent Test**: Call each provider's validation directly with crafted content, then the composer's existing check endpoint with Facebook and Instagram targets, and compare the issues returned.

**Acceptance Scenarios**:

1. **Given** an Instagram target with no image, **Then** `media_required` is a blocking error. **Given** 11 images, **Then** `too_many_images` with limit 10.
2. **Given** an Instagram image whose aspect ratio is outside 4:5 to 1.91:1, **Then** `aspect_ratio_out_of_range` is a blocking error naming that image. **Given** a PNG or an image over 8 MB or wider than 1,440 px, **Then** an informational note says it will be converted, compressed or downscaled.
3. **Given** Instagram alt text over 1,000 characters, **Then** `alt_text_too_long` is a blocking error.
4. **Given** an Instagram carousel whose images have different aspect ratios, **Then** an informational note says Instagram crops every item to the first image's shape.
5. **Given** a Facebook text-only post, **Then** no media error is raised. **Given** more images than the Facebook maximum (R2), **Then** `too_many_images`.
6. **Given** text over a platform's caption or post limit (R1), **Then** `text_too_long` with the count and limit.

---

### User Story 10 - Owner can set up the Meta app from written steps (Priority: P2)

The owner (or anyone deploying Docket themselves) follows `docs/meta-setup.md` to create the Meta app, add Facebook Login for Business, request the permissions, give every account a role, stay on Standard Access without App Review, and register the redirect addresses for local and production use.

**Why this priority**: Without it nobody can connect a real account, but it is documentation, not code.

**Independent Test**: Review the document against FR-036 and FR-037 and confirm every env var it names exists in `.env.example` and the start-up validation.

**Acceptance Scenarios**:

1. **Given** a new deployer with a Facebook account, **When** they follow `docs/meta-setup.md` step by step, **Then** they end with an app id, app secret and the redirect address registered, without needing App Review.
2. **Given** local development, **Then** the document gives the localhost redirect option (marked unverified, U2, with what to try), the hosts-file + local certificate alternative, and the token-paste fallback.

---

### Edge Cases

- **Person deselects Pages or permissions in the login dialog**: only what was granted is offered. If no Pages come back, the chooser says so and lists the needed permissions. A missing publishing permission surfaces as a clear `fatal_error` at publish, not a silent failure.
- **Same Page connected in two projects**: allowed; each project has its own account row and encrypted token (existing per-project rules).
- **One Page connected as Facebook and its Instagram account as Instagram**: both rows hold the same Page token. An invalidation is detected per account, on that account's next call.
- **Invalidated token on an idle account**: Page tokens have no expiry, so there is no scheduled refresh; an invalidation is discovered on the next publish attempt. Accepted and recorded.
- **Pages managed only through Business Manager** may not be listed without extra permissions; `docs/meta-setup.md` says so. Docket does not request extra permissions in this entry.
- **Facebook text with several URLs**: only the first is sent as the link; the full text is unchanged in the message.
- **Facebook post with images and a URL**: images take precedence; no link is sent, the URL stays in the text.
- **Instagram text over the caption limit, or empty text with images**: over the limit is blocked; empty caption with an image is allowed.
- **Exactly 10 Instagram images / exactly 8 MB / exactly 1,000-character alt text / aspect exactly 4:5 or 1.91:1**: allowed. One more is an error (or adapted, for bytes).
- **Media unreachable by Meta** (private bucket, localhost): Meta's fetch failure on container create or photo upload is a `fatal_error` whose message says the media must be at a public URL. The docs say a real public bucket is needed in every environment (existing 003 rule).
- **Image deleted or variant missing at publish time**: existing 003 rules (regenerate or fail before any provider call).
- **Killed tick mid-step**: existing lease recovery — a non-publishing step retries, a may-publish step becomes `ambiguous`.
- **Manual retry of a failed Instagram target**: step state is cleared (existing behaviour), so fresh containers are created.
- **Graph version env set to an unsupported value**: start-up validation rejects a value not shaped like `vNN.N`; a version Meta no longer serves surfaces as a clear error on the first call.
- **Tokens in platform error bodies or URLs**: removed from every stored error, summary and log; tokens are sent in a way that keeps them out of logged URLs where the platform allows it.
- **Two tabs start the connect flow**: each has its own state; each completes or expires independently.

## Requirements *(mandatory)*

### Functional Requirements

**Scope and registration**

- **FR-001**: The Facebook and Instagram providers MUST each live in their own provider folder and be enabled by one registry entry each. Shared Meta code (connect flow helpers, Graph client, error mapping) MUST live in one shared Meta module under the providers area that is not itself registered as a provider. None of it may import server code (existing lint rule).
- **FR-002**: The feature MUST NOT add Facebook-, Instagram- or Meta-specific code to the scheduler, composer, services, routes or schema. Every change outside the provider folders and the shared Meta module MUST be a generic framework fix (G5–G7 or any newly found gap), MUST work for any provider, and MUST be recorded in `docs/decisions.md` with what, why and how to reverse it.
- **FR-003**: A test MUST show that the unchanged engine publishes a Facebook target and an Instagram target end to end (claim → steps → published) with only HTTP stubbed.
- **FR-004**: Threads, video, reels, stories, the generator and the public API MUST NOT be implemented. The shared Meta module MUST be parameterised (app id and secret, hosts, Graph version, token-exchange details) so the Threads entry can reuse it without copying code.

**Configuration**

- **FR-005**: Meta settings MUST come from the environment: app id, app secret, Graph API version (`META_GRAPH_VERSION`, default `v26.0`) and an optional login configuration id (R4). App id and secret MUST be all-or-none; without them the Meta connect actions are hidden and Facebook/Instagram are reported as "not configured". All MUST be documented in `.env.example` and validated at start-up, and the secret MUST never be logged or sent to the browser.
- **FR-006**: The callback address MUST be one fixed path per deployment, derived from the app's existing configured public URL, and shown (copyable) in `docs/meta-setup.md` and on the accounts screen when Meta is not yet configured.

**Shared Meta connect module (G5, G6)**

- **FR-007**: Starting the connect flow MUST create a state value that is unguessable, single-use, bound to the initiating user's session and the project, and expires after 10 minutes. Only owners and admins may start it (server-enforced).
- **FR-008**: The callback MUST refuse, without any code exchange, a missing, unknown, expired, reused or foreign-session state, and MUST re-check that the user is still an owner or admin of the project. A platform error response MUST return the person to the accounts screen with a plain message.
- **FR-009**: The code MUST be exchanged on the server using the app secret, and the resulting user token exchanged for a long-lived user token. The Pages listing MUST be fetched with the long-lived user token and MUST include each Page's id, name, Page token and linked Instagram professional account.
- **FR-010**: Candidates (Pages and linked Instagram accounts) and their tokens MUST be held only on the server, encrypted, until the person chooses or the state expires, whichever comes first. Unchosen candidates' tokens MUST be discarded.
- **FR-011**: The chooser MUST list each Page with its linked Instagram account (if any), mark already-connected accounts, and save only the ticked ones through the existing connected-account path, updating existing rows in place by provider and external id.
- **FR-012**: **Decision**: the long-lived user token MUST NOT be stored after Page tokens are derived; each account stores only its non-expiring Page token, encrypted, with no expiry date. Why: Page tokens are what every publish call uses, and a stored user token would widen what a database-plus-key leak exposes. Reconnecting means logging in again. Recorded in `docs/decisions.md`.
- **FR-013**: The accounts screen MUST offer a token-paste form (owners and admins only) that exchanges a pasted user token server-side for a long-lived one and then shows the same chooser (FR-011). The pasted token MUST NOT be stored, echoed after submit, or logged.
- **FR-014**: Facebook and Instagram MUST share one connect action on the accounts screen (a shared connect group, G5), and reconnect for a `needs_reauth` account MUST use the same flow or the paste form.

**Graph client and error mapping**

- **FR-015**: All Graph calls MUST go through one client that builds versioned URLs from `META_GRAPH_VERSION`, honours the engine's abort signal, keeps tokens out of URLs and logs where the platform allows, and returns typed outcomes rather than raw responses.
- **FR-016**: The client MUST classify Graph errors into: invalid token (code 190, any subcode) → `needs_reauth`; rate limited (R3) → retryable; unknown/temporary (R3) → retryable on non-publishing steps and `ambiguous` on may-publish steps; validation or permission → fatal. The rate-limit and temporary code lists MUST live in one table in the shared module, covered by tests.
- **FR-017**: A step answered with error code 190 MUST mark the account `needs_reauth` with a readable, secret-free reason (G7) and stop the target without automatic retry; no refresh is attempted, because Page tokens have none.

**Facebook provider**

- **FR-018**: Capabilities MUST declare: text and image post types plus carousel (multi-photo); text-only allowed; media not required; image types, byte limit, maximum images and text limit per R2/R1 (interim values recorded as unverified).
- **FR-019**: A text-only post MUST be one may-publish step: a feed post with the text as the message and, when the text contains an http(s) URL, the first URL as the link.
- **FR-020**: A one-image post MUST be one may-publish step: a photo post with the image's public URL and the text as its caption.
- **FR-021**: A multi-image post MUST upload each image as an unpublished photo in its own non-publishing step (state holds the returned photo ids in order), then make one may-publish feed post that attaches them all, with the text as the message. The docs and decisions MUST say this path is verified with mocks only and unverified in Meta's docs (U1).
- **FR-022**: Facebook's native scheduling MUST NOT be used.
- **FR-023**: On success the result MUST be `done` with the returned post id as the external id and, when known (R5), the post URL.

**Instagram provider**

- **FR-024**: Capabilities MUST declare: image and carousel post types; media required; text-only not allowed; up to 10 images; JPEG only (others converted to JPEG); at most 8 MB per image; aspect ratio 0.8 to 1.91 inclusive; maximum width 1,440 px (wider images are downscaled; narrower ones are left to Meta's scaling); alt text up to 1,000 characters; caption limit per R1; and a default publish limit of 100 per 86,400 seconds.
- **FR-025**: `validate` MUST return the shared capability checks plus an informational note when carousel images have different aspect ratios.
- **FR-026**: `stepFor` MUST be pure and total. The step order MUST be: for a carousel, one non-publishing item-container step per image in order, then one non-publishing carousel-container step; for a single image, one non-publishing container step; then one or more non-publishing status-check steps; then one non-publishing quota-check step; then exactly one may-publish publish step.
- **FR-027**: Container create MUST send the Instagram variant's public URL, the caption (on the single-image or carousel container) and each image's alt text (when non-empty). Step state MUST hold only non-secret data: container ids, media type, status-check count and first-check time, recreation count.
- **FR-028**: Status checks MUST return `continue` with a not-before time while `IN_PROGRESS` (first check about 10 seconds after creation, backing off to at most 5 minutes apart), MUST move on when `FINISHED`, MUST fail on `ERROR`, MUST recreate containers on `EXPIRED` (from the first step, at most twice per publish attempt) because no publish request has been sent, MUST return `ambiguous` on `PUBLISHED`, and MUST fail after 60 minutes of `IN_PROGRESS`. No step may loop, poll in-process or sleep.
- **FR-029**: The quota-check step MUST read the account's content publishing limit; at or over the limit it MUST return `retryable_error` with a not-before time and send nothing else; an unreadable quota MUST NOT block (Docket's own counter still applies).
- **FR-030**: The publish step MUST send exactly one publish request for the ready container. A timeout, reset, 5xx, unknown/temporary error, or a 2xx without a parseable media id MUST be `ambiguous`. A definitive "container expired" or other rejection MUST be `fatal_error`; containers are never recreated automatically after a publish request was sent.
- **FR-031**: On success the result MUST be `done` with the returned media id as the external id and, when known (R5), the post URL.

**Outcomes, secrets and summaries**

- **FR-032**: Every outcome MUST follow the framework table in `docs/adding-a-provider.md` §7 as refined by US6. Every network call MUST honour the abort signal.
- **FR-033**: Attempt summaries MUST record the step, image index, container or photo ids, container status, quota usage when known, HTTP status, Graph error code, subcode and trace id. They MUST NOT record tokens, the app secret, codes from the callback, or full response bodies.
- **FR-034**: Tokens, the app secret and authorization codes MUST NOT appear in the browser, logs, attempt records, step state, error messages, thrown messages or test snapshots. A test MUST assert this for connect, callback, paste and every advance path.

**Tests (mocked HTTP only)**

- **FR-035**: Tests MUST stub HTTP and make no live calls. They MUST cover:
  - connect: start (state and redirect), callback success, every refused-state case, platform error, failed exchanges, chooser save and in-place update, paste success and failure, role refusal;
  - Graph error classification for 190, rate-limit codes, temporary codes, validation and permission errors, and unparseable bodies;
  - Facebook `validate` edges and every advance path: text, text with link, one photo, multi-photo (mocked, U1), retryable, fatal, ambiguous (timeout after send, reset, 5xx, unparseable 2xx), token invalidation;
  - Instagram `validate` edges (no media, 10/11 images, aspect 0.8/1.91 edges, alt 1,000/1,001, non-JPEG, 8 MB) and every advance path: container `IN_PROGRESS` then `FINISHED`, `ERROR`, `EXPIRED` with recreation and its cap, `PUBLISHED` before publish, 60-minute processing cap, carousel, quota reached, quota unreadable, publish success, publish ambiguous (timeout, reset, 5xx, unparseable 2xx), publish rejected as expired, retryable, fatal, token invalidation;
  - the generic framework fixes G5–G7 with a throwaway provider, proving no Meta-specific code is needed in the engine.

**Documentation**

- **FR-036**: `docs/meta-setup.md` MUST give exact manual dashboard steps: creating the app, adding the Facebook Login for Business use case (including the login configuration if R4 requires it), adding the five permissions, giving every Facebook account an app role (and checking that each Page's linked Instagram professional account is reachable), staying on Standard Access without App Review, registering the valid OAuth redirect addresses for local and production, where to find the app id and secret, and which env vars to set. It MUST leave a clearly marked place for the Threads entry to add its setup.
- **FR-037**: `docs/meta-setup.md` MUST document local options: the localhost redirect in development mode (marked unverified, U2, with how to test it), the hosts-file hostname + local certificate alternative, and the Graph API Explorer token-paste fallback with the permissions to tick.
- **FR-038**: The README MUST gain a "Connecting Facebook Pages and Instagram" section: what is stored, what "needs reconnection" means, the public-bucket requirement for Instagram, and how to remove Docket's access in Facebook settings.
- **FR-039**: `docs/adding-a-provider.md` MUST document the OAuth connect pattern, connect groups, candidate lists, the paste fallback, the credentials-invalid flag (G5–G7), and an Instagram worked example of a polling step machine with `continue` + not-before.
- **FR-040**: `docs/decisions.md` MUST record FR-012, each framework fix (G5–G7 and any other), the interim values for R1–R6, the first-URL-as-link rule, the polling cadence and 60-minute cap, the recreation rule and cap, and the "verified with mocks only" status of live Facebook and Instagram publishing, U1 and U2.

### Key Entities *(include if feature involves data)*

- **Facebook account**: an existing social account row with provider key `facebook`. External id = Page id. Display name = Page name. Credentials = the Page token (encrypted). No expiry. Status `active` / `needs_reauth`.
- **Instagram account**: an existing social account row with provider key `instagram`. External id = Instagram professional account id. Display name = the Instagram account's name or username as returned by the listing. Settings = the linked Page id (non-secret). Credentials = the linked Page's token (encrypted). No expiry.
- **Connect state**: short-lived, single-use, bound to user, session and project; holds the encrypted candidate list after the callback until chosen or expired.
- **Candidate account**: a Page or a linked Instagram account offered in the chooser, with its provider key, external id, display name, whether it is already connected, and (server-side only) its token.
- **Publish step state** (plain, non-secret): Facebook — uploaded unpublished photo ids in order; Instagram — container ids, media type, status-check timing, recreation count.
- **Published reference**: Facebook post id or Instagram media id (external id) and the URL when known, on the post target.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An owner with a configured Meta app can connect a Page and its linked Instagram account in under 2 minutes, with one login and one confirmation.
- **SC-002**: 100% of forged, expired, reused or foreign-session callbacks are refused with no token exchange and no account change.
- **SC-003**: With platform responses simulated, 100% of the specified outcomes (success, retryable, fatal, ambiguous, token invalidation, container `IN_PROGRESS`/`ERROR`/`EXPIRED`/`PUBLISHED`) produce the specified target and account status, and zero ambiguous outcomes are retried automatically.
- **SC-004**: A Facebook text or single-photo post publishes in the first tick after it is due; an N-photo post within N + 1 ticks. An Instagram single-image post whose container is ready at the first check publishes within 4 ticks; an N-image carousel within N + 4 ticks.
- **SC-005**: No tick spends time waiting for a container: every step makes at most one platform request, and Instagram's processing wait is spread over ticks.
- **SC-006**: Docket never sends a 101st Instagram publish for one account within 24 hours, in a simulated run of 150 queued targets.
- **SC-007**: Zero occurrences of any token, app secret or authorization code in the database (outside encrypted credential storage), logs, attempt records, step state, pages or responses across the whole test suite.
- **SC-008**: Outside the two provider folders and the shared Meta module, the diff contains only the two registry lines, generic framework fixes recorded in `docs/decisions.md`, tests and docs.
- **SC-009**: A new deployer can complete `docs/meta-setup.md` and get an app id, secret and registered redirect address without contacting anyone or requesting App Review.
- **SC-010**: Lint, typecheck and the full test suite pass. Live Facebook and Instagram publishing, the multi-photo path (U1) and the localhost redirect (U2) are reported as "verified with mocks only" / "unverified" (constitution II), since no real Meta credentials are available to the build.

## Assumptions

- No live Meta app or accounts are available to the build. Everything is verified with mocks only; the owner checks live connect and publishing after merge, including the localhost redirect (U2) and multi-photo posts (U1).
- One Meta app serves every project (brief). Every account owner has a role on the app, so Standard Access is enough and no App Review is needed.
- Instagram calls use the linked Page's token obtained through Facebook Login for Business (decision 3); Instagram Login is not used.
- The five permissions in the brief and research are requested; `ads_management` / `ads_read` are not requested in this entry and the docs explain when they would be needed.
- No new runtime dependency is needed; HTTP uses the platform `fetch`. If one turns out to be needed it is marked `NEEDS DEPENDENCY`.
- The engine's existing claim, lease recovery, backoff, attempt cap, own publish-limit counter, `needs_reauth` banner, ambiguous resolution UI and retry action are reused unchanged, except for the generic fixes G5–G7.
- Media is served from the configured public bucket (003); Instagram and Facebook fetch it by URL, so offline MinIO cannot be used with real Meta accounts.
- Docket's tick runs about once a minute, so status checks scheduled sooner simply happen on the next tick. Status checks do not count against the publishing limit.
- Display names come from the Pages listing. Profile pictures, insights, comments, Page roles management and native scheduling are out of scope.
- Content is not edited while a target is mid-publish (existing engine behaviour), so container state from earlier steps stays valid.
