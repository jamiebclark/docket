# Feature Specification: Bluesky provider

**Feature Branch**: `004-bluesky-provider`

**Created**: 2026-10-03

**Status**: Draft

**Input**: User description: "Add the Bluesky provider as the first real provider, proving the framework from entry 2. Before specifying, read docs/build-prompt.md ('The provider framework', 'Platform notes' -> Bluesky, 'Media', 'Quality bar'), docs/research/bluesky.md (authoritative facts: 300 graphemes + 3000 bytes, 4 images, 2,000,000-byte blobs, required alt, facets via @atproto/api RichText with empty-DID mentions filtered, createSession rate limits, refresh token rotation), docs/adding-a-provider.md, .specify/memory/constitution.md and docs/decisions.md. Must deliver: src/providers/bluesky/ registered in the registry only (no scheduler/composer/schema changes — if any are needed, that is a framework defect to fix generically and record in decisions.md); credential connect form (handle, app password, optional PDS URL defaulting to https://bsky.social) that creates a session and stores encrypted accessJwt/refreshJwt/did/handle (never the app password unless required for re-login — decide and record); session refresh serialised per account with rotation persisted, needs_reauth on failure; capabilities and validate(); advance() step machine: upload each image blob (using the Bluesky variant from entry 3's pipeline), then createRecord with text, facets and images embed with alt text; external id = at:// URI, URL = bsky.app link; timeouts or unparseable responses on createRecord => ambiguous; 429 => retryable with backoff respecting rate-limit headers. Tests with mocked HTTP only (no live calls): grapheme counting incl. emoji/ZWJ, facet byte offsets incl. multibyte text, image count/size validation, each advance path (success, retryable, fatal, ambiguous, refresh-then-retry). Update docs (README account setup for Bluesky, adding-a-provider worked example). Must NOT do: Meta providers (meta-facebook-instagram, meta-threads), generator."

## Context and sources

- Product behaviour: `docs/build-prompt.md` ("The provider framework", "Platform notes → Bluesky", "Media", "Quality bar").
- Platform facts: `docs/research/bluesky.md` (checked 2026-10-02). Where it disagrees with the brief, the research wins.
- Framework contract: `docs/adding-a-provider.md` and `src/providers/types.ts`; engine rules in `docs/decisions.md` (002, 003).

**Brief vs research disagreements (research wins):**

| Topic | Brief says | Research says (used here) |
|---|---|---|
| Text limit | 300 graphemes | 300 graphemes **and** 3,000 UTF-8 bytes; both enforced |
| Image size | 2,000,000 bytes | Same; docs.bsky.app still says 1,000,000, the lexicon (2,000,000) wins |
| Alt text | "passed to every platform that supports it" | Alt is a **required** field on every image (may be empty) |
| Mentions | "build facets" | Mentions whose handle cannot be resolved come back with an empty identity and **must be dropped** before posting |

