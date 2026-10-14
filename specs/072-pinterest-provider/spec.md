# Feature Specification: Pinterest provider

**Feature Branch**: `072-pinterest-provider`

**Created**: 2026-10-14

**Status**: Draft

**Input**: User description: "Add a Pinterest publishing provider so a Pinterest account can be connected to a Docket project and scheduled posts publish as image Pins. Before specifying, read `docs/research/pinterest.md` (authoritative for hosts, endpoints, scopes, token rules, limits, counting and the UNVERIFIED list), `specs/014-x-provider/spec.md` (the model for this spec's shape), `docs/adding-a-provider.md` (contract and generic hooks G1–G28), `src/providers/types.ts`, `src/providers/registry.ts`, `src/providers/tiktok/` (the `posting` G25 and `accountDetails` G26 worked example), `src/providers/x/` (PKCE-less confidential client, ambiguous-on-create), `src/providers/threads/` and `src/providers/meta/` (OAuth connect group and refresh), `src/providers/instagram/` (pull-from-URL media), `docs/limits.md`, `docs/accounts.md`, `docs/feature-map.md`, `docs/decisions.md`, `docs/tiktok-setup.md`, `.specify/memory/constitution.md`, `scripts/generate-icons.mjs`, `src/components/ui/Icon.tsx` and `unraid/`. Must deliver `src/providers/pinterest/` registered with one line in `src/providers/registry.ts`, key `pinterest`, displayName `Pinterest`; OAuth 2.0 authorization-code connect through a new connect group with HTTP Basic token exchange and two env vars `PINTEREST_CLIENT_ID` / `PINTEREST_CLIENT_SECRET`, no PKCE; identity from `GET /v5/user_account`; a rotating refresh token persisted on every refresh; the three-text-slot mismatch resolved (Pinterest wants title, description and link where Docket models one text field); a REQUIRED per-target board choice read live from `GET /v5/boards`; media required, one image, no video, no carousel; one publishing step `create_pin` using the no-verification image pull; honest error mapping with a hard ambiguous-on-create rule; `defaultPublishLimit` of 100 per 60 s with the Trial-access 300/day/app gap documented rather than glossed; account notes that admit Trial pins are invisible to the public; a published setup guide `docs/pinterest-setup.md`; a platform mark; Unraid template fields; docs updates; and tests with mocked HTTP only. Does NOT do video pins, carousel pins, board creation, secret boards, analytics, product/rich pins, ads, Business Access, the `api-sandbox` host, automatic Trial-vs-Standard detection, or any live verification. Any browser-driven or human-owned task must be parked in a final phase of its own."

## Context and sources

