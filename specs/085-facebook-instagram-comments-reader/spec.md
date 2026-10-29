# Feature Specification: Facebook Page and Instagram comment reading

**Feature Branch**: `085-facebook-instagram-comments-reader`

**Created**: 2026-10-19

**Status**: Draft

**Input**: Roadmap `read-instagram-comments-facebook-page-co`, entry `facebook-instagram-comments-reader`. Add an `engagement` member to the Facebook and Instagram providers that reads comments on the brand's own posts into the existing inbox, solving — once, in the shared Meta layer — the mismatch between a seam that assumes an account-level feed and a platform that lists comments per post. No Threads. No replying. No moderation. No inbox redesign.

## Why this is one feature, not two

The engagement seam hands a provider an account, a cursor, provider-owned state and a direction. It does not hand it the brand's posts. Bluesky needs nothing more, because Bluesky has an account-level notification feed. Facebook and Instagram have no such feed: comments hang off one post at a time. Both therefore need the same new thing — a way to find the brand's own recent posts, walk them newest-first, remember where the walk stopped, and page older on catch-up — and both run it over the same Graph API with the same token the publish path already holds. Written twice it would be two subtly different walks with two sets of off-by-one bugs. Written once in the shared Meta layer, each provider's own module is a thin declaration plus the few facts that differ between a Page and an Instagram account — exactly the division post and account insights already use across these same two providers.

## The facts this feature may use, and the ones it is missing

Constitution principle I governs this feature. Every endpoint, permission, identity field, pagination shape and limit must come from `docs/research/engagement.md` §2 or another `docs/research/*.md` page, never from memory.

As of this spec, §2 confirms for **both** Facebook Page comments and Instagram comments:

- the comments read endpoint (per-post: the comments edge of one post or media object);
- the permission required, and that it sits inside Standard Access — reachable by a self-hosted install with no App Review;
- that comments are listable **per post only**; there is no account-level "all comments" endpoint;
- cursor-based pagination;
- that no comment-specific rate limit exists, so the general business-use-case ceiling is the only budget.

§2 leaves **unverified** for both surfaces, and says so explicitly:

- **G1 — commenter identity fields.** No author, username, identifier or profile-link field has been confirmed on either platform's comment object.
- **G2 — identifier stability** across two comments by the same person; it cannot be answered before G1.
- **G3 — deleted and edited presentation** on a later read.

And §2 never asked a fourth question this feature needs:

- **G4 — how to list the brand's own recent posts.** The per-post sweep is impossible without a confirmed listing edge for a Page's own posts and for an Instagram account's own media, with its pagination shape. `docs/research/meta.md` confirms the *publishing* edges only.

§2 already records its own verdict for both surfaces: "must ship declared-but-unavailable". This feature does not overturn that by assumption. It closes the gaps by research first (FR-001 to FR-005), and only then builds. A surface whose gaps do not close ships declared-but-unavailable with the reason, and the other surface ships anyway. If neither closes, both ship unavailable and the shared layer ships behind them — a legitimate, honest outcome under constitution I, not a failure.

**Recorded disagreement (constitution I).** The roadmap entry describes the sweep as buildable today and says the work "needs no scheduler or schema change, and must not become one". The research does not yet support the first half, and the second half is true of the schema but not quite of the scheduler: the seam's page outcome already declares a provider-state field, but the engagement-read section never reads it back — it re-commits the state it parsed on entry (`src/server/scheduler/engagement-read.ts:124-125` and `:245`). Bluesky returns no state, so the gap has never shown. The sweep position this feature must persist depends on that field working. Honouring a field the seam already declares is a defect fix, not a new generic hook, and it is in scope here (FR-033). The seam's shape, the provider-state contract and the database schema do not change.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A comment on our Facebook Page reaches the inbox (Priority: P1)

A member publishes a Page post through Docket. Someone comments on it on Facebook. Within the inbox's normal reading rhythm the comment appears in Docket's inbox, attributed to the post it was left on, carrying what the member could see on Facebook itself — the comment's words and when it was said — and no detail Docket cannot stand behind.

