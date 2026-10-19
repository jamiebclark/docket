# Feature Specification: Threads replies and mentions land in the inbox

**Feature Branch**: `086-threads-replies-and-mentions-reader`

**Created**: 2026-10-19

**Status**: Draft

**Input**: User description: "Add an `engagement` member to the Threads provider that reads both inbound surfaces the platform exposes — replies to the brand's own posts and mentions of the brand elsewhere — into the inbox. [...] If the research left either surface unverified, declare that surface `unavailable` with its reason and ship the other. [...] Finish the roadmap's documentation."

## Context: what the research settled, and what it did not

This entry's scope is decided by the confirmed cells of `docs/research/engagement.md` §2
and by nothing else (constitution principle I). Read against that section, the outcome is:

| Threads surface | Permission name | Permission access level | Read endpoint | Author identity shape | Pagination shape | Verdict |
|---|---|---|---|---|---|---|
| Replies | `threads_manage_replies` — **confirmed** | Standard Access — **confirmed** | **unverified** | **unverified** | **unverified** | must ship `unavailable` |
| Mentions | `threads_manage_mentions` — **confirmed** | general rule only — **confirmed** | **unverified** | **unverified** | **unverified** | must ship `unavailable` |

The research records its own consequence for each surface in as many words: "**must ship
declared-but-`unavailable`**", because "the permission name and its access level are confirmed,
but the endpoint itself is not". It also states the rule that governs this entry: "no code reads
or displays a Threads replier identity in this entry", and "every identity field any future Meta
or Threads surface displays [...] must trace to a confirmed verdict, not to this section's
`unverified` rows".

The feature description anticipated exactly this and pre-decided it: "If the research left either
surface unverified, declare that surface `unavailable` with its reason and ship the other — a
reader for replies alone is a correct outcome of this entry if mentions could not be confirmed."
Both surfaces came back unverified, so the same rule applied twice yields **no reader on either
surface**. This entry therefore ships the declaration, not the reader. See Assumptions for the
re-verification attempt made while writing this spec, and Out of Scope for what that defers.

Two consequences follow for the design, and they are this entry's real work:

1. **A reader that cannot be built must still be declared honestly.** A Threads account must
   appear in the inbox as a known-but-not-yet-readable surface with a truthful reason, and must
   never be claimed, leased, decrypted or called — not once, not on a tick, not behind an opt-in.
2. **The parentless-item behaviour is not blocked and ships in full.** The entry's second named
   problem — "a mention has no parent post of the brand's own, so `parentExternalId` is null [...]
   make sure the inbox's 'about your post' context and first-engagement both behave correctly with
   that null rather than silently attributing the mention to nothing" — does not depend on Threads
   at all. Bluesky already emits `kind: "mention"` items with a null parent today, so this is live
   behaviour on a shipped surface that no test currently covers and that the inbox currently
   renders as silence. It is specified and proven here.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A Threads account tells the truth about the inbox (Priority: P1)

A member who has connected a Threads account opens the inbox. Threads posts go out from Docket,
so they reasonably expect replies to come back. Instead of Threads being silently missing from
every filter with no explanation, they see it named as a platform whose replies and mentions
Docket cannot read yet, with the reason given plainly, and a link to the setup documentation.

**Why this priority**: It is the only member-visible change this entry can honestly make, and it
replaces the worst current outcome — a connected account that looks like it should be producing
inbox items and silently never does — with a stated limitation. It is also what keeps the
roadmap's promise reviewable: the surface is declared, so the day the endpoint is confirmed, the
reader drops in behind a declaration that already exists.

**Independent Test**: Connect a Threads account in a test install, open the inbox, and confirm the
unavailable notice names Threads and its reason; run a scheduler tick and confirm no Threads
account was claimed and no Threads credential was decrypted.

**Acceptance Scenarios**:

1. **Given** a connected Threads account, **When** a member opens the inbox, **Then** the
   unavailable-accounts notice names that account and states that its replies and mentions cannot
   be read yet, with the reason the research gives (the read endpoint is unconfirmed), and a link
   to the setup documentation.