**NEEDS RESEARCH** (not in `docs/research/`; to be settled during planning from the installed `@atproto/api` package's own types and source in `node_modules`, never from memory):

- R1: the response headers Bluesky uses to say when a rate limit resets, and their units.
- R2: how the platform signals "access session expired" as opposed to "credentials invalid", for both a publish call and a session refresh.
- R3: how the installed client (0.22.x; research describes 0.23.0) exposes session creation, refresh and the rich-text helper, and whether it can be pointed at a test HTTP stub (so tests mock HTTP rather than the library).

## Framework gaps this feature exposes

The brief says adding a provider must be "one folder plus one registry line", and nothing in the scheduler, composer or schema may change. Bluesky is the first provider whose connect flow and token lifecycle are real. Reading the current framework shows three gaps. Each one is a **framework defect**. It is fixed generically, for every provider, recorded in `docs/decisions.md`, and the mock provider keeps working unchanged or is updated to use the generic path. None of them may be fixed with Bluesky-specific code outside `src/providers/bluesky/`.

- **G1: no generic credential connect.** A `credentials` connect strategy declares fields, but nothing turns submitted field values into a connected account. Today only a mock-specific form and service exist. The framework needs a provider-supplied way to exchange submitted fields for an account identity, encrypted credentials, an expiry and non-secret settings. It also needs one generic connect form and one generic reconnect action, both driven by the declared fields. Fields need to be markable as optional, with a default value and help text.
- **G2: credentials cannot be renewed during a publish.** A publish step gets credentials but cannot save new ones. Bluesky rotates refresh tokens on every refresh. A refresh inside a publish step whose result is thrown away therefore locks the account out at the next refresh. The framework needs a generic way to refresh during publishing. That refresh must be serialised with the scheduled refresh section for the same account, must persist the rotated credentials before they are used, and must never be counted as "the request that may have published".
- **G3: refresh failures are all-or-nothing.** Decision 002 says any refresh failure marks the account `needs_reauth`. This spec keeps that rule for a **definitive** refusal: the platform rejects the refresh credential. For refreshes started while publishing (G2), a **transient** failure (network error, timeout, 5xx, 429) is treated as a retryable error on the target, and the account stays active. If this changes the shared refresh result type, the change is generic and recorded.

No database schema change is expected. If planning finds one is unavoidable, that is a fourth framework defect, and it must be justified and recorded the same way.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect a Bluesky account (Priority: P1)

A project owner or admin opens the project's accounts screen, chooses Bluesky and fills in their handle and an app password. They can also give a custom server (PDS) address, which defaults to `https://bsky.social`. Docket signs in once and stores the resulting session encrypted. The account then appears as "Connected" under its handle. The app password itself is never stored.

**Why this priority**: Nothing else in this feature works without a connected account. It also proves the generic credential-connect path (G1) that later providers reuse.

**Independent Test**: Stub the sign-in endpoint and submit the form. Confirm that a Bluesky account row exists for the project with the platform account id (DID) as its external id, the handle as its display name and the PDS address as a setting. Confirm that the stored credentials decrypt to the session tokens, DID and handle, and that the app password appears nowhere in the database, logs or response.

**Acceptance Scenarios**:

1. **Given** an owner on the accounts screen, **When** they submit a valid handle and app password with no PDS address, **Then** Docket signs in against `https://bsky.social`, the account appears as Connected under the handle the platform returned, and its credentials are stored encrypted.
2. **Given** a custom PDS address, **When** the form is submitted, **Then** sign-in and every later call for that account go to that address.
3. **Given** a wrong handle or app password, **When** the form is submitted, **Then** no account is created and the form says the handle or app password was not accepted. The password field is cleared and never shown back.
4. **Given** the platform's sign-in rate limit has been hit, **When** the form is submitted, **Then** no account is created and the form says to try again later, giving the time when the platform states one.
5. **Given** an editor (not owner or admin), **When** they view the accounts screen, **Then** they cannot connect a Bluesky account, and a direct server request to connect is refused.
6. **Given** the same Bluesky account (same DID) is connected again in the same project, **When** sign-in succeeds, **Then** the existing account is updated in place, reactivated and its last error cleared, rather than duplicated.

---

### User Story 2 - Publish a text post with links, mentions and hashtags (Priority: P1)

An editor writes a post, targets the Bluesky account and schedules it, queues it or publishes it now. The unchanged scheduler publishes it. Links, @mentions and #hashtags are clickable on Bluesky, and the post shows as Published with a link that opens it on bsky.app.

**Why this priority**: This is the main value of the feature, and the simplest end-to-end proof that a real provider plugs into the existing engine.

**Independent Test**: Use the real scheduler tick against a test database with all Bluesky HTTP stubbed. Schedule a post with multibyte text, a link, a mention and a hashtag. Run a tick. Assert that the request sent carries the exact text, facets with correct UTF-8 byte ranges and a creation timestamp. Assert that the target is `published` with an `at://` external id and a `https://bsky.app/profile/<handle>/post/<rkey>` URL.

**Acceptance Scenarios**:

1. **Given** a due text-only target, **When** the tick advances it, **Then** one post-creation request is sent, and the target becomes published with the returned `at://` URI as its external id and the bsky.app URL as its link.
2. **Given** text containing emoji, accented letters or other multibyte characters before or between a link, a mention and a hashtag, **When** the post is published, **Then** each facet's byte range covers exactly that link, mention or hashtag in the UTF-8 encoding of the text.
3. **Given** a mention whose handle does not resolve, **When** the post is published, **Then** the mention is sent as plain text with no mention facet, and the post still publishes.
4. **Given** the mention lookup is slow or fails, **When** the post is published, **Then** the lookup failure never makes the target `ambiguous`, because the lookup is not the request that publishes.

---

### User Story 3 - Publish a post with images and alt text (Priority: P1)

An editor attaches up to four images with alt text and targets Bluesky. The composer shows that oversized or wrong-format images will be adapted. At publish time each image is uploaded, then the post is created with the images in order, each carrying its alt text.

**Why this priority**: The scope is text and images. Image posts exercise the multi-step publish path and entry 3's media variants.

**Independent Test**: Stub the image-upload and post-creation endpoints. Publish a post with three images, one of them larger than 2,000,000 bytes at source. Assert that each upload sent a file of at most 2,000,000 bytes from the Bluesky variant, that the post request lists three images in order with their alt text (empty string where none was given) and aspect ratios, and that the target is published.

**Acceptance Scenarios**:

1. **Given** a target with N images (1 ≤ N ≤ 4), **When** the scheduler advances it, **Then** each image is uploaded in its own non-publishing step, and the next tick sends one post-creation request that embeds all N uploaded images in the original order.
2. **Given** an image with alt text, **When** it is published, **Then** its alt text is sent unchanged. **Given** an image without alt text, **Then** an empty alt is sent, and the composer has already shown the existing "no alt text" warning.
3. **Given** a source image over 2,000,000 bytes or in a format Bluesky does not accept, **When** the post is composed, **Then** the composer shows the adaptation note, and the published upload uses the Bluesky variant from the media pipeline, never the original.
4. **Given** an image upload fails transiently (timeout, connection error, 5xx, 429), **When** the step is retried, **Then** only that image is retried, already-uploaded images are not uploaded again, and nothing is reported as ambiguous.
5. **Given** an upload is rejected outright (for example the file is refused as too large), **Then** the target fails with a clear message and no post is created.

---

### User Story 4 - Live validation in the composer (Priority: P2)

While composing, an editor sees the Bluesky count in graphemes (user-perceived characters), a clear error past 300 graphemes or 3,000 bytes, and errors for more than four images or an image that cannot be made to fit.

**Why this priority**: It stops posts that would fail at publish time, but publishing (P1) works without it as long as the gates still run.

**Independent Test**: Call the provider's validation directly with crafted content, then call the composer's existing check endpoint with a Bluesky target, and compare the issues returned.

**Acceptance Scenarios**:

1. **Given** 300 graphemes made of multi-code-point emoji (for example family ZWJ sequences, skin-tone modifiers, flags), **When** validated, **Then** no length error is raised. 301 graphemes raise `text_too_long` with count 301 and limit 300.
2. **Given** text of at most 300 graphemes that exceeds 3,000 UTF-8 bytes, **When** validated, **Then** a blocking error is raised saying the byte limit is exceeded, with the byte count and the 3,000 limit.
3. **Given** five images, **When** validated, **Then** `too_many_images` is raised with limit 4.
4. **Given** an image that no variant can bring within the limits, **When** validated, **Then** a blocking media error names that image.
5. **Given** a text-only post, **When** validated, **Then** no media error is raised. Text-only posts are allowed.

---

### User Story 5 - Sessions stay alive, and failures are surfaced (Priority: P2)

Docket keeps each Bluesky account's session alive without signing in again. It refreshes ahead of expiry and when the platform says the access session has expired, and it saves the rotated refresh token every time. When a refresh is definitively refused, the account is flagged "needs reconnection" in the existing prominent banner, and the owner reconnects by entering the app password again.

**Why this priority**: Without it, every account stops publishing within hours (the access session lasts about 120 minutes) or within 90 days (the refresh session). It is P2 only because a freshly connected account can publish without it.

**Independent Test**: Use stubbed HTTP. (a) Make a publish attempt whose post-creation call returns "expired session". Assert that a refresh happens, the rotated tokens are persisted, and the retry publishes once. (b) Run two refreshes for one account concurrently. Assert that only one refresh request reaches the platform and both callers end up with the same persisted tokens. (c) Make the refresh request get refused. Assert that the account is `needs_reauth` with a readable reason and that no token is in any log or attempt record.

**Acceptance Scenarios**:

1. **Given** an account whose access session has expired, **When** a target is due, **Then** the session is refreshed before or in response to the platform's expiry rejection, the rotated credentials are persisted, and the target is retried without risking a duplicate.
2. **Given** the scheduled refresh section and a publish step both want to refresh the same account at the same time, **Then** only one refresh request is made, and the other caller uses its result.
3. **Given** the platform refuses the refresh credential, **Then** the account becomes `needs_reauth`, its due targets stop with "Reconnect … to publish" (existing behaviour), and the accounts screen offers Reconnect.
4. **Given** a refresh started while publishing hits a transient failure, **Then** the target gets a retryable error with backoff, and the account stays active.
5. **Given** an account in `needs_reauth`, **When** the owner reconnects with the correct app password for the **same** Bluesky account, **Then** it becomes active again with fresh credentials. **When** they enter credentials for a different Bluesky account (different DID), **Then** the reconnect is refused with a clear message.
6. **Given** an account that publishes rarely, **When** its refresh session nears expiry, **Then** the scheduled refresh section renews it, so an idle account does not silently lapse after 90 days.

---

### User Story 6 - Unknown and rate-limited outcomes behave safely (Priority: P1)

If the request that creates the post times out, the connection drops mid-response, or the reply cannot be understood, the target is marked `ambiguous` and never retried automatically. If Bluesky says "too many requests", the target waits until the time the platform gives and then retries.

**Why this priority**: The constitution says a missed post beats a duplicate post. This is the property most likely to cause visible harm if it is wrong.

**Independent Test**: Stub the post-creation call to (a) hang past the provider timeout, (b) reset mid-response, (c) return 2xx with an unparseable or incomplete body, (d) return 429 with rate-limit headers, (e) return 400 with a validation error, (f) return 5xx. Assert that (a)–(c) and (f) end `ambiguous`, (d) is retryable with a not-before time matching the headers, and (e) is fatal.

**Acceptance Scenarios**:

1. **Given** the post-creation request was sent and no usable reply arrived (timeout, reset, abort), **Then** the target is `ambiguous`, and no further request is made for it.
2. **Given** a 2xx reply without a well-formed `at://…/app.bsky.feed.post/<rkey>` URI, **Then** the target is `ambiguous`.
3. **Given** a 429 on any step, **Then** the result is retryable, and the next attempt is no earlier than the reset time from the rate-limit headers. With no usable header, the engine's normal backoff applies.
4. **Given** a 4xx validation or permission rejection of the post itself, **Then** the target fails (`fatal_error`) with the platform's reason, with secrets removed.
5. **Given** a 5xx on the post-creation request, **Then** the target is `ambiguous`, because the server may have written the record. A 5xx on an image upload is retryable.
6. **Given** a connection failure known to have happened before the post-creation request was sent (DNS failure, connection refused), **Then** the result is retryable.

---

### Edge Cases

- **Handle input**: a leading `@`, surrounding spaces and upper-case letters are normalised. The stored handle is the one the platform returns, not the typed one.
- **PDS address**: it must be an `https://` URL with no credentials, query or fragment. A trailing slash is ignored. Anything else is rejected on the form before any network call.
- **Main password instead of app password**: the form's help text says to use an app password. If the platform answers that an extra sign-in factor is needed, the form says to use an app password instead.
- **Handle changed on Bluesky after connecting**: the account is identified by its DID, so publishing still works. The handle in credentials and display name is updated from the session data on the next refresh. Post URLs use the handle known at publish time.
- **Removing the account** deletes its stored tokens (existing behaviour). Docket does not revoke the app password, and the docs tell the owner to revoke it in Bluesky if wanted.
- **Images deleted, or variant missing, at publish time**: the existing 003 rules apply (regenerate the variant, or fail before any provider call).
- **A fetched image no longer matches its recorded size or type, or exceeds 2,000,000 bytes**: the target fails before upload with a clear message. It is never sent oversized.
- **Uploaded images lost before the post is created** (for example after a long backoff): if the platform rejects the post because a referenced image is unknown, the target fails with a message saying to retry. A manual retry clears step state (existing behaviour) and uploads the images again.
- **Empty text with images**: allowed. Empty text with no images is the existing `empty_post` error.
- **Exactly 300 graphemes / exactly 3,000 bytes / exactly 4 images / exactly 2,000,000 bytes**: allowed. One more is an error.
- **Combining marks, regional-indicator flags, skin-tone modifiers and ZWJ sequences** each count as one grapheme.
- **Two ticks** cannot work the same target (existing claim rules). Two refreshes for one account are serialised (US5).
- **Tokens in platform error bodies**: secrets are removed from every stored error and summary (existing redaction is the backstop, not the mechanism).

## Requirements *(mandatory)*

### Functional Requirements

**Registration and scope**

- **FR-001**: The Bluesky provider MUST live entirely in its own provider folder and be enabled by one registry entry. It MUST NOT import server code (existing lint rule).
- **FR-002**: The feature MUST NOT add Bluesky-specific code to the scheduler, composer, services, UI routes or database schema. Every change outside the provider folder MUST be a generic framework fix (G1–G3 or any newly found gap), MUST work for any provider, and MUST be recorded in `docs/decisions.md` with what, why and how to reverse it.
- **FR-003**: A test MUST show that the unchanged engine publishes a Bluesky target end to end (claim → steps → published) with only HTTP stubbed.

**Connecting (G1)**

- **FR-004**: The provider MUST declare a credential connect form with three fields: handle (required), app password (required, secret) and PDS URL (optional, default `https://bsky.social`, with help text).
- **FR-005**: The accounts screen MUST render any credential-strategy provider's form from its declared fields. It MUST be usable by owners and admins only, enforced on the server. Secret fields MUST be masked, MUST NOT be echoed back after a failed submit, and MUST NOT be autofilled into other fields.
- **FR-006**: Submitting the form MUST make one sign-in request to the PDS. On success it MUST store, encrypted, the access token, refresh token, DID and handle. The external account id MUST be the DID, the display name the handle, and the PDS URL a non-secret account setting.
- **FR-007**: **Decision**: the app password MUST NOT be stored anywhere after the sign-in request. When the refresh session can no longer be renewed, the account goes to `needs_reauth`, and the owner enters the app password again. Why: sign-in is rate-limited (about 30 per 5 minutes and 300 per day per account), refresh sessions last 90 days and are renewed by Docket, and a stored app password would widen what a database-plus-key leak exposes. This decision MUST be recorded in `docs/decisions.md`.
- **FR-008**: Sign-in failures MUST map to clear form messages: rejected credentials, extra sign-in factor needed, rate-limited (with retry time when known), PDS unreachable or not a PDS. None of them may create or modify an account.
- **FR-009**: Reconnect MUST be offered for a Bluesky account in `needs_reauth`, through the same generic form. It MUST update that account in place only if the signed-in DID matches its external id, and MUST refuse otherwise.

**Capabilities and validation**

- **FR-010**: Capabilities MUST declare: text limit 300 counted in graphemes; up to 4 images; at most 2,000,000 bytes per image; accepted types JPEG and PNG, converting others to JPEG; media not required; text-only allowed; post types text, image and carousel. No alt-text length limit is declared, because the research gives none.
- **FR-011**: `validate` MUST return the shared capability checks plus a blocking error when the text exceeds 3,000 UTF-8 bytes, reporting the byte count and limit.
- **FR-012**: Validation MUST judge content as it will be sent, after media adaptation (existing 003 rule). Fixable image mismatches are informational notes. Unfixable ones are blocking errors.

**Publishing step machine**

- **FR-013**: `stepFor` MUST be pure and total. The step order MUST be: one non-publishing preparation step that resolves mentions to identities (skipped when the text has no mentions), then one non-publishing upload step per image in order, then exactly one publishing step that creates the post. Only the last step is marked as may-publish.
- **FR-014**: Step state MUST hold only non-secret data: resolved mention identities, uploaded image references, and the step position. It MUST be valid stored state between ticks.
- **FR-015**: Each upload step MUST fetch the image as prepared for Bluesky by the media pipeline (the variant URL the engine provides), check that it is no more than 2,000,000 bytes and of a declared type, and upload it. On success it returns `continue` with the upload reference added to the state.
- **FR-016**: The publishing step MUST send a single post-creation request containing: the text, a creation timestamp from the engine clock, facets for links, hashtags and resolved mentions with UTF-8 byte offsets computed by the official rich-text helper (with empty-identity mentions removed), and, when images exist, an images embed listing every uploaded image in order with its alt text (empty string when none) and its aspect ratio when dimensions are known.
- **FR-017**: On a well-formed success reply the result MUST be `done`, with external id = the returned `at://` URI and URL = `https://bsky.app/profile/<handle>/post/<rkey>`.
- **FR-018**: Outcome mapping MUST follow the framework table and cover at least:
  - 429 on any step → `retryable_error`, with a not-before time from the platform's rate-limit headers when present (R1).
  - Timeout, abort or reset after the post-creation request was sent → `ambiguous`.
  - 2xx with an unparseable or incomplete body on post creation → `ambiguous`.
  - 5xx on post creation → `ambiguous`.
  - Pre-send connection failure → `retryable_error`.
  - 4xx rejection of the post → `fatal_error`.
  - Timeout or 5xx on an upload or preparation step → `retryable_error`.
  - 4xx rejection of an upload → `fatal_error`.
- **FR-019**: Every network call MUST honour the engine's abort signal. No step may loop, poll or sleep.
- **FR-020**: Attempt summaries MUST record the step, image index and byte size, text grapheme and byte counts, facet counts, HTTP status and platform error name. They MUST NOT record tokens, the app password or full response bodies.

**Sessions (G2, G3)**

- **FR-021**: The stored credential expiry MUST be the refresh session's expiry, as stated by the platform's token, so the existing scheduled refresh section renews each account before its 90-day refresh session lapses. The access session (about 120 minutes) MUST be renewed on demand while publishing.
- **FR-022**: Every refresh MUST be serialised per account across all callers and processes: the scheduled section, publish-time refresh, and any concurrent tick. The rotated refresh token MUST be persisted before the new access token is used. A caller that loses the race MUST use the persisted result, not refresh again.
- **FR-023**: When the post-creation or upload request is rejected because the access session expired (R2), the system MUST refresh (FR-022) and retry the step, without a duplicate being possible. The expiry rejection proves nothing was posted. The refresh itself MUST NOT count as the may-publish request.
- **FR-024**: A definitive refusal of the refresh credential MUST mark the account `needs_reauth` with a readable, secret-free reason. A transient refresh failure during publishing MUST yield a retryable error on the target and leave the account active (G3).
- **FR-025**: The handle stored in credentials and the account's display name MUST be updated when a refresh returns a different handle for the same DID.

**Secrets**

- **FR-026**: Tokens and the app password MUST NOT appear in the browser, logs, attempt records, step state, error messages, test snapshots or thrown messages. A test MUST assert this for the connect, refresh and every advance path.

**Tests (mocked HTTP only)**

- **FR-027**: Tests MUST stub HTTP and make no live calls. They MUST cover:
  - grapheme counting, including emoji, ZWJ sequences, skin tones, flags and combining marks, at the 300/301 edges;
  - the 3,000-byte edge;
  - facet byte offsets in multibyte text for links, hashtags and mentions, and dropping unresolved mentions;
  - image count (4/5) and size (2,000,000/2,000,001) validation;
  - connect success and each connect failure;
  - every advance path: success (text-only and multi-image), retryable (timeout on upload, 5xx on upload, 429 with headers), fatal (4xx on create, 4xx on upload), ambiguous (timeout after send, reset, unparseable 2xx, 5xx on create) and refresh-then-retry;
  - serialised concurrent refresh with rotation persisted;
  - refresh refusal → `needs_reauth`.

**Documentation**

- **FR-028**: The README MUST gain a "Connecting a Bluesky account" section: creating an app password, the PDS field for self-hosted servers, what is and is not stored, what "needs reconnection" means, and how to revoke access.
- **FR-029**: `docs/adding-a-provider.md` MUST gain a Bluesky worked example: the generic connect exchange, publish-time refresh, a multi-step image flow, the outcome mapping, and the dual text limit as a provider-specific check. Any new framework pattern from G1–G3 MUST be documented in its relevant section.
- **FR-030**: `docs/decisions.md` MUST record FR-007, each framework fix (G1–G3 and any other), the accepted image types, the one-image-per-step choice and its latency cost, and the "verified with mocks only" status of live Bluesky publishing.

### Key Entities *(include if feature involves data)*

- **Bluesky account**: an existing social account row with provider key `bluesky`. External id = DID. Display name = handle. Settings = `{ pdsUrl }`. Status `active` / `needs_reauth`. Credential expiry = refresh-session expiry.
- **Bluesky credentials** (encrypted, never leave the server): access token, refresh token, DID, handle. Never the app password.
- **Publish step state** (plain, non-secret): resolved mention identities, uploaded image references in order, and position.
- **Published reference**: the `at://` URI (external id) and the bsky.app URL, stored on the post target.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An owner can connect a Bluesky account from the accounts screen in under 1 minute, given an app password, with a single sign-in to the platform.
- **SC-002**: With platform responses simulated, 100% of the specified publish outcomes (success, retryable, fatal, ambiguous, refresh-then-retry) produce the specified target status, and zero ambiguous outcomes are retried automatically.
- **SC-003**: A text-only post publishes in the first tick after it is due. A post with N images publishes within N + 1 ticks (plus one more if mentions need resolving), with no failures.
- **SC-004**: The composer's Bluesky count matches the platform's grapheme rule for every test string, including emoji and ZWJ sequences. No post that passes Docket's validation is rejected for length, image count or image size in simulated publishing.
- **SC-005**: Every link, mention and hashtag in multibyte test texts gets a facet whose range covers exactly its characters.
- **SC-006**: In a concurrency test, two simultaneous refreshes of one account make exactly one refresh request to the platform, and the persisted refresh token is always the newest one.
- **SC-007**: Zero occurrences of any token or app password in the database (outside the encrypted credential column), logs, attempt records, step state or UI, across the whole test suite.
- **SC-008**: Outside `src/providers/bluesky/`, the diff contains only the registry line, generic framework fixes recorded in `docs/decisions.md`, tests and docs, with no database migration.
- **SC-009**: Lint, typecheck and the full test suite pass. Live Bluesky publishing is reported as "verified with mocks only" (constitution II), since no real credentials are available to the build.

## Assumptions

- No live Bluesky credentials are available to the build. Real publishing is verified with mocks only, and the owner checks it manually after merge.
- The `@atproto/api` package installed in `package.json` (0.22.x) is the client and rich-text helper, and no other runtime dependency is added. If something it needs is missing, the task is marked `NEEDS DEPENDENCY` rather than hand-rolled.
- Accepted upload types are JPEG and PNG, with other types converted to JPEG. The lexicon accepts any `image/*`, so this is a deliberately conservative subset (recorded). Animated images and video are out of scope.
- One image per upload step keeps each step bounded and makes a failed upload retry only that image. The cost is a few extra ticks (about a minute each) before a multi-image post goes out. This is accepted and recorded.
- No default publish limit is declared. The platform's write budget (about 5,000 points an hour, with a post costing 3) is far above personal use, and per-account limits remain available. The sign-in limit only affects connecting, which happens rarely.
- Post language tags, link-preview cards, quote posts, replies and threads are out of scope.
- Display name is the handle. Fetching the profile's display name is out of scope.
- Content is not edited while a target is mid-publish (existing engine behaviour), so step state from earlier steps stays valid for the publishing step.
- The engine's existing backoff, attempt cap, lease recovery and `needs_reauth` banner are reused unchanged, except for the generic fixes G1–G3.
- Meta providers and the generator are not part of this feature.