**Why this priority**: It is half the feature's name and the first thing the roadmap entry asks for. A single Facebook comment arriving, attached to the right post, is the whole value: a member stops having to open Facebook to find out whether anyone answered them.

**Independent Test**: With mocked platform responses for the Page's own posts and for one post's comments, run the engagement-read section for a connected Facebook Page and assert the comment is stored once, as a comment, with the platform's own comment identifier, the post identifier as its parent, and that parent resolved to the Docket post it belongs to.

**Acceptance Scenarios**:

1. **Given** a connected Facebook Page that holds the required read permission and has one recent post with one comment on it, **When** the engagement-read section runs, **Then** one inbox item appears for that comment, showing its text and the time it was said, listed against the Docket post it was left on.
2. **Given** the same comment is still there on the next run, **When** the section runs again, **Then** no second copy appears and no second notification is raised.
3. **Given** the brand's own Page left a comment on its own post, **When** the section runs, **Then** no inbox item appears for it — a member is not notified of their own words.
4. **Given** a comment whose author details the platform does not supply, **When** the item is shown, **Then** the author area is honestly empty rather than filled with a placeholder name, handle or profile link.
5. **Given** the Facebook comment facts stayed unverified after the research step, **When** a member opens the inbox, **Then** Facebook Pages is shown as unavailable with the stated reason and a documentation link, no Facebook read is ever attempted, and Instagram is unaffected.

---

### User Story 2 - A comment on our Instagram post reaches the inbox (Priority: P1)

The same journey on Instagram: someone comments on a post Docket published to the brand's Instagram account, and the comment turns up in the inbox against that post.

**Why this priority**: The other half of the name, and equal in value. It ships beside Facebook because the hard part — the per-post sweep — is shared; shipping one alone would leave that machinery with a single caller and no proof it generalises.

**Independent Test**: With mocked platform responses for the account's own media and for one media object's comments, run the engagement-read section for a connected Instagram account and assert the comment is stored once with its parent media identifier resolved to the Docket post.

**Acceptance Scenarios**:

1. **Given** a connected Instagram account that holds the required read permission and has one recent post with one comment, **When** the engagement-read section runs, **Then** one inbox item appears for that comment against the Docket post it was left on.
2. **Given** the platform returns only top-level comments and a nested reply exists beneath one of them, **When** the section runs, **Then** Docket stores what the platform returned and never invents the nested reply.
3. **Given** a comment the brand's own account left on its own media, **When** the section runs, **Then** no inbox item appears for it.
4. **Given** the Instagram comment facts stayed unverified after the research step, **When** a member opens the inbox, **Then** Instagram is shown as unavailable with the stated reason, no Instagram read is attempted, and Facebook is unaffected.

---

### User Story 3 - Older comments are caught up, and the catch-up ends (Priority: P2)

A brand connects an account that already has months of posts. Docket works backwards through them over successive runs, bringing older comments in a bounded amount at a time, and then stops — it does not keep asking the platform for history that is not there.

**Why this priority**: Without it the inbox only ever shows comments on whatever was posted since the account was connected, which makes the feature feel broken on day one. It is P2 because a brand-new account with a brand-new post gets its value from stories 1 and 2 alone.

**Independent Test**: With mocked responses spanning several pages of the brand's own posts, run the section repeatedly and assert each run reaches further back, that the walk resumes where the previous run stopped rather than restarting, and that once the oldest post is passed the catch-up stops and does not resume.

**Acceptance Scenarios**:

1. **Given** an account with more posts than one run may examine, **When** the section runs twice, **Then** the second run examines posts the first did not, rather than re-examining the same ones.
2. **Given** the walk has reached the oldest post the platform will return, **When** the section runs, **Then** it reports there is nothing older, the catch-up stops, and later runs look only for new comments.
3. **Given** a run is killed partway through its sweep, **When** the next run starts, **Then** it resumes from the last committed position and no comment is missed or duplicated.
4. **Given** the platform rejects the stored walk position, **When** the section runs, **Then** Docket restarts the walk from the newest post rather than failing the account, and nothing already stored is lost or re-notified.
5. **Given** a comment older than the inbox's retention window, **When** the catch-up reaches it, **Then** it is not stored, so a restart cannot resurrect what retention already removed.