2. **Given** a connected Threads account, **When** the engagement-read scheduler section runs,
   **Then** no Threads account is claimed, no Threads credential is decrypted, no outbound request
   is made for it, and the tick counts it as unavailable rather than as an error or a success.
3. **Given** a connected Threads account, **When** a member uses the inbox's account filter,
   **Then** the Threads account is not offered as a filterable source of items, because it can
   produce none.
4. **Given** a connected Threads account, **When** a member views the accounts page, **Then**
   the same unavailability is stated there, consistent in wording with the inbox notice.
5. **Given** an operator who has set the Threads engagement opt-in and had the account reconnect
   so the Threads reply and mention permissions are actually granted, **When** they open the
   inbox, **Then** the notice still states that reading is not built yet — granting the permission
   is never presented as the thing that will start it, because it is not.

---

### User Story 2 - A mention is never attributed to a post it is not about (Priority: P1)

A member receives a mention of the brand in somebody else's thread — the brand's own posts are
not involved. In the inbox, that item is shown as a mention with no "about your post" context,
and it never counts towards any of the brand's own posts: not as that post's first engagement, and
not in a "newer comments on the same post" count.

**Why this priority**: This is the correctness problem the entry names, and it is live today on
Bluesky, which already emits mentions with a null parent. Getting it wrong is silent and
compounding — a mention folded into a post's first-engagement figure corrupts a number the member
is shown and trusts, with no visible symptom. The behaviour is currently correct by construction
but entirely unproven, which is the gap this closes.

**Independent Test**: Ingest a mention with no parent alongside a reply that does have one,
through the mock provider and through the Bluesky mapping, then assert the mention is stored with
no parent post or target, is excluded from first-engagement, and reports a zero same-post count.

**Acceptance Scenarios**:

1. **Given** an inbound mention whose parent identifier is absent, **When** it is ingested,
   **Then** it is stored with no parent identifier, no parent post and no parent post target, and
   is not attached to any of the brand's own posts.
2. **Given** a stored mention with no parent, **When** the first-engagement figure for each of the
   brand's published posts is recorded, **Then** that mention contributes to none of them, and a
   post whose only inbound activity is such a mention still reports that nothing has been observed
   on it yet.
3. **Given** a stored mention with no parent, **When** a member opens it, **Then** no "about your
   post" context is shown for it, and the count of newer activity on the same post is zero rather
   than a count of every other parentless item.
4. **Given** an inbound reply that does carry a parent identifier matching one of the brand's own
   published posts, **When** it is ingested and opened, **Then** the brand's own post is shown as
   its context and it does count towards that post's first engagement — proving the null case is
   distinguished from the set case rather than both collapsing.
5. **Given** an inbound reply carrying a parent identifier that matches none of the brand's own
   posts, **When** a member opens it, **Then** it is shown as a reference to something that is not
   one of the brand's posts, and still contributes to no post's first engagement.

---

### User Story 3 - A parentless item says so, instead of showing nothing (Priority: P2)

A member opening a mention sees a short, explicit statement that it is not about one of the
brand's own posts, rather than an item page that simply omits the context block and leaves them
unsure whether the context is missing, still loading, or failed to resolve.

**Why this priority**: Silence and "we could not work it out" look identical to a member, and the
entry asks specifically that the null behave correctly rather than invisibly. It is separated from
User Story 2 because that story is about never misattributing (a data-correctness guarantee) while
this one is about saying so (a presentation choice) — each is testable and shippable without the
other.

**Independent Test**: Open a stored mention with no parent and confirm the item page states it is
not about one of the brand's posts; open a reply on one of the brand's posts and confirm that
statement is absent and the post's own context is shown instead.

**Acceptance Scenarios**:

1. **Given** a stored item with no parent identifier, **When** a member opens it, **Then** the
   page states plainly that it is not about one of the brand's own posts.
2. **Given** a stored item whose parent is one of the brand's own posts, **When** a member opens
   it, **Then** that post's content is shown as context and the parentless statement is absent.