- **Platform facts:** `docs/research/pinterest.md` (checked 2026-10-14 against developers.pinterest.com). It is authoritative for hosts, endpoints, scopes, token lifetimes and rotation, limits, error mapping, the access-tier rules and the counting question. Where it and the request disagree, the research wins (constitution I); the disagreements are listed below.
- **Framework contract:** `docs/adding-a-provider.md` and `src/providers/types.ts`; generic hooks G1–G28 in `docs/decisions.md`. The worked examples are **TikTok** (an OAuth connect group with a confidential client, per-target `posting` fields (G25), a live `accountDetails` read (G26), and account notes that tell the truth about an un-audited app), **X** (confidential client with no PKCE on the platform's terms, and the discipline that a create call which may have been sent is `ambiguous`, never retried), **Threads/Meta** (connect group, encrypted credentials, held refresh G11, account notes G13) and **Instagram** (publishing an image by giving the platform a public URL to pull, rather than uploading bytes).
- **Engine facts relied on** (current code): the engine re-validates a target's content on its first step (G15); `needsRefresh` lets the engine renew credentials under a lease before a step; a `retryable_error` carrying `credentialsExpired` makes the engine refresh and retry; a transient refresh failure with `retryAt` parks the refresh lease (G11); the scheduled refresh pass renews accounts whose stored expiry falls inside `TOKEN_REFRESH_WINDOW_HOURS` (default 72); an OAuth group that is not configured is shown on the Accounts screen as "not configured on this server" with a link to its setup guide and no connect action, and a direct start is refused server-side; targets over a publish limit are deferred, not failed; `resolveAmbiguous` is **manual only** and has no provider check; the media library accepts only JPEG, PNG and WebP (`UPLOAD_MIME_TYPES`), so no other image type can ever reach a post; and a ready media item's `url` is a publicly fetchable address — Instagram already publishes by handing that same URL to the platform.
- **Constitution:** the constitution names four platforms and puts "other platforms" out of scope "until a spec says otherwise". **This spec says otherwise for Pinterest only.** The constitution is not amended here, exactly as `014-x-provider` and `026-tiktok-provider` did not amend it.
- **Deployment:** both Compose files pass `.env` through `env_file`, so the two new variables need no Compose change. The Unraid template lists provider variables explicitly (Meta, Threads, X and TikTok are there), so it gains two optional, empty Pinterest fields.

### Request vs research (research wins)

| Topic | Request says | Research says (used here) |
|---|---|---|
| Image types | `image/jpeg`, `image/png`, `image/webp` | Pinterest accepts BMP, JPEG, PNG, TIFF and WebP, but Docket's library accepts only JPEG, PNG and WebP, so **BMP and TIFF can never occur**. The capability lists the three that can, and the setup guide says why — listing types a post cannot carry would be a false promise (FR-012). |
| Image byte ceiling | 20,000,000 | "20 MB on web" comes from the consumer Help Center, **not** the API reference; it is **UNVERIFIED** as an API-enforced ceiling. 20,000,000 is still used, as a Docket-side refusal, and recorded as a Docket choice rather than a platform fact (FR-013, U3). |
| Image dimensions and aspect ratio | No hard range; an informational issue when far from 2:3 | Agreed, and for a stronger reason than the request gives: there are **no official minimum or maximum pixel dimensions**, and Pinterest's own wording ("Pins with an aspect ratio greater than 2:3 might get cut off in people's feeds") describes **feed cropping, not rejection**. A hard range would refuse pins Pinterest would have accepted, so the out-of-range case is a **warning that still publishes** (FR-014). |
| PKCE | None | PKCE is **not documented anywhere** on Pinterest's authentication page (no `code_challenge` parameter). Treated as unsupported; the confidential-client Basic-auth exchange is the only flow used. This is an UNVERIFIED-driven choice, not a preference (U6, FR-005). |
| Redirect URI rules | `https: true`, `publicHost: true` | No official page states an https-only or no-localhost rule (the docs' own example is `https://example.com/`). The conservative requirement is kept, and marked **UNVERIFIED** so a later entry can relax it after a live test rather than a deployer discovering it (U1, FR-007). |
| Publish limit | `{ count: 100, windowSeconds: 60 }` | Confirmed for Pinterest's `org_write` category **on Standard access**. On **Trial** the real cap is **300 pin-creates per day per app, shared across every connected account**, which Docket's per-account limit cannot express. The limit stays `{100, 60}`; the Trial cap is surfaced in the account notes and the setup guide instead of being silently mis-counted (FR-030, FR-031). |
| Pin permalink | Construct `https://www.pinterest.com/pin/<id>/` | **No permalink field exists in the documented Pin schema.** The construction is kept and labelled best-effort, exactly as the X spec labels its post URL. Note the trap: the response's `link` field is the pin's **outbound** click-through URL, not the pin's own page — they must never be confused (U5, FR-027). |
| Error bodies | Map `{code, message}` | The `{code, message}` shape is **community-sourced only**; the official reference shows no body example, and the one official error-code page is scoped to catalog/product-feed validation. **No behaviour may depend on a `code` value**: matching is on HTTP status, and any `message` text is shown as sent, scrubbed (FR-024, U2). |
| Text counting | Simple character counts | Pinterest documents **no** counting or weighting rule, so `code_points` is a Docket choice, not a platform fact, and is marked UNVERIFIED. Limits themselves (title 100, description 800, alt text 500, link 2048) **are** documented `maxLength` values (U4, FR-009). |
| `pins:read` scope | "only if the ambiguity aid needs it — decide and justify" | **Not requested.** The only post-hoc check is `GET /v5/pins`, which the reference itself flags for "known performance issues", and Docket's resolve-ambiguous flow has no provider check to call it from — so the scope would buy nothing and widen the grant. The minimum set `user_accounts:read boards:read pins:write` is used (FR-004). |
| Board listing | `privacy=PUBLIC` | Kept. Secret boards need `boards:read_secret`, which is not requested; `PROTECTED` boards also exist and are likewise excluded. A board a user cannot see in Docket's picker is explained by the picker's own note, not left to guesswork (FR-017). |
| Pin `note` field | — | Exists on the create schema with **no documented length limit**, so it is not used at all. |

### UNVERIFIED in research (covered by mocked tests that tolerate both shapes, reported as "verified with mocks only")

- **U1**: whether Pinterest accepts an `http://localhost` or non-https redirect URI. Docket requires https and a public host.
- **U2**: the error body shape for every status, including 429. Matching is on status only.
- **U3**: whether the API enforces a 20 MB image ceiling; any minimum or maximum pixel dimensions; and whether an out-of-range aspect ratio is rejected or merely cropped in the feed.
- **U4**: how Pinterest counts characters in `title`, `description` and `alt_text`.
- **U5**: the pin permalink form, and the full `media` status enum beyond the `succeeded` value named in the guide (only relevant to the deferred video entry).
- **U6**: whether PKCE is supported at all.
- **U7**: the full `account_type` enum from `GET /v5/user_account` (the example value is `PINNER`). No behaviour branches on it.
- **U8**: whether a pre-2025-09-25 app's legacy 365-day refresh token rotates. Irrelevant in practice — an app registered today gets the continuous, always-rotating 60-day token — but the refresh code must not assume a token it was not handed.
- **U9**: whether any deauthorisation webhook or token-revocation endpoint exists. A revoked token is assumed to surface as a 401 on the next call.
- **U10**: whether the organic Pins API is region-restricted anywhere.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect a Pinterest account (Priority: P1)

An owner or admin of a Docket project opens Accounts, chooses Pinterest, is taken to Pinterest to approve the connection, and comes back to find the Pinterest account listed and ready — with an honest note about what the deployer's app can and cannot do yet.

**Why this priority**: nothing else in the feature is reachable without it, and it is the step most likely to go wrong for reasons outside Docket (a personal rather than business Pinterest account, an app still awaiting Trial approval, a callback URL that does not match). It must either work or explain itself.

**Independent Test**: with the two environment variables set and Pinterest's endpoints mocked, start the connect flow, return through the callback, and confirm the account appears with the right display name, external id and notes; then repeat with the variables unset and confirm Pinterest is shown as not configured with a link to the setup guide and no connect action.

**Acceptance Scenarios**:

1. **Given** a server with `PINTEREST_CLIENT_ID` and `PINTEREST_CLIENT_SECRET` set and an https callback address, **When** an owner starts the Pinterest connect flow and approves it on Pinterest, **Then** the project gains a Pinterest account whose name is the Pinterest business name (or username when there is no business name) and whose card says that pins are visible only to the account owner while the deployer's app is on Trial access.
2. **Given** a server with neither variable set, **When** an owner opens Accounts, **Then** Pinterest is listed as not configured on this server, with a link to the Pinterest setup guide and no connect action, and a hand-crafted request to start the flow is refused server-side.
3. **Given** a server whose public address is `http://localhost:3000`, **When** an owner opens Accounts, **Then** Pinterest is shown as unavailable with the reason that Pinterest needs an https address that is not localhost, and a link to the guide.
4. **Given** a connect flow the user cancels on Pinterest, **When** the callback returns an error, **Then** the Accounts banner says the connection was cancelled in plain words that do not echo anything from the callback's query.

---

### User Story 2 - Schedule a post that publishes as a pin on a chosen board (Priority: P1)

An editor composes a post with one image, picks the Pinterest account as a target, chooses which board the pin goes on, optionally gives it a title and a destination link, and schedules it. At the scheduled time the pin appears on that board.

**Why this priority**: this is the feature. It is also where Pinterest differs most from every provider Docket already has — a pin cannot exist without a board, and the board is a per-pin choice rather than a property of the account.

**Independent Test**: with Pinterest's endpoints mocked, compose a post with one image, select a board, publish it, and assert the single outbound create call carries the board, the image URL, the description, the alt text, the title and the link; then assert the target records the returned pin id and a constructed pin URL.

**Acceptance Scenarios**:

1. **Given** a Pinterest target on a post with one image and some text, **When** the editor opens the target's posting panel, **Then** a required board picker lists the account's public boards by name, read live from Pinterest, and no board is pre-selected.
2. **Given** a Pinterest target with no board chosen, **When** the post is reviewed or approved, **Then** it is refused with an issue against the board field saying a board must be chosen, and the post cannot be scheduled for Pinterest until one is.
3. **Given** a Pinterest target with a board, 400 characters of text, one JPEG with alt text, a title and a link, **When** the scheduled time arrives, **Then exactly one** create request is sent, the pin is recorded as published with Pinterest's pin id, and the target shows a link to the pin.
4. **Given** a post with no media, **When** Pinterest is added as a target, **Then** the requirements summary says Pinterest requires an image and the post cannot be approved for Pinterest.
5. **Given** a post whose text is 900 characters, **When** Pinterest is a target, **Then** the refusal names the text field, the count and the 800 limit.
6. **Given** a Pinterest target whose chosen board was deleted on Pinterest after scheduling, **When** publishing runs, **Then** the attempt fails with a message that names the missing board and tells the user to choose another, and it is not retried.

---

### User Story 3 - Honest outcomes when Pinterest misbehaves (Priority: P2)

When a publish cannot be completed, the person responsible can tell from Docket what happened and what to do, and Docket never creates the same pin twice.

**Why this priority**: Pinterest offers no idempotency key, so the cost of getting this wrong is a duplicate pin on a public brand profile. It is second only because it is exercised by failure rather than by the happy path.

**Independent Test**: drive each mocked failure — 401, 429 with and without a reset header, 400, 403, 404, 5xx before the create request, and a timeout after the create request was sent — and assert the recorded outcome, the retry timing and the message for each.

**Acceptance Scenarios**:

1. **Given** an access token Pinterest rejects with 401, **When** publishing runs, **Then** the attempt is retryable and flags the credentials as expired, the engine refreshes them and retries, and nothing is shown to the user as a failure unless the refresh itself fails.
2. **Given** a 429 carrying a reset header, **When** publishing runs, **Then** the attempt is retryable and the next try is scheduled no earlier than the reset the header gives; **and given** a 429 with no readable reset, the next try uses the engine's own backoff rather than retrying immediately.
3. **Given** a 403 refusal, **When** publishing runs, **Then** the attempt fails without a retry and shows Pinterest's own message text, scrubbed of anything secret.
4. **Given** a request that times out after the create call was sent, **When** publishing runs, **Then** the target is recorded as **ambiguous**, is **never retried automatically**, and tells the person resolving it to check the board on Pinterest before deciding.
5. **Given** a refresh token Pinterest rejects outright, **When** the refresh runs, **Then** the account is flagged as needing to be reconnected, with a message saying so; **and given** a refresh that fails with a server error, the refresh is parked and retried later without flagging the account.

---

### User Story 4 - A deployer stands the integration up from nothing (Priority: P3)

Someone self-hosting Docket reads one page and gets from "no Pinterest at all" to a connected account, knowing what will still be missing afterwards.

**Why this priority**: it blocks every other story in practice but costs nothing in code — and the Pinterest-specific traps (a business account is mandatory, Trial pins are private, `api-sandbox` is a different thing entirely) are invisible from inside Docket.

**Independent Test**: follow `docs/pinterest-setup.md` end to end against a real Pinterest developer account without reading any source file, and confirm every value it asks for exists on the page it says it does.

**Acceptance Scenarios**:

1. **Given** a deployer with only a personal Pinterest account, **When** they read the setup guide, **Then** the first thing it tells them is that a business account is required before an app can be registered at all.
2. **Given** a deployer whose app has Trial access, **When** they read the guide and look at a connected account's card in Docket, **Then** both say that pins published through a Trial app are visible only to the account owner, and what to submit to get Standard access.
3. **Given** a deployer configuring the app, **When** they reach the redirect URI field on Pinterest, **Then** the guide gives the exact callback address to paste and says Pinterest matches it exactly.

---

### Edge Cases

- **The account has no boards at all.** A pin cannot be created without one, so the picker says so plainly and tells the user to create a board on Pinterest; the target cannot be approved.
- **The board list cannot be read** (network failure, expired token, a scope the user declined). The picker shows that boards could not be loaded, keeps any board already chosen and its stored id, and does not silently clear the choice.
- **The board list is still loading.** The picker shows a disabled control; it never shows an empty list as though the account had no boards.
- **The account has more than 250 boards.** The picker shows every board, paging through Pinterest's cursor, not just the first page.
- **A board is renamed on Pinterest** after a post is scheduled. The stored choice is the board id, so publishing still works and the label refreshes on the next read.
- **A board is deleted or made secret** after a post is scheduled: a fatal failure naming the board (FR-021).
- **Text, title, link or alt text over their limits**; **text at exactly the limit** publishes.
- **An image far from a 2:3 aspect ratio**: a warning that Pinterest may crop it in the feed, and it still publishes.
- **An image whose media item is still processing or has failed** in Docket's own pipeline: the existing processing and failed codes apply before any Pinterest call is made.
- **A refresh token that has expired** (60 days with no refresh): the account needs reconnecting, and the message says that re-approving on Pinterest is the fix.
- **The deployer's app is on Trial** and the daily 300-create cap is exhausted by another project's account on the same app: a 429 the provider cannot distinguish from a per-user limit, so it is treated as retryable with the reset header, and the account note explains the shared cap.
- **An unparseable 2xx** from the create call: ambiguous, never retried.
- **The same post targets Pinterest twice** (two Pinterest accounts in one project): each target carries its own board choice independently.

## Requirements *(mandatory)*

### Functional Requirements

**Registration and identity**

- **FR-001**: Docket MUST offer Pinterest as a connectable platform, registered as one provider with the key `pinterest` and the display name `Pinterest`, available to every existing caller (composer, scheduler, generation jobs, public API) without any change to the scheduler, composer or database schema.
- **FR-002**: A connected Pinterest account MUST be identified by the Pinterest account's own id, and MUST be shown with the account's business name when it has one, falling back to its username.
- **FR-003**: A Pinterest account MUST carry no per-account settings of its own: everything that varies between posts is a per-post choice (FR-016), and everything else is read live.

**Connecting**

- **FR-004**: Connecting MUST request only the access Docket uses: reading the account, listing boards, and creating pins. It MUST NOT request permission to create, change or delete boards, to read or write secret pins or boards, or anything to do with ads, catalogs or analytics.
- **FR-005**: Connecting MUST use Pinterest's authorization-code flow with the client credentials held on the server, and MUST NOT depend on PKCE, which Pinterest does not document (U6).
- **FR-006**: The connect flow MUST be bound to the user and session that started it, and the attempt's state MUST be single-use, exactly as every existing OAuth group requires.
- **FR-007**: Pinterest MUST be shown as unavailable, with a reason and a link to the setup guide, when the server's public callback address is not https or is a localhost or bare-IP address (U1).
- **FR-008**: Pinterest MUST be shown as not configured on this server, with a link to the setup guide and no connect action, when either client credential is missing; a direct attempt to start the flow MUST be refused on the server. Neither credential may ever appear in a page, a log, an error message or a test snapshot.

**Text, media and board — what a pin is made of**

- **FR-009**: A post's text MUST become the pin's description, limited to **800** characters, counted by code points (U4). A refusal MUST name the field, the count and the limit.
- **FR-010**: A pin's **title** (at most 100 characters) and **destination link** (at most 2048 characters) MUST be offered as optional per-target fields on the Pinterest target, not as part of the post's shared text. Leaving either empty MUST publish the pin without it.
- **FR-011**: A post MUST have exactly one image to be publishable to Pinterest: Pinterest has no text-only pin, and this entry does not do carousels. A post with no media, or with more than one image, MUST be refused with a message naming the limit.
- **FR-012**: The image types Docket accepts for Pinterest MUST be JPEG, PNG and WebP — the three Docket's own media library can hold. The setup guide MUST record that Pinterest itself also accepts BMP and TIFF, which Docket cannot carry.
- **FR-013**: An image over 20,000,000 bytes MUST be refused before any Pinterest call, and the refusal MUST name the limit (U3).
- **FR-014**: An image whose aspect ratio is far from Pinterest's recommended 2:3 MUST produce a **warning that does not block publishing**, explaining that Pinterest may crop it in the feed. Docket MUST NOT impose a hard minimum or maximum aspect ratio or pixel size for Pinterest (U3).
- **FR-015**: An image's alt text MUST be sent with the pin, limited to 500 characters, with over-length alt text refused and named.
- **FR-016**: Every Pinterest target MUST carry a **required** board choice. A target with no board chosen MUST be refused with an issue against the board field, both when the post is reviewed and again when publishing starts.
- **FR-017**: The board choice MUST be offered as a list of the account's **public** boards, read live from Pinterest each time the panel is opened, showing every board the account has (paging through Pinterest's cursor), by name. Boards that are secret or protected are out of scope and MUST NOT appear.
- **FR-018**: The chosen board's name MUST be shown beside the target's status wherever targets are listed, so a scheduled post says which board it is going to.
- **FR-019**: When the board list cannot be read, the picker MUST say that boards could not be loaded, MUST keep any choice already stored, and MUST NOT clear it or substitute another board. When the list is still being read, the control MUST be disabled rather than shown as empty.
- **FR-020**: When the account genuinely has no boards, the picker MUST say so and tell the user to create one on Pinterest; the target MUST NOT be approvable.
- **FR-021**: A publish whose board no longer exists MUST fail without a retry, with a message naming the board that could not be found and telling the user to choose another.

**Publishing**

- **FR-022**: Publishing a pin MUST take exactly **one** request that may create a pin, sending the board, the image (as a URL for Pinterest to fetch), the description, the alt text, and the title and link when set. No upload step, no polling and no domain or URL-prefix verification is required or permitted (this is the one way Pinterest is simpler than TikTok and Meta).
- **FR-023**: A successful publish MUST record Pinterest's pin id as the post's external id on that platform.
- **FR-024**: Outcomes MUST be decided on the **HTTP status** of Pinterest's response and never on a numeric code inside its body (U2). Where Pinterest supplies a human-readable message, it MUST be shown as sent, scrubbed of anything secret and truncated to the existing limit.
- **FR-025**: A refusal Pinterest states clearly (a bad request, a refusal of permission, or something not found) MUST fail without a retry. A rate-limit response MUST be retried no earlier than the reset Pinterest's headers give, and MUST fall back to Docket's own backoff when no reset is readable. A server error or network failure **before** the creating request is sent MUST be retryable.
- **FR-026**: A timeout, connection reset or unreadable response **after** the creating request was sent MUST be recorded as **ambiguous**, MUST NOT be retried automatically, and MUST tell the person resolving it to look at the board on Pinterest first. Pinterest offers no idempotency key, so this is the only safe outcome (constitution V: a missed post beats a duplicate post).
- **FR-027**: A published pin MUST be linked from Docket using the conventional pin address built from its id, and that link MUST be treated as best-effort: it is not a documented field (U5), and it MUST NOT be confused with the pin's outbound click-through link.

**Credentials over time**

- **FR-028**: Pinterest credentials MUST be stored encrypted, MUST never reach the browser, and MUST be renewed before they expire. Every renewal returns a **new** refresh token, and Docket MUST persist it every single time — losing one renewal's token ends the account's access (60 days after the last successful renewal).
- **FR-029**: A renewal Pinterest refuses outright MUST flag the account as needing to be reconnected, with a message that says re-approving on Pinterest is the fix. A renewal that fails with a server or network error MUST be parked and retried without flagging the account.

**Limits and honesty about access tiers**

- **FR-030**: Pinterest's documented pin-creation rate for a reviewed app — 100 per minute — MUST be Docket's default publish limit for a Pinterest account, with targets over it deferred rather than failed.
- **FR-031**: Docket MUST state, where someone will see it before scheduling anything, that while the deployer's Pinterest app has only Trial access: every pin it publishes is **visible to nobody but the connected account's owner**, and the whole server shares a cap of 300 pin creations per day across every connected Pinterest account. Docket MUST NOT pretend to enforce that shared cap per account, and MUST NOT guess which tier the app is on — there is no endpoint that says.
- **FR-032**: A post that publishes successfully through a Trial app MUST NOT be described anywhere as publicly visible.

**Documentation and the deployer's path**

- **FR-033**: A published setup guide MUST take a deployer from nothing to a connected account, covering: the business-account prerequisite; registering the app and requesting Trial access (reviewed each business day, and refusable for an inaccessible privacy policy or an unclear description); the exact callback address to register and that Pinterest matches it exactly; the two environment variables; the Trial visibility rule and what to submit for Standard access; the Trial rate limits; that Pinterest's separate sandbox host is a different thing Docket never calls; and that this provider has been verified against mocked responses only.
- **FR-034**: The setup guide MUST be published in the documentation navigation alongside the existing platform guides, and Pinterest MUST appear in the existing platform-limits and accounts documentation and in the feature map.
- **FR-035**: Pinterest MUST have its own platform mark wherever other platform marks are shown, and the Unraid template MUST list the two new variables as optional and empty, as it does for every other provider.
- **FR-036**: Every judgement call this entry makes MUST be appended to the decisions log, including the three-slot text mapping, the board-as-per-post-choice decision, the no-hard-aspect-range decision, the ambiguous-on-create rule, the scopes not requested and the Trial-cap gap, each with the next free hook numbers.

**Verification**

- **FR-037**: Every Pinterest behaviour MUST be verified with mocked responses only — no test may make a live Pinterest call — and the documentation MUST say plainly that the provider has not been exercised against the real API. Coverage MUST include: the connect exchange and the account read; a renewal that returns a rotated token, one that is refused, and one that fails transiently; the board read's success, empty, failed, loading and multi-page cases; the board choice's required-ness; every refusal named in FR-009 to FR-021; the single create request's contents; and each outcome in FR-024 to FR-026, including the ambiguous paths.
- **FR-038**: The existing guard tests MUST stay green: the provider registry, the rule that providers never import server code, and the secret scan.

### Key Entities

- **Pinterest account**: a connected Pinterest profile, held as an ordinary social account row — platform key `pinterest`, the Pinterest account id as its external id, no settings of its own, and encrypted credentials (an access token, a rotating refresh token, and both expiries).
- **Board**: a Pinterest-side collection a pin belongs to. Never stored in Docket beyond the id a target has chosen; always read live, by name, for the picker.
- **Target posting values**: the per-target record for a Pinterest post — the chosen board id (required), and the optional pin title and destination link.
- **Pin**: the published result. Docket keeps its id as the external id and a constructed, best-effort link to it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the server configured, an owner can connect a Pinterest account in under two minutes without reading any documentation beyond the setup guide, and without any step that requires looking at Docket's source.
- **SC-002**: 100% of Pinterest targets that reach the scheduled queue have a board chosen — a target without one cannot be approved or scheduled.
- **SC-003**: A scheduled post with one image publishes as a pin on the chosen board carrying its description, alt text, and the title and link when given (verified with mocked responses only).
- **SC-004**: **No automatic retry ever creates a second pin.** Every outcome where the create request may have been received, and no other, is parked for a person to resolve.
- **SC-005**: Every refusal a user sees names the field at fault and the limit or reason, with no raw platform payloads and no credentials.
- **SC-006**: Before scheduling anything, a user can tell from the account's own card whether pins published through this server will be visible to anyone but the account owner.
- **SC-007**: A deployer with only a personal Pinterest account learns that a business account is required from the first section of the setup guide, not from a failed connect attempt.
- **SC-008**: An account with no boards, one with 300 boards, and one whose board list fails to load each produce a distinct, correct and non-destructive state in the board picker.

## Assumptions

- **Every deployer registers their own Pinterest app**, as with Meta, X and TikTok; Docket ships no shared client credentials.
- **Every app registered from now on gets Pinterest's continuous refresh token** (60 days, rotating on every renewal, renewable indefinitely). A legacy 365-day token is not assumed anywhere, and the renewal path must work from whatever Pinterest actually returns (U8).
- **Docket's media URLs are publicly fetchable** by the platform, which is already true: Instagram publishes by handing Pinterest's equivalent of the same URL to Meta. Pinterest imposes no domain verification, so no new storage or domain work is needed.
- **A board is a per-post choice, not an account property.** This is the entry's central design decision: a Pinterest account with many boards is one Docket account, and each scheduled post picks a board, rather than forcing a separate Docket account per board.
- **The post's shared text is the pin's description**, because that is the field a Pinterest reader actually reads; title and link are per-target extras because they have no counterpart in any other provider and would otherwise distort the composer for everyone.
- **Trial access is the normal starting state**, not an error. Docket must be useful and honest while an app is on Trial rather than refusing to connect.
- **Pinterest's own documentation is the only source.** Where it is silent (U1–U10), Docket chooses the conservative behaviour and records the choice, rather than relying on community reports.
- **No new runtime dependency is needed** — the existing HTTP, encryption, validation and image machinery covers everything here.

## What this entry does not do

- **Video pins.** Pinterest's video path is a four-step flow (register, signed upload to a third-party URL, poll for readiness, then create with a required cover image), its maximum file size and frame-rate limits are unverified, its aspect ratios are a discrete set rather than a range, and one of its containers has no counterpart in Docket's video model at all. Pinterest accepts no video in this entry; a later **`pinterest-video`** entry owns it, following `019-instagram-video` and `025-bluesky-video`.
- **Carousel pins.** Pinterest builds a carousel in a single request with an array of images, unlike every other provider Docket has, and the permitted item count is not confirmed by an official source. A later **`pinterest-carousel`** entry owns it. One image per pin here.
- **Creating, renaming or deleting boards from Docket**, and **secret or protected boards**. The permissions for them are not even requested.
- **Pin analytics or metrics ingestion**, product and rich pins, catalogs, ads, ad accounts, posting on behalf of another account, ad-only pins and AI-disclosure labelling.
- **Pinterest's separate sandbox host**, and **any automatic detection of whether the app is on Trial or Standard access** — no endpoint reports it, so the setup guide and the account card state it instead.
- **Enforcing Pinterest's Trial-only shared daily cap.** Docket's publish limits are per account; a cap shared across accounts on one app cannot be expressed, and inventing a server-wide limiter is out of scope here.
- **Any live verification against the real Pinterest API.** This entry ships verified against mocked responses only, and says so in its documentation. Registering a real app and connecting a real account are human-owned tasks, parked in a final phase of their own.