---

### User Story 4 - Reading never costs the brand its ability to publish (Priority: P2)

Reading comments shares one platform call budget with publishing. A brand with many posts must never find a scheduled post blocked because the inbox spent the budget, and Docket must back off when the platform says it is near its ceiling.

**Why this priority**: A missed post is the worst outcome in the product; the constitution puts publishing first everywhere else and this must match. P2 because it is a property of the reads in stories 1 to 3 rather than a journey of its own.

**Independent Test**: With a mocked usage signal at and below the configured ceiling, assert a run at the ceiling records a back-off and the next run for that account declines to call and reports itself rate limited with a time to retry, while a run below the ceiling proceeds.

**Acceptance Scenarios**:

1. **Given** the platform reports usage at or above the configured ceiling with a time to regain access, **When** the read finishes, **Then** the next read for that account does not call the platform until that time has passed.
2. **Given** an account with far more posts than the budget allows, **When** one run happens, **Then** the number of calls it makes is bounded by a stated limit and well inside the run's share of the tick, whatever the account's size.
3. **Given** the platform refuses the call, **When** the read handles it, **Then** the outcome is reported as one of the seam's existing outcomes — retry later, rate limited, credentials invalid, position lost, or a permanent refusal — and never as a new kind of outcome.
4. **Given** any failure, **When** the read returns, **Then** the stored walk position and catch-up flag are unchanged, and no access token appears in any stored message, summary or log line.

---

### User Story 5 - A member understands that a Meta comment cannot be answered here (Priority: P3)

A member opens a Facebook or Instagram comment in the inbox. There is no reply box. In its place is a plain sentence saying this platform cannot be replied to through Docket — not a greyed-out button, not an error.

**Why this priority**: The behaviour already exists; this story confirms it reads as a deliberate limit rather than a fault. Low priority because nothing is broken without it, but a member meeting a dead button would reasonably assume Docket is broken.

**Independent Test**: Open the inbox detail view for a stored Facebook comment and for a stored Instagram comment and confirm the reply area is replaced by the stated reason, and that the reason names the platform limit rather than an account or item problem.

**Acceptance Scenarios**:

1. **Given** a stored Facebook Page comment, **When** a member opens it, **Then** no reply composer is offered and the reason shown is that this platform cannot be replied to through Docket.
2. **Given** a stored Instagram comment, **When** a member opens it, **Then** the same holds, with the same wording.
3. **Given** some other path somehow asks Docket to send a reply to a Meta comment, **When** the send runs, **Then** it fails permanently with a clear reason and is never retried.
4. **Given** a stored Meta comment, **When** a member looks at it, **Then** everything else the inbox offers — dismissing, marking handled, seeing which post it belongs to — still works.

---

### User Story 6 - An unconfirmed surface says so instead of guessing (Priority: P3)

Where the research could not confirm what a surface needs, Docket says the surface is not available and why, and attempts nothing — rather than shipping a reader built on a plausible-looking guess.

**Why this priority**: It is the safety valve the whole feature leans on, and the roadmap entry states it as a condition of shipping. P3 as a journey because in the good case a member never sees it; non-negotiable as a rule.

**Independent Test**: Declare a surface unavailable and assert the engagement-read section never claims an account on it, the inbox lists it in its unavailable-accounts notice with the stated reason, and the reason names the missing fact rather than a generic failure.

**Acceptance Scenarios**:

1. **Given** a surface declared unavailable, **When** the engagement-read section runs, **Then** no account on that surface is claimed and no call is made for it.
2. **Given** a surface declared unavailable, **When** a member opens the inbox, **Then** that surface appears in the unavailable notice with a reason a non-technical member can act on and a link to the documentation.
3. **Given** an account that has not reconnected and therefore does not hold the declared read permission, **When** the section runs, **Then** that account is not claimed, nothing is read for it, and the skip is counted rather than silently dropped.
4. **Given** a surface shipped unavailable, **When** someone reads the documentation, **Then** it states which fact is missing and what would confirm it, not merely that the surface is unsupported.