3. **Given** a stored item whose parent is a reference that is not one of the brand's posts,
   **When** a member opens it, **Then** it is distinguished from both of the above — neither
   claiming the brand's post nor claiming there is no parent at all.

---

### User Story 4 - The roadmap's documentation ends honest (Priority: P2)

Somebody reading the engagement documentation after this roadmap finishes can see, for every
platform and every surface the roadmap set out to fill, whether it is read, and if not, why not —
without opening a spec, a research file or the code.

**Why this priority**: This is the roadmap's closing deliverable and the entry explicitly owns it.
A supported-platforms table that quietly omits the surfaces that did not make it is the single
most likely way for the next person to assume a surface works, or to redo research that was
already done and came back empty.

**Independent Test**: Read the supported-platforms table and the provider guide's engagement
section cold, and confirm every surface this roadmap touched has a verdict with a reason, and that
the guide names a current example of each of the two reader shapes.

**Acceptance Scenarios**:

1. **Given** the engagement documentation, **When** somebody reads the supported-platforms table,
   **Then** every platform and surface this roadmap set out to fill has an answer — including the
   ones that are still "Not yet" — and each "Not yet" carries the reason it is not yet.
2. **Given** that table, **When** somebody reads the Threads row, **Then** it distinguishes
   replies from mentions, names each permission, and states that reading is blocked on an
   unconfirmed endpoint rather than on a permission the install cannot hold.
3. **Given** the provider guide's engagement section, **When** somebody adding a provider reads
   it, **Then** it points them at a current, real example of a per-post reader and a current, real
   example of an account-level reader, and says which shape suits which kind of platform.
4. **Given** the provider guide's engagement section, **When** somebody reads the rule about
   declaring a surface that cannot be read, **Then** it is clear that a declaration marking a
   surface unavailable must not also claim read permissions, and why those two statements are
   different.

---

### User Story 5 - The next person does not redo this research (Priority: P3)

Somebody picking up Threads engagement later can see what was tried to confirm the two endpoints,
when, and what came back, so they start from the gap rather than from the beginning.

**Why this priority**: Lowest because nothing depends on it, but it is cheap and it is what makes
the `unavailable` verdict auditable rather than merely asserted. A future reviewer must be able to
tell "nobody could confirm this" from "nobody looked".

**Independent Test**: Read the Threads sections of the research file and confirm they record this
entry's re-check attempt, its date, and that the result was unchanged.

**Acceptance Scenarios**:

1. **Given** the research file's Threads sections, **When** somebody reads them, **Then** they
   record that the endpoints were re-checked while specifying this entry, on what date, and that
   official documentation still did not yield an endpoint path, field list or pagination shape.
2. **Given** those sections, **When** a surface's verdict is read, **Then** the specific facts
   that are still missing are named, so confirming them is a bounded piece of work rather than
   open-ended research.

---

### Edge Cases