### Edge Cases

- **A post with no comments.** The sweep examines it, finds nothing, and moves on without storing anything or counting it as a failure.
- **A post the platform will no longer answer for** (deleted on the platform, or an identifier shape the comments edge rejects). The sweep skips that post, records nothing against it, and continues with the rest — one unreadable post never fails the whole account.
- **An account with no posts at all.** The sweep finds nothing to examine, reports there is nothing older, and the catch-up ends immediately rather than looping.
- **More comments on one post than a single run may read.** The run stops at its bound and the next run continues from where it stopped; comments are not silently dropped because one post is busy.
- **A comment whose text is empty** (an image-only or sticker-only comment). Stored with empty text, never with a placeholder like "(no text)".
- **A comment longer than the inbox stores.** Stored truncated and flagged as truncated, so a member knows there is more on the platform.
- **A comment left before Docket's retention horizon.** Not stored at all.
- **A comment on a post Docket did not publish** (posted directly on the platform). It still belongs to the brand's account, so it is read; the generic layer simply resolves no Docket post for it, and the item shows without post context.
- **Two comments by the same person.** If the platform does not promise the same identifier twice, Docket says so and the inbox does not group them as one person.
- **A deleted or edited comment on a later read.** Until the platform's behaviour here is confirmed, absence from a re-read is treated as no signal at all and nothing is marked withdrawn or edited — the same stance Bluesky takes.
- **The stored walk position names a post that no longer exists.** The walk restarts from the newest post rather than stalling.
- **A tick that is nearly out of time when the account is claimed.** The read does the bounded work it can and commits it, rather than overrunning the tick's share.
- **An account whose token is rejected mid-sweep.** The account is marked as needing reconnection, nothing already stored is lost, and the walk position is left where it was.

## Requirements *(mandatory)*

### Functional Requirements

#### Settle the facts before building (constitution I)

- **FR-001**: Before any reading code is written, `docs/research/engagement.md` §2 MUST be revisited for the Facebook Page comments and Instagram comments surfaces only, answering gap **G1** — which identity fields a commenter carries (display name, handle, identifier, profile link) — for each surface, using official platform documentation, with a source link, the date checked and an evidence grade recorded in the same shape §2 already uses.
- **FR-002**: §2 MUST likewise answer gap **G2** — whether a commenter's identifier is the same across two comments by the same person — for each of the two surfaces.
- **FR-003**: §2 MUST likewise answer gap **G3** — how a deleted or edited comment presents itself on a later read — for each of the two surfaces.
- **FR-004**: §2 MUST gain a new question, asked of both surfaces, answering gap **G4**: how an installation lists the brand's **own recent posts** (a Page's posts; an Instagram account's media), with the identifier shape returned and the pagination shape, recorded with a source link, date and evidence grade.
- **FR-005**: A question that official documentation genuinely cannot answer MUST stay recorded as unverified with what was tried, exactly as §2 already does. Leaving it unverified is a legitimate outcome and MUST NOT be worked around by inference, by a plausible-looking default, or by copying another surface's answer.
- **FR-006**: Whether each surface ships readable or ships declared-but-unavailable MUST follow mechanically from §2 after FR-001 to FR-005: a surface is readable only if its comments endpoint, its permission, its own-posts listing edge (G4) and its commenter identity shape (G1) are all recorded as confirmed. Any other combination means that surface ships declared-but-unavailable, naming the missing fact. The two surfaces are decided independently; one shipping unavailable MUST NOT block the other.
- **FR-007**: No endpoint path, parameter, field name, permission name, pagination key or limit used by this feature's code may originate anywhere other than `docs/research/engagement.md` §2 or another `docs/research/*.md` page carrying a source.

#### One sweep, shared by both providers

- **FR-008**: The sweep, the comment-to-item mapping, the walk-position handling, the usage-ceiling back-off and the platform-error classification MUST live once in the shared Meta layer. Each provider's own engagement module MUST hold only its declaration and the facts that genuinely differ between a Page and an Instagram account.
- **FR-009**: The sweep MUST discover which of the brand's own posts to examine from the platform itself. It MUST NOT read Docket's own database: a provider has no access to project-scoped data and gaining one is out of scope.
- **FR-010**: When asked for the newest items, the sweep MUST examine the brand's most recent posts first, stopping as soon as it meets comments it already holds or reaches its call bound.
- **FR-011**: When asked for older items, the sweep MUST continue from the walk position it last recorded, reaching further back each run rather than re-examining the same posts.
- **FR-012**: The sweep MUST record its position — which post it reached and where within that post's comments — in the provider-owned state the seam already carries, under the provider's own state shape. This introduces no change to the engagement seam, the scheduler's interface or the database schema.
- **FR-013**: The recorded state MUST stay within the size the stored provider state already allows, for an account of any size, and MUST remain readable by a later version that finds a position naming a post that no longer exists.
- **FR-014**: One read MUST make at most a stated, bounded number of platform calls — a stated maximum of posts examined and a stated maximum of comment pages per post — regardless of how many posts or comments the account has, so that the engagement section stays well inside its share of a tick.
- **FR-015**: The sweep MUST report that there is nothing older only when the platform has genuinely returned no further posts and no further comments. It MUST NOT report exhaustion merely because it hit its own call bound.
- **FR-016**: A comment authored by the brand's own account MUST NOT become an inbox item.
- **FR-017**: A post the platform refuses to answer for MUST be skipped, with the sweep continuing to the remaining posts; one unreadable post MUST NOT fail the account's whole read.

#### Budgets, failures and secrets

- **FR-018**: Reads MUST observe the platform's business-use-case usage signal the same way post and account insights already do: a response at or above the configured ceiling with a stated time to regain access MUST make the account's *next* read decline to call and report itself rate limited until that time passes.
- **FR-019**: Every platform failure MUST be reported as one of the outcomes the engagement seam already defines — retry later, rate limited, credentials invalid, read position lost, permanently refused, or surface unavailable. No new outcome kind may be introduced.
- **FR-020**: A rejected read position MUST produce the seam's "position lost" outcome, so the next run restarts from the newest post; it MUST NOT be reported as a permanent failure.
- **FR-021**: A rejected or expired token MUST produce the seam's "credentials invalid" outcome so the account is marked as needing reconnection.
- **FR-022**: On any outcome other than a successful page, the stored walk position and catch-up flag MUST be left exactly as they were, while anything already read and stored in that run is still committed.
- **FR-023**: No access token, credential or secret may appear in any stored error message, attempt summary, activity entry, log line or test snapshot produced by this feature.

#### What a stored comment says

- **FR-024**: Each comment MUST become one inbound item of kind "comment".
- **FR-025**: The item's identifier MUST be the platform's own identifier for that comment, so the same comment read twice is stored once.
- **FR-026**: The item's parent identifier MUST be the platform's own identifier for the post the comment sits on, so the generic layer can resolve it to the Docket post and target and a member sees which of their posts it is about.
- **FR-027**: The item's author MUST carry exactly the fields §2 confirmed the platform supplies, and nothing more. Any field the platform does not supply MUST be recorded as absent.
- **FR-028**: No display name, handle, profile link or author identifier may be synthesised, derived, guessed or copied from another field. An absent profile link stays absent rather than becoming a constructed address.
- **FR-029**: The author MUST be marked as not stably identified unless §2 confirms the platform gives the same identifier for the same person across two comments.
- **FR-030**: The item's said-at time MUST come from the platform's own timestamp for the comment.
- **FR-031**: A comment with no text MUST be stored with empty text, never a placeholder. A comment longer than the inbox stores MUST be stored truncated and flagged as truncated.
- **FR-032**: An item MUST be flagged as withdrawn or edited upstream only where §2 confirms how the platform signals it. Absent that confirmation, absence from a later read MUST be treated as no signal at all and nothing is flagged.
- **FR-033**: The engagement-read section MUST persist the provider state a successful read returns, rather than re-committing the state it parsed on entry. This honours a field the seam already declares and on which the sweep depends; it changes no interface and no table.
- **FR-034**: Anything the provider stores alongside an item MUST contain no credential or token.