- **A declaration that marks a surface unavailable while also naming read permissions** must be
  refused at startup, not at tick time — the two statements mean different things ("not readable
  here at all" versus "this account has not granted it yet") and a declaration asserting both is
  incoherent. This rule already exists and this entry must not violate it: the Threads declaration
  is unavailable, so it names no read permissions, even though the permissions are confirmed and
  are already requested by the connect dialog.
- **A declaration that reads nothing at all** must remain impossible: a provider that cannot read
  any kind omits engagement entirely. Threads declares the two kinds it will read once unblocked,
  and is unavailable — which is a different statement from reading nothing.
- **An operator who opts in to the Threads engagement permissions and reconnects** must not be led
  to expect items. The permission request and the reader are separate, and the opt-in is already
  shipped; this entry must not let the inbox imply that granting it starts anything.
- **A Threads account connected before this entry, with no engagement permissions granted**,
  behaves identically to one that has them: nothing is read either way, because the surface is
  unavailable rather than ungranted. The unavailability must take precedence in the wording, so no
  member is sent round a reconnect that cannot help them.
- **An item whose parent identifier is present but matches none of the brand's own posts** is a
  third case, distinct from both a null parent and a resolved one, and must not be collapsed into
  either.
- **A parentless item arriving for a provider that also emits parented items** must not disturb the
  parented ones: a run mixing replies and mentions stores both correctly.
- **Reply sending on Threads** must read to a member as a platform limitation, not a broken
  control: the reply composer is absent rather than present-and-failing, and any attempt that
  reaches the send path ends in a permanent, non-retried refusal.

## Requirements *(mandatory)*

### Functional Requirements

#### The Threads engagement declaration

- **FR-001**: The Threads provider MUST declare an engagement member, so that Threads is a known
  engagement surface rather than an absent one.
- **FR-002**: That declaration MUST name both inbound kinds this surface will carry once
  unblocked — replies and mentions — using the same two kind names the Bluesky surface already
  emits, so no filter, label or stored vocabulary anywhere gains a new value.
- **FR-003**: That declaration MUST mark the surface unavailable, with a reason stating that
  Docket cannot yet read Threads replies or mentions because the platform's read endpoints for
  them are not confirmed in official documentation, and a link to the setup documentation.
- **FR-004**: That reason MUST NOT attribute the unavailability to a missing permission, an
  install limitation, or anything the member or operator can fix, because none of those is the
  cause.
- **FR-005**: That declaration MUST NOT name any read permissions, because a declaration marking a
  surface unavailable and one naming read permissions make mutually exclusive claims and a
  declaration asserting both is refused at startup.
- **FR-006**: The confirmed Threads reply and mention permission names MUST remain declared where
  the connect dialog requests them, behind the existing operator opt-in, unchanged by this entry —
  so the permissions an eventual reader needs are still requestable without implying anything is
  read.
- **FR-007**: The declaration MUST state that this platform cannot be replied to through Docket.
- **FR-008**: The send path for Threads engagement MUST return a permanent refusal that is never
  retried, with a message that reads as a platform limitation rather than a fault.
- **FR-009**: The read path for Threads engagement MUST make no outbound request under any
  circumstances, and MUST NOT depend on a Threads endpoint path, field name, pagination shape or
  identity field, none of which is confirmed.
- **FR-010**: No Threads account MUST ever be claimed, leased, have its credentials decrypted, or
  be called for an engagement read while the surface is unavailable.
- **FR-011**: Every value in the Threads declaration MUST trace to a confirmed cell of the
  research file; no endpoint, field, limit or identity shape may come from memory.

#### Honest presentation of an unreadable surface

- **FR-012**: The inbox MUST name a connected Threads account among the accounts that are not
  available for the inbox, with the declared reason and its documentation link, using the same
  presentation already used for unavailable accounts.
- **FR-013**: The inbox's account filter MUST NOT offer a Threads account as a source of items.
- **FR-014**: The accounts view MUST state the same unavailability, consistent in wording with the
  inbox.
- **FR-015**: Where an account is both unavailable and missing a read permission, the
  unavailability MUST take precedence in what the member is told, so nobody is asked to reconnect
  when reconnecting cannot help.
- **FR-016**: A scheduler run MUST account for an unavailable Threads account as unavailable —
  neither a failure nor a successful read — so the tick's own reporting stays truthful.

#### Parentless items are never attributed to a post

- **FR-017**: An inbound item carrying no parent identifier MUST be stored with no parent
  identifier, no parent post and no parent post target.
- **FR-018**: An item with no parent post target MUST contribute to no post's first-engagement
  figure, and a post whose only inbound activity is such an item MUST still report that nothing
  has been observed on it yet.
- **FR-019**: An item with no parent identifier MUST report a count of zero for newer activity on
  the same post, rather than a count of other parentless items.
- **FR-020**: An item with no parent identifier MUST resolve to no post context at all, rather
  than to an empty or placeholder context.
- **FR-021**: An item whose parent identifier resolves to one of the brand's own published posts
  MUST be shown with that post as its context and MUST contribute to that post's first
  engagement — the set case must remain demonstrably different from the null case.
- **FR-022**: An item whose parent identifier resolves to nothing of the brand's own MUST be
  presented as a reference to something that is not one of the brand's posts, distinct from both
  the null case and the resolved case, and MUST contribute to no post's first engagement.
- **FR-023**: Opening an item with no parent MUST state plainly that it is not about one of the
  brand's own posts, rather than omitting the context silently.
- **FR-024**: The guarantees in FR-017 through FR-022 MUST hold for every provider that can emit a
  parentless item, not only for the one being added — they are properties of the shared ingest and
  inbox, not of a provider.

#### Documentation that closes the roadmap

- **FR-025**: The supported-platforms table MUST carry a verdict for every platform and surface
  this roadmap set out to fill, including those still unread, and every unread entry MUST carry
  the reason it is unread.
- **FR-026**: The Threads entry in that table MUST treat replies and mentions as two surfaces,
  name each one's permission, and state that reading is blocked on an unconfirmed endpoint rather
  than on an unobtainable permission.
- **FR-027**: That table's reply and direct-message columns MUST remain honest about what this
  roadmap did not build: no reply sending on any Meta surface, and direct messages unread on every
  platform pending their own research.
- **FR-028**: The engagement permissions documentation MUST state, for the Threads opt-in, that
  granting the permissions does not yet cause anything to be read.
- **FR-029**: The provider guide's engagement section MUST point at a current, real example of a
  per-post reader and a current, real example of an account-level reader, and say which platform
  shape suits which.
- **FR-030**: The provider guide's engagement section MUST explain that marking a surface
  unavailable and declaring read permissions are different claims that cannot both be made, and
  that a surface blocked on an unconfirmed endpoint is the first of those two.
- **FR-031**: The research file's Threads sections MUST record this entry's re-check — its date,
  that official documentation was searched for each surface's endpoint, field list and pagination
  shape, and that the result was unchanged — so the verdict is auditable and the attempt is not
  repeated.
- **FR-032**: The research file MUST name, per surface, which specific facts remain missing, so
  unblocking the reader is bounded work.

#### Evidence

- **FR-033**: Every behaviour in this specification MUST be demonstrated by tests that make no
  live platform call, and MUST be reported as verified with mocks only.
- **FR-034**: The parentless-item guarantees MUST be proven against a stored item, not only
  against a mapping function, so the ingest, the first-engagement pass and the inbox view are each
  covered.
- **FR-035**: The declaration's refusal rules MUST be proven: a Threads declaration that named
  read permissions alongside its unavailability would fail at startup, and the shipped one does
  not.

### Key Entities

- **Threads engagement declaration**: Threads' statement of what it will read (replies and
  mentions), that it cannot be replied to, and that it is not readable yet with the reason —
  naming no read permissions, because unavailability and permission claims are exclusive.