#### Declared, gated, and not repliable

- **FR-035**: Each shipping surface MUST declare that it reads comments and that it cannot be replied to, and MUST declare no write allowance.
- **FR-036**: An attempt to send a reply on either surface MUST fail permanently with a clear, member-readable reason and MUST never be retried.
- **FR-037**: Each surface MUST declare the read permissions the previous entry's gate expects, so an account whose granted permissions do not include every declared one is never claimed, no call is attempted for it, and the skip is counted.
- **FR-038**: Each surface MUST declare the message shown when those permissions are not held, naming what to do about it and linking to the setup documentation.
- **FR-039**: A surface that FR-006 decides is not readable MUST be declared unavailable with a reason that names the missing fact, and a documentation link. No account on an unavailable surface may be claimed and no call may be made for it.
- **FR-040**: Both the Facebook and the Instagram provider MUST expose an engagement member, whether it ships readable or unavailable, so both surfaces appear in the inbox's account list and notices rather than being invisible.

#### What a member sees

- **FR-041**: Where a Meta comment is open in the inbox, the place a reply would be composed MUST carry a plain sentence stating that this platform cannot be replied to through Docket — not a disabled control and not an error. The existing wording MUST be checked against this and corrected if it reads as a fault.
- **FR-042**: Everything else the inbox already offers on an item — dismissing, marking handled, the link to the post it belongs to, filtering by account — MUST keep working for Meta comments.
- **FR-043**: Beyond a new provider appearing in the existing account filter, unavailable notice and item list, the inbox MUST NOT change.

#### Proof and documentation

- **FR-044**: Every behaviour in this feature MUST be covered by tests that mock the platform's HTTP responses. No test may make a live platform call, and no behaviour may be reported as working without a test that ran.
- **FR-045**: The feature MUST be reported as verified with mocks only, stating plainly that no live Facebook Page or Instagram account was read.
- **FR-046**: `docs/engagement.md`'s supported-platforms table MUST be updated to state, per surface, what is read, that replying is not offered, and — for a surface shipping unavailable — why.
- **FR-047**: `docs/engagement.md`'s platform-permissions section MUST be updated to state the permissions each shipping surface now actually requires, what happens to an account that has not reconnected, and that the opt-in flag alone cannot widen a login configuration.
- **FR-048**: `docs/research/engagement.md` MUST be updated with anything the implementation learned that documentation alone did not give — including any fact a mocked test forced the design to assume, recorded as an assumption rather than as a confirmed fact.

### Key Entities

- **Inbound comment**: one person's comment on one of the brand's posts, as it arrives from the platform — its own identifier, its words, when it was said, the post it sits on, and whatever the platform says about who left it.
- **Sweep position**: the provider's private record of how far through the brand's own posts the catch-up has walked and where within the current post's comments it stopped. Held in the existing provider-owned state; meaningful only to the Meta layer.
- **Surface declaration**: what each of Facebook Pages and Instagram says about itself — which kinds it reads, that it cannot be replied to, which permissions a read needs, and, where the facts are not settled, that it is unavailable and why.
- **Usage back-off**: a short-lived, per-account note that the platform reported itself near its ceiling, which makes the next read decline rather than call.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a connected account on a readable surface, a new comment on one of the brand's recent posts appears in the inbox without anyone opening the platform, and is attributed to the post it was left on.
- **SC-002**: Reading the same comment on every subsequent run produces exactly one inbox item and exactly one notification, across at least ten consecutive runs.
- **SC-003**: One account's read performs no more than the stated bounded number of platform calls, whatever the size of the account, measured on a mocked account with at least ten times more posts than the bound allows.
- **SC-004**: An account with months of history has its older comments brought in progressively over successive runs, and the catch-up ends by itself — there is a run after which it reports nothing older and never resumes.
- **SC-005**: Every platform failure a mocked test can produce resolves to one of the engagement seam's existing outcomes; no test produces an unclassified failure.
- **SC-006**: After any failure, the walk position and catch-up flag are byte-for-byte what they were before the run, while anything read before the failure is still stored.
- **SC-007**: No stored message, summary, activity entry or test snapshot anywhere in this feature contains an access token, checked by a test that scans them.
- **SC-008**: Every author field shown for a Meta comment can be traced to a confirmed row in `docs/research/engagement.md` §2; no field is shown that §2 does not confirm the platform supplies.
- **SC-009**: An account that has not reconnected and does not hold the declared read permission causes zero platform calls, and the skip is visible in the section's own counts rather than silent.
- **SC-010**: A member opening a Meta comment is told in one sentence why there is no reply box, and that sentence names the platform limit rather than suggesting something is broken.
- **SC-011**: Every surface this feature ships — readable or unavailable — appears in `docs/engagement.md`'s supported-platforms table with a statement a non-technical reader can act on.
- **SC-012**: The full test suite passes with no live platform call, and the feature's own tests pass with the platform mocked at every boundary.