- **Inbound item**: one reply, comment or mention read from a platform. Its parent identifier is
  the platform's own identifier for the thing it is about, and is absent for a mention, which is
  about the brand rather than about one of its posts.
- **Parent context**: what a member is shown about what an item concerns — one of the brand's own
  posts, a reference that is not one of the brand's posts, or nothing at all. These three are
  distinct and must not collapse into each other.
- **First-engagement figure**: the per-post record of when activity was first observed on it.
  Fed only by items attached to that post, so a parentless item never reaches it.
- **Supported-platforms table**: the member-facing statement of which platforms' inbound surfaces
  are read, which are not, and why — the roadmap's closing deliverable.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member with a connected Threads account can tell, within one screen of the inbox
  and without reading documentation or code, that Threads replies and mentions are not read yet
  and why.
- **SC-002**: Across a full scheduler run with Threads accounts connected, the number of outbound
  Threads engagement requests, credential decryptions and claims is zero.
- **SC-003**: A post whose only inbound activity is a mention that is not about it reports no
  observed engagement — the mention changes that post's first-engagement figure in no way.
- **SC-004**: Each of the three parent contexts — the brand's own post, something that is not the
  brand's post, and nothing — produces a visibly different result for a member, with none shown as
  a blank or placeholder.
- **SC-005**: Every platform-and-surface combination this roadmap set out to fill has a stated
  verdict in the supported-platforms table, and every unread one states its reason: zero omissions.