## Assumptions

- **The research step can reach official documentation.** This feature's first phase repeats what the previous entry did: searching official platform documentation and quoting it. If it cannot reach anything, FR-005 applies and both surfaces ship unavailable, which is still a shippable outcome.
- **Both surfaces may end up unavailable.** The research as it stands says both must. The feature is written so that outcome ships the shared layer, the declarations, the gate and the documentation honestly, rather than shipping nothing. Partial outcomes — one surface readable, one not — are expected to be the common case and are explicitly supported.
- **The token already held is the token a read needs.** Both surfaces are read with the same page or account token the publish path already stores; no new token kind, no new storage, no new refresh path.
- **Reading the brand's own posts is a read, not a write.** Listing the account's own posts spends the same call budget as any other read and needs no permission beyond those the surface already declares — to be confirmed as part of gap G4.
- **"Recent" means the window the bound reaches.** How far back the newest-first sweep looks is set by the call bound in FR-014, not by a date. A comment on a post older than the bound reaches is picked up by the catch-up rather than by the fresh sweep.
- **Comment text limits follow the inbox's existing ones.** Truncation length, retention and notification behaviour are whatever the inbox already does; this feature adds no new policy.
- **Nested replies are out of reach until confirmed.** Where a platform returns only top-level comments, Docket stores only those. Expanding to nested replies is a later decision resting on a confirmed fact, not something to infer now.
- **The identity rule is uniform.** Wherever §2 does not promise the same person twice, the author is marked not stably identified — even where a display name is supplied. A name is not an identity.
- **The scheduler's existing bounds are the outer limit.** The feature works inside the engagement section's existing per-run page count, page size, minimum interval and share of the tick. It does not add new scheduler settings.

## Out of Scope

- **Threads, entirely.** Replies and mentions on Threads — their separate app, token and host — belong to the `threads-replies-and-mentions-reader` entry. Nothing here touches the Threads provider.
- **Replying on any Meta surface.** Both surfaces declare that they cannot be replied to. Building a Meta reply path is a later feature, not this one.
- **Comment moderation.** Hiding, unhiding, deleting or reporting a comment on the platform is not added, even where the research names an endpoint for it.
- **Direct messages** on either platform.
- **Inbox redesign.** No new screen, no new filter, no new column — only what a new provider appearing in the existing inbox requires.
- **New scheduler sections, settings or database tables.** The engagement-read section, its settings and the existing tables are used as they are. The one change inside the scheduler (FR-033) honours a field the seam already declares and adds nothing.
- **Changing the engagement seam.** No new field on the declaration, the read context, the read outcome or the item draft.
- **Live verification.** No live Meta app, Page or Instagram account is used. Anything that needs one is recorded as unverified rather than claimed.

## Dependencies

- The engagement inbox, its scheduler section, its retention and its notifications, as shipped and in use for Bluesky.
- The previous entry's permission gate: declared read permissions on a surface, the claim query that refuses an account missing any of them, the inbox's unavailable notice, the opt-in environment flag and the connect-dialog scope widening.
- The shared Meta request, usage-signal and error-classification helpers, and the page/account token reader the publish and insights paths already use.
- `docs/research/engagement.md` §2 as the single source for every platform fact, and `docs/research/meta.md` for the general platform-wide limits it already records.