- **SC-006**: Somebody adding a provider can find a current working example of each of the two
  reader shapes from the provider guide alone, in under a minute, with no stale pointer.
- **SC-007**: Somebody picking up Threads engagement later can list the exact facts still needed
  per surface from the research file alone, without searching the web first.
- **SC-008**: No behaviour in this entry is reported as working on the basis of a live call: every
  claim is backed by a test with no network, and is reported as verified with mocks only.

## Assumptions

- **Both Threads surfaces came back unverified, so neither ships a reader.** The feature
  description's own rule — declare an unverified surface unavailable with its reason and ship the
  other — resolves to no reader when applied to both surfaces, which is the case the research
  records. This is treated as the intended outcome of the rule rather than as a question, because
  the description states the rule and the research states the inputs.
- **The endpoints were re-checked while writing this specification, and the verdict held.**
  Official Meta documentation was searched again for each surface's read endpoint path, reply and
  mention field lists, and pagination shape. As in the previous entry, results came back as
  summaries that named the capability ("moderate replies", a "Mentions" guide) and the permissions,
  but quoted no endpoint path, no object field list and no cursor shape for either surface. One
  adjacent fact did surface — a keyword-search example response showing reply-shaped fields — but
  it belongs to a different endpoint and does not confirm a replies-listing read, so it is not
  used. Nothing in this specification rests on it.
- **The "two surfaces, one cursor" page-budget design is deferred with the reader, not dropped.**
  Dividing a run's budget between replies and mentions, holding a position for each, and treating
  the surface as exhausted only when both are, cannot be specified without the two pagination
  shapes it divides and advances — and building a budget splitter with no reader to call it would
  be a guess with no caller. It is named in Out of Scope so the next entry inherits it whole.
  Threads' engagement state shape therefore stays empty while nothing is read.
- **The parentless-item work is in scope because it is not Threads-specific.** Bluesky already
  emits mentions with no parent, so these are live items on a shipped surface; the guarantees are
  properties of the shared ingest and inbox and are provable today through existing providers and
  the mock. This is the half of the entry's named design work that the research does not block.
- **The current behaviour is believed correct but unproven, and that is the gap.** Parentless items
  already avoid attribution by construction in ingest, first-engagement and the same-post count;
  this entry's value there is proving it and making the member-facing silence explicit, not
  rewriting it. Where proving it reveals a defect, the defect is fixed here.
- **The two reader shapes the provider guide should point at** are the shared Meta per-post comment
  sweep the previous entry built, and the account-level Bluesky notification reader — those being
  the only real implementations of each shape in the tree.
- **The existing operator opt-in for Threads engagement permissions stays as it is.** It was
  shipped by the scope-gate entry, requests the two confirmed permissions, and defaults off; this
  entry only ensures the documentation does not imply it starts any reading.
- **No schema change, no scheduler change and no new vocabulary.** The kinds already exist, the
  parent columns already exist and already allow absence, and the unavailable path already exists;
  this entry adds a provider member, proves shared behaviour, adjusts one piece of item
  presentation, and finishes the documentation.

## Out of Scope

- **A working reader for Threads replies or Threads mentions.** Blocked on confirming each
  surface's read endpoint, author identity shape and pagination shape. This is the entry's intended
  deliverable and it is explicitly deferred, not abandoned: the declaration shipped here is the
  seam it drops into.
- **The per-surface page-budget division and the dual cursor position** ("two surfaces, one
  cursor"), deferred with the reader for the reason given in Assumptions.
- **Revisiting Facebook Pages or Instagram comment reading**, which the previous entry shipped.
- **Sending a reply on any Meta surface** — Facebook, Instagram or Threads — which no entry in this
  roadmap builds and for which the research's reply-capability answers are recorded only.
- **Comment moderation** of any kind: hiding, unhiding, deleting or reporting.
- **Direct messages on any platform**, which remain blocked on their own unverified research.
- **Changing the inbox beyond the parentless-item statement** and a provider appearing in the
  existing unavailable notice and filter.
- **Any live platform call**, in tests or otherwise.
