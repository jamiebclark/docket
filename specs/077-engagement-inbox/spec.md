# Feature Specification: Comment and message engagement

**Feature Branch**: `077-engagement-inbox`

**Created**: 2026-10-15

**Status**: Draft

**Input**: User description: "Comment and message engagement: ingest inbound replies, comments, mentions and DMs from connected accounts, draft responses in the project's brand voice, and route them through the existing Review queue and approval policy so nothing is ever sent unreviewed. Bluesky first since it needs no app review and app-password auth already works; Meta surfaces (Instagram comments, Threads replies, Facebook Page comments) behind the additional Standard Access scopes. Begin with a spike confirming commenter identity survives Standard Access before designing around it."

## Context and sources

- **This entry changes the product's stated scope.** `docs/build-prompt.md` line 280 and the constitution's Engineering Constraints both list "comment or inbox management" as out of scope *until a spec says otherwise*. This is that spec. Governance says the build prompt wins on product behaviour, so both documents must be amended in this entry rather than silently contradicted.
- **Product behaviour already settled**: `docs/build-prompt.md` "Generator" and "Review" — the project's voice profile and brand identity are the single source of what the brand sounds like, a generated draft is never published without passing the approval policy, and a validation failure forces review even under auto-approve.
- **Judgement calls already logged**: `docs/decisions.md` — "a missed post beats a duplicate post" (ambiguous outcomes are never retried automatically); the credit-hold rule (a billing refusal from the LLM provider sets a hold and every other outcome clears it); 041's external-item claim ledger ("one source record has become a post", never updated, never deleted); and the 2026-10-15 migration rule about enum labels added in the same batch (see constraint 4 below).
- **What already exists and is reused rather than reimplemented** (constitution IV):
  - `src/server/services/review.ts` — the one implementation of a review decision: `listReviewQueue`, `countReviewQueue` (the nav badge), `approvePost`, `rejectPost`, `bulkApprove`, the `serialized()` same-process decision gate, the `lockPost` row lock, the `alreadyReviewed` refusal, `REJECT_REASON_MAX`, and the `reviewState`/`reviewedAt`/`reviewedByUserId`/`rejectionReason` record of who decided what and when.
  - `src/app/p/[projectSlug]/review/` — the Review screen, `ReviewList.tsx` and `review-logic.ts`.
  - `src/server/db/schema/policy-enums.ts` — `approval_policy` (`review_required` | `auto_approve`) and `scheduling_policy`, plus `projects.default_approval_policy`.
  - `src/server/services/generation/` — `prompt.ts` (which already carries `BrandContext`: the project's `tagline`, `description` and `websiteUrl` from 069, placed ahead of the voice profile), `core.ts`, `credit.ts` (`withCreditHold`, `applyCreditOutcome`), `policy.ts`, `check.ts`.
  - `src/server/db/schema/generation.ts` — `voice_profiles` and the immutable `voice_profile_versions`, so a draft can record the exact voice version it was written from, as a generated post already does.
  - `src/providers/types.ts` — the `SocialProvider` contract: declared `capabilities`, `settingsSchema`, `connect`, `refreshCredentials`, `validate`, `stepFor`/`advance` returning continue / done / retryable_error / fatal_error / ambiguous, and `accountNotes`.
  - `src/providers/bluesky/` — `session.ts` (persisted sessions, serialised refresh, `ConcurrentRefreshError`), `client.ts`, `facets.ts`, `errors.ts`, `pds-host.ts`, `publish.ts`.
  - `src/server/scheduler/` — `runTick()`, the one bounded, concurrency-safe, kill-safe unit of background work, claiming rows with `FOR UPDATE SKIP LOCKED` plus a lease column.
  - `src/server/db/schema/activity.ts` and `src/lib/activity/outcomes.ts` — the append-only activity log and its `ACTIVITY_KINDS`/`KIND_OUTCOME` pairing.
  - `src/server/db/schema/notifications.ts` — `notification_states` (one reading position per membership), `notification_preferences` (per-kind and per-platform switches) and the per-event read/snooze table, plus `src/server/services/notifications/` with its stream and email delivery (043, 044, 045).
  - `src/server/db/schema/external-claims.ts` — `external_item_claims`, the existing shape for "this external record has already been turned into something here", keyed `(project_id, source_key, external_id)`.
  - `src/server/auth/access.ts` — the `statements` table and the `owner`/`admin`/`editor` roles.
  - `src/server/dal/` — the scoped data-access layer every caller must go through (constitution III).
  - `tests/integration/security/secret-scan.test.ts` — the scan every new response path must pass.

### Constraints found while specifying (recorded for planning)

1. **No engagement facts exist in `docs/research/`.** There is no `docs/research/engagement.md`. `docs/research/bluesky.md` covers posting, auth, facets and write rate limits but says nothing about reading notifications, replies or threads, and nothing about direct messages. `docs/research/meta.md` covers publishing, Standard Access and setup but names no comment-reading endpoint, no comment or messaging permission, no webhook field, and nothing about what identity a commenter carries. Constitution I forbids taking any of it from memory. **`NEEDS RESEARCH: docs/research/engagement.md`** — for each platform in scope: how inbound items are read, what identity fields come back, which permission each read and each reply needs, whether replying is permitted at the same access level as reading, how results are paginated, and what the read rate limits are. User Story 1 *is* that research.
2. **The identity spike cannot be run by a pipeline phase.** Confirming what a real Facebook Page comment, a real Instagram comment and a real Threads reply actually return on Standard Access needs a live Meta app, a real Page, a real Instagram Business account, a real commenter and a browser. Constitution II forbids reporting it settled on the strength of mocks. The spike is therefore a **human task**, and it gates only the Meta stories (US4). Everything in US2 and US3 is independent of it and must be built and verified without waiting on it. Task ordering must place the human task last even though it is first in risk order, or the implement loop starves behind it.
3. **A reply is not a post, but its approval must be the same approval.** Constitution IV says approval policy has exactly one implementation. A reply draft has no slots, no scheduling policy, no per-platform variants and no media; modelling it as a `posts` row to reuse the queue would distort both. The resolution is in Decisions: the review *decision path* is shared, and the queue *listing* gains a second item kind.
4. **Adding an activity kind is a migration landmine.** `activity_events.kind` is a Postgres enum, and the `activity_events_kind_outcome` CHECK is built by string interpolation from `ACTIVITY_KINDS` (`src/server/db/schema/activity.ts:11,47`) as bare `kind = 'label'` comparisons. Adding an engagement kind means `ALTER TYPE ... ADD VALUE` plus a regenerated CHECK comparing the column to the label just added — the exact 55P04 "unsafe use of new value" failure recorded in `docs/decisions.md` on 2026-10-15, which a fresh database is exempt from and so CI would not catch. Any new label must be compared as `kind::text`, and `tests/integration/db/enum-value-in-batch.test.ts` must stay green.
5. **The notification kind switch is a closed list.** `notification_preferences_kind_key` permits only `('failed', 'ambiguous', 'needs_reauth', 'connect_failed')`, and `switch_key` must match `^[a-z0-9_-]{1,40}$`. An engagement kind needs that CHECK widened. It is a text column, not an enum, so constraint 4 does not apply to it.
6. **Replying competes with publishing for the same per-account budget.** Verified in `docs/research/bluesky.md`: writes cost 5,000 points/hour and 35,000/day *per account, shared with every other app writing to it*, and a `createRecord` costs 3 points. A reply is a `createRecord`. A burst of replies therefore spends the same allowance scheduled posts need, and that allowance is not Docket's alone. Publishing must win.
7. **Drafting spends the project's LLM budget.** Every draft is a model call, billed to the project's own LLM credential (065) and subject to the existing credit hold (043). A single popular post can draw far more comments than a project draws posts in a week, so drafting cannot be unconditional. See Decisions.
8. **No new infrastructure is available.** Constitution VI fixes the stack and the deployment to web, worker and postgres; `runTick()` must stay well under 30 s, safe to run concurrently and safe to kill mid-run; and Neon's transaction-mode pooler rules out `LISTEN` and advisory locks. Polling inside `runTick()` is the only mechanism available without a justified exception.
9. **Inbound content is other people's personal data.** Today every row Docket stores is content its own users wrote. An inbound item is a third party's words, handle and display name, stored without that person's involvement. `docs/privacy.md` says only that deleting a project or a post deletes its content; it has nothing to say about this, and must.
10. **Bluesky's reply length limit is the post limit.** Verified in `docs/research/bluesky.md`: `app.bsky.feed.post` text is capped at **300 graphemes and 3,000 UTF-8 bytes**, both applying. A reply is an `app.bsky.feed.post`, so a drafted reply is subject to the provider's existing declared `capabilities.text` and existing counting rule — no new limit logic.

## Decisions made while specifying

Each is a judgement call to be appended to `docs/decisions.md`, and each is reversible.

- **Nothing is ever sent without a person having read it. `auto_approve` does not apply to replies.** The project's approval policy still governs *posts*; a reply is always `review_required`, whatever the project's default is and whatever permissions a key holds. A scheduled post is the brand talking to nobody in particular at a time the brand chose; a reply is the brand answering a named human about something it has not read. Auto-approving the second is a different and much worse failure. The approval *mechanism* is shared — the same row lock, the same one-decision-per-item rule, the same reviewer record, the same already-decided refusal — but the policy input is pinned. This is the direct reading of "so nothing is ever sent unreviewed" and it is why the entry is safe to ship before anyone trusts the drafting.
- **Nothing sends on a timer, through the API, or over MCP.** There is no scheduled send, no "send in 5 minutes unless you object", no API operation that sends a reply and no MCP tool that does. A reply leaves Docket only as the direct result of a signed-in member with the right role approving it on the Review screen. Sending is the one capability in the product deliberately *not* exposed to any non-human caller.
- **The review decision path is shared; the queue listing gains a second item kind.** Reply drafts are not `posts` rows (constraint 3). The Review screen lists two kinds of item — posts awaiting review and replies awaiting review — the nav badge counts both, and both decisions go through one shared decision core that provides the locking, serialisation, "already decided" refusal and reviewer record. This keeps constitution IV's "approval policy has exactly one implementation" literally true without pretending a reply is a post.
- **Bulk approve does not apply to replies; bulk dismiss does.** `bulkApprove` exists so somebody can clear a week of generated posts they have skimmed. A reply is to one named person about one specific thing, and the point of the entry is that somebody read it. Replies may be dismissed in bulk (nothing is sent) but never approved in bulk.
- **Drafting is on request only; the opt-in per-account auto-draft is cut.** Constraint 7: drafting every inbound item would spend the project's LLM budget in proportion to other people's activity rather than the project's own. So an item arrives with no draft; a reviewer asks for one, and may ask for another. An earlier version of this entry additionally specified a per-account auto-draft switch that would pre-draft arriving items from the tick. That half is cut: the job-runner scope the tick runs under is deliberately denied `engagement` (data-model.md §9), so "pre-draft from the tick" has no scope to run under without first deciding whether to carve out a job-runner exception — a separate decision this entry does not make. The `auto_draft` column, its repo method and its account-view field were removed rather than shipped half-built. On-request drafting is unaffected and remains subject to the credit hold below.
- **Items are polled in `runTick()`; no webhooks, no new infrastructure.** Constraint 8. Each connected account that supports engagement carries its own cursor and its own lease, claimed the way publishing work is claimed, so polling is concurrency-safe, kill-safe and bounded. Webhooks are not ruled out for ever — they are ruled out *here*, because for Meta they are part of the same app-review question the spike exists to answer, and they would need an inbound public endpoint the self-hosted deployment does not assume.
- **Publishing always wins the write budget.** Constraint 6. Within one tick, scheduled publishing is claimed and spent first; sending approved replies uses what is left, under a per-account reserve that keeps a floor of the hourly allowance for publishing. A reply that cannot be sent this tick waits and is retried, and the person who approved it sees it as waiting rather than as sent.
- **A send of unknown outcome is ambiguous and is never retried automatically.** Constitution V's rule, applied unchanged: a duplicate reply to a real person reads worse than a late one. An approved reply whose send times out or answers unclearly is recorded as needing a human decision, exactly as an ambiguous publish is, and appears in the existing failures surface rather than in a retry loop.
- **Sending is idempotent on the item, not on the attempt.** A ledger entry in the shape of 041's `external_item_claims` records "this inbound item has been replied to", written in the same transaction that records the send. A second send for the same item is refused by the ledger rather than by a timing assumption.
- **Ingest is idempotent on the platform's own identifier.** An item already stored is never stored twice, never re-notified, and never silently rewritten: the stored copy of what somebody said is immutable, so a reviewer always sees the text the draft was written against. If the platform reports the original edited or deleted, that is recorded beside the item as a new fact — the item is marked withdrawn or edited-upstream — and a pending draft for it is blocked from sending until the reviewer looks again.
- **Docket never decides an item does not deserve an answer.** No spam classifier, no sentiment gate, no automatic hiding. Everything the platform returns is shown; a person dismisses what does not need a reply, and a dismissal is recorded with who did it. Judging strangers' messages on a brand's behalf is not a decision this entry makes.
- **No moderation actions.** Hiding, deleting, liking or reporting a comment, and blocking its author, are out of scope. This entry reads inbound items and sends replies. Moderation is recorded as a gap for a later entry; it needs its own permissions on every platform and its own irreversibility story.
- **Engagement is a provider capability, declared, with no per-provider change elsewhere.** Constitution V. A provider opts in by declaring which inbound kinds it can read and whether it can send a reply, and by implementing the read and the send; the inbox, the drafting, the queue, the notifications and the activity log do not learn any provider's name. A provider that declares nothing is simply absent from the inbox, which is how every provider other than Bluesky starts.
- **One new permission statement, `engagement`, with `view` and `reply`.** Viewing the inbox is a read of third parties' personal data, and sending a reply speaks as the brand to a named person; neither is well described by `post: ['view']` or `post: ['schedule']`. Owners and admins get both. Editors get `view` and `reply`, because answering comments is the everyday work an editor is trusted with and an editor can already publish posts.
- **No API or MCP surface in this entry.** 074's rule is that a capability worth driving over MCP with no endpoint belongs in an API entry first. Reading the inbox over the API is plausible and is recorded as a gap; *sending* over the API is refused on purpose, per the second decision above. Keeping the API untouched also keeps the enumerated-surface tests (`tests/integration/api/scope-enforcement.test.ts` and the operations table) green with no edits.
- **Direct messages are specified here and implemented last, gated on research.** The user named DMs and they are modelled as a first-class inbound kind rather than dropped, but no platform's DM facts exist in `docs/research/` (constraint 1), Meta messaging permissions are not in the Standard Access set the user named, and private correspondence carries a different data-protection profile from a public comment. US5 specifies the behaviour; it must not be built until the research lands. The scope is sequenced, not cut.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Settle what a commenter actually is, before designing around it (Priority: P1)

Before any Meta engagement surface is designed, somebody with a live Meta app, a real Facebook Page, a real Instagram Business account and a real Threads account has another person comment on each, reads those comments back on Standard Access, and writes down exactly what came back: which permission each read needed, what identity fields the commenter carried, whether the same person is recognisable across two comments, and whether a reply can be sent at the same access level the read required. The findings land as a committed research document with cited sources and an explicit verdict per question, and the consequences land as a logged decision. Where a question cannot be answered from official documentation plus the live observation, it is written down as unverified rather than assumed.

**Why this priority**: The user asked for it first and it is the entry's largest unknown. If a commenter arrives with no stable identity, the Meta inbox is a list of anonymous fragments and its whole presentation changes — a design built on an assumed handle would have to be torn out. It is also the one story whose output is useful even if nothing else ships, because it tells the project whether the Meta half of this entry is worth building at all.

**Independent Test**: `docs/research/engagement.md` exists, is dated, cites official sources per claim, and carries a stated verdict (confirmed / contradicted / unverified) for each question in FR-001; `docs/decisions.md` carries the resulting decision. Reviewable with no code.

**Acceptance Scenarios**:

1. **Given** a Business-type Meta app on Standard Access with a role user's Page, Instagram Business account and Threads account connected, **When** a second person comments on a Page post, comments on an Instagram post and replies to a Thread, **Then** each comment is read back through the platform's API and what it returned is recorded field by field.
2. **Given** those readings, **When** the findings are written up, **Then** the document states for each surface which permission the read required, whether that permission is inside the Standard Access set a Business app gets automatically or needs App Review, and the source for that claim.
3. **Given** those readings, **When** identity is assessed, **Then** the document states whether a display name, a handle, a stable identifier and a profile link are each present or absent, and whether the identifier is stable across two comments by the same person on the same surface.
4. **Given** those readings, **When** replying is assessed, **Then** the document states whether a reply to a comment can be sent on the same access level the read required, or needs a further permission.
5. **Given** a question that neither the live observation nor an official page answers, **When** it is written up, **Then** it is marked unverified with what was tried, and never presented as settled.
6. **Given** the finished document, **When** US4 is planned, **Then** every identity field US4 relies on traces to a confirmed verdict in it, and no Meta behaviour is specified on an unverified one.

---

### User Story 2 - Inbound engagement arrives and a person sees it in context (Priority: P2)

A brand's Bluesky account gets replies to its posts and mentions from people it has never posted about. Without anyone going to Bluesky, those land in Docket on their own, in a project-scoped inbox: who said it, what they said, when, which account it came to, and which of the brand's posts it answers — with the brand's own post shown beside it so the comment can be read in context. New arrivals raise the same kind of attention the project already uses for publishing problems, honouring each person's existing per-kind and per-platform notification switches, and the unread count behaves like every other count in the product.

**Why this priority**: It is the half of the entry that works with no app review, no LLM spend and no send path, and it is the half that has to be right before drafting is worth anything — a draft written against a comment Docket read wrongly is worse than no draft. It delivers real value alone: somebody who never approves a single drafted reply still stops having to check Bluesky by hand.

**Independent Test**: With a connected Bluesky account and mocked platform HTTP, run the tick against a fixture containing replies and mentions, and confirm the inbox shows each one once with its author, text, time, account and parent post; run the tick again against the same fixture and confirm nothing is duplicated and nothing re-notified; run it with a second project's data present and confirm nothing crosses.

**Acceptance Scenarios**:

1. **Given** a connected Bluesky account with two replies and one mention waiting, **When** the tick runs, **Then** three items appear in that project's inbox, each with its author's display name and handle, its text, when it was said, the account it arrived at, and — for the replies — the brand's post it answers.
2. **Given** that same tick has already run, **When** it runs again with the platform returning the same items, **Then** the inbox still shows three items, no notification is raised a second time, and no stored text changes.
3. **Given** an item in the inbox, **When** a member opens it, **Then** the brand's own post it replies to is shown beside it, so the comment can be read without leaving Docket.
4. **Given** a member whose notification switch for engagement is off, **When** items arrive, **Then** they appear in the inbox and raise no notification for that member, while a member with it on is notified.
5. **Given** two projects each with a Bluesky account, **When** the tick runs, **Then** no item from one project is visible or countable in the other, and the cross-project scope test covers the inbox.
6. **Given** an account whose credentials have expired, **When** the tick tries to read it, **Then** the account is flagged as needing reconnecting exactly as a failed publish flags it, no item is lost, and reading resumes from the same cursor once it is reconnected.
7. **Given** a provider that declares no engagement capability, **When** the inbox is shown, **Then** its accounts are absent from the inbox with no error and no empty section implying something is broken.
8. **Given** an item whose original comment is deleted upstream, **When** the tick next reads that surface, **Then** the item is marked withdrawn, still readable, and no longer replyable.

---

### User Story 3 - A reply is drafted in the brand's voice, read, and only then sent (Priority: P2)

A member opens an inbound reply, asks Docket for an answer, and gets one written in the project's brand voice — from the same voice profile and the same brand identity a generated post uses, plus the account's posting instructions, the brand's original post and the comment itself. They read it, edit it if they want, and approve it; it goes out as a reply on the platform within the minute, and the thread in Docket shows what was sent and who sent it. If they do not like it they ask for another, or write their own, or dismiss the item. Nothing leaves Docket until somebody has approved it, and the project's auto-approve setting makes no difference to that.

**Why this priority**: It is the entry's point. It is deliberately second because it is only trustworthy on top of a correct inbox, and it is independently testable once the inbox exists.

**Independent Test**: With a connected Bluesky account, a voice profile and an item in the inbox, request a draft (mocked LLM) and confirm the prompt carried the voice profile, the brand identity, the posting instructions, the brand's post and the comment; confirm the draft is counted against the provider's declared text limit under its own counting rule; approve it and confirm one reply was sent to the right parent with the right text; confirm a second approval of the same item is refused; and confirm that with the project set to auto-approve, the item still waits for a person.

**Acceptance Scenarios**:

1. **Given** an inbound item and a project with a default voice profile, **When** a member asks for a draft, **Then** a reply draft is produced in the brand's voice, the voice profile and version it was written from is recorded against it, and the LLM spend is attributed to the project as generation spend already is.
2. **Given** that draft, **When** it is shown, **Then** it is counted against the platform's own text limit using the platform's own counting rule, and a draft that exceeds it is shown as blocking rather than silently truncated.
3. **Given** that draft, **When** the member edits the text and approves it, **Then** the text that is sent is the edited text, and the thread records the sent text, the time and the member who approved it.
4. **Given** a sent reply, **When** the platform accepts it, **Then** it appears on the platform as a reply to the right comment, the item is marked replied, and the activity log carries an engagement-replied event for that account.
5. **Given** an item that has been replied to, **When** anybody tries to approve a second reply for it, **Then** it is refused with a message saying it has already been answered, and nothing is sent.
6. **Given** two members approving the same reply draft at the same instant, **When** both decisions land, **Then** exactly one reply is sent, the other is refused as already decided, and the ledger shows one send.
7. **Given** a project whose default approval policy is `auto_approve`, **When** a draft is produced, **Then** it waits for a person exactly as it would under `review_required`, and no configuration anywhere makes it send itself.
8. **Given** a member with the engagement view permission but not reply, **When** they open the inbox, **Then** they can read items and drafts and cannot request a draft, approve one or send anything, and the refusal is enforced on the server.
9. **Given** an approved reply whose send times out, **When** the outcome is unknown, **Then** it is recorded as needing a human decision, it is not retried automatically, and it is surfaced the way an ambiguous publish is.
10. **Given** an account at its hourly write allowance, **When** scheduled posts and approved replies both want to be sent, **Then** the scheduled posts are sent and the replies wait, and the waiting replies are shown as waiting rather than as sent or failed.
11. **Given** a project under an LLM credit hold, **When** a member asks for a draft, **Then** they get the existing billing refusal, and no empty or partial draft is stored.
12. **Given** a member who dismisses an item, **When** they confirm, **Then** nothing is sent, the item is recorded as dismissed with who dismissed it, and it leaves the queue without leaving the inbox.

---

### User Story 4 - The Meta surfaces, on what the spike actually found (Priority: P3)

With US1's findings committed, Instagram comments, Threads replies and Facebook Page comments join the same inbox, the same drafting and the same review path, presented using only the identity the spike confirmed each surface returns. Where a surface returns a stable handle, the inbox shows it. Where it returns a name with no stable identifier, the inbox says so plainly and does not imply a person it can recognise again. Where a permission the spike found to be outside Standard Access would be needed, that surface is shown as unavailable with the reason, rather than failing at the moment somebody tries to use it.

**Why this priority**: It is the larger audience but the gated half: it depends on US1, needs live Meta credentials the pipeline does not have, and cannot be specified further than the research allows. It is independently testable per surface with mocked HTTP once the research fixes the shapes.

**Independent Test**: Per surface, with mocked platform HTTP shaped from the committed research, confirm items arrive once with exactly the identity fields the research confirmed; confirm a surface whose permission the research found unavailable is presented as unavailable with its reason and never attempted; confirm a drafted reply sends to the right parent and is idempotent on the item.

**Acceptance Scenarios**:

1. **Given** US1's findings, **When** a Meta surface is built, **Then** every identity field it displays traces to a confirmed verdict in `docs/research/engagement.md`, and no field is displayed on an unverified one.
2. **Given** a connected Instagram Business account with a comment on one of its posts, **When** the tick runs, **Then** the comment appears once in the inbox with its author as the research says it arrives, and the brand's post beside it.
3. **Given** a connected Facebook Page and Threads account, **When** the tick runs, **Then** Page comments and Thread replies arrive on the same terms, each attributed to the account it came to and the platform it came from.
4. **Given** a surface whose read or reply permission the research found to be outside Standard Access, **When** the inbox is shown, **Then** that surface is marked unavailable with the reason and a link to the setup documentation, and no call is made that would fail.
5. **Given** a commenter whose identifier the research found not to be stable, **When** two of their comments arrive, **Then** the inbox presents them as two comments and never claims they are the same person.
6. **Given** a drafted reply to a Meta comment, **When** it is approved, **Then** it is sent as a reply to that comment, recorded in the ledger, and a second approval for the same item is refused.
7. **Given** a Meta read that answers with a rate-limit refusal, **When** the tick handles it, **Then** it backs off, loses no item, and resumes from the same cursor.

---

### User Story 5 - Direct messages, once their facts are known (Priority: P4)

A direct message to a connected account arrives in the same inbox as a public comment, marked as private, and is answered through the same read-then-approve path. It is visually distinct from a public comment at every point where somebody might confuse the two, because a reply to a DM goes to one person and a reply to a comment is published where anyone can read it. Nothing about a DM is drafted, shown or sent until the platform facts behind it are researched and committed.

**Why this priority**: The user named DMs, so they are specified rather than dropped. They are last because no DM facts exist in `docs/research/` for any platform (constraint 1), Meta messaging permissions sit outside the Standard Access set this entry assumes, and private correspondence needs its own retention and disclosure decision. Building it on memory would breach constitution I.

**Independent Test**: Blocked until `docs/research/engagement.md` carries a confirmed verdict on DM reading, DM replying and the permission each needs, per platform. Thereafter: with mocked HTTP, confirm a DM arrives marked private, is never presented as a public comment, and sends to the conversation it came from, idempotently.

**Acceptance Scenarios**:

1. **Given** no committed research on a platform's direct messages, **When** this story is planned, **Then** it is recorded as blocked and no DM reading, drafting or sending is implemented for that platform.
2. **Given** committed research confirming DM reading for a platform, **When** a direct message arrives, **Then** it appears in the inbox marked private, with the sender as the research says it arrives, and is never shown as a public comment.
3. **Given** a drafted reply to a direct message, **When** it is shown for review, **Then** the reviewer is told plainly that it will be sent privately to that one person, and not published.
4. **Given** an approved reply to a direct message, **When** it is sent, **Then** it goes to that conversation only, is recorded in the ledger, and a second approval for the same item is refused.
5. **Given** a platform whose DM permission the research found to need App Review, **When** the inbox is shown, **Then** direct messages for that platform are marked unavailable with the reason, and no call is made.

---

### Edge Cases

- **A thread that grows while a draft is pending.** The item the draft answers is fixed; later comments arrive as their own items. The reviewer sees how many newer comments exist on the same post, so they can tell a stale answer from a current one.
- **A reply to a reply Docket sent.** It arrives as a new inbound item answering Docket's own reply. The brand's own sent text is shown as the parent, not the original post, so the conversation reads in order.
- **An inbound item on a post Docket did not publish.** The brand posted it from the platform directly. The item still arrives, attributed to the account, with the parent identified by the platform's own reference and no claim that Docket wrote it.
- **The same person comments on several accounts in the project.** Each arrives as its own item on its own account. Nothing is merged across platforms, because no platform identifier means the same thing as another's.
- **A comment Docket already stored is edited upstream.** The stored copy is never rewritten. The item is marked edited-upstream with when that was noticed, and a pending draft for it is blocked from sending until the reviewer looks again — so nobody sends an answer to a question that has changed.
- **An extremely long inbound comment**, or one longer than Docket's own column allows. The stored text is bounded and what was cut is stated; the item is never dropped for being long, and the draft prompt is given the bounded text, not a silently truncated one.
- **An inbound comment with no text at all** — an image-only or sticker-only reply. It arrives, is shown as having no text, and a draft may not be requested for it, because there is nothing to answer.
- **A comment whose author has been deleted or blocked** on the platform. It arrives with whatever identity remains, is marked as having no reachable author, and is not replyable.
- **A burst far larger than a tick can read** — thousands of comments after a post goes wide. The tick reads a bounded page per account per run, keeps its cursor, stays well under 30 s, and catches up over later ticks. Nothing is skipped and the oldest unread is read first.
- **Two ticks overlapping on one account.** The second finds the account's lease held and moves on, exactly as publishing work does. No item is read twice and no cursor goes backwards.
- **A tick killed mid-read.** The lease expires and the next tick resumes from the last committed cursor. Items already stored are not re-notified.
- **The platform's cursor is rejected or expires.** Reading restarts from the newest page, the gap is recorded against the account so somebody can see reading was interrupted, and no stored item is duplicated when the overlap is re-read.
- **An account disconnected with pending drafts.** The drafts become unsendable and say why; the items remain readable. Reconnecting the same account makes them sendable again; the stored credentials are gone either way.
- **An account removed from the project, or the project deleted.** The account's items, drafts and ledger entries go with it, and nothing survives in another project's view.
- **A reviewer approves a reply to an item whose account has since lost the reply permission** (a scope revoked on the platform). The send fails as a plain refusal naming the permission, is not retried blindly, and the account is flagged.
- **An approved reply the platform refuses as a duplicate.** Treated as already answered rather than as a failure: the ledger is the authority on whether Docket sent it, and the item is marked replied.
- **A draft requested twice in quick succession.** Two drafts exist and both are shown with the time each was written; only one can be approved, and approving one discards the other.
- **A draft requested by one member and approved by another.** Allowed and recorded: the thread shows who asked for it and who approved it, because they are different acts.
- **The project has no voice profile.** A draft cannot be requested and the reason says so, pointing at the voice screen, rather than producing something in no particular voice.
- **The project has no LLM credential configured.** The same not-configured refusal generation already gives, with no partial draft stored.
- **A model answer that comes back empty, or longer than the platform allows.** Nothing unsendable is stored silently: an empty answer is a failed draft the member can retry, and an over-long one is stored and shown as blocking so the member can cut it themselves.
- **A reviewer who deletes all the draft's text and approves.** Refused: an empty reply is not sent.
- **Notification preferences that pre-date this entry.** A member who has never touched the engagement switch is treated as having it on with no position of its own, exactly as the existing per-kind switches behave, and items that arrived before the switch existed do not retroactively notify.
- **A member with no engagement permission.** The inbox is absent from their navigation, its count is not computed for them, and a direct link to it refuses rather than revealing a count.

## Requirements *(mandatory)*

### Functional Requirements

**The identity spike (US1)**

- **FR-001**: A committed research document MUST record, per Meta surface (Facebook Page comments, Instagram comments, Threads replies), a stated verdict of confirmed, contradicted or unverified for each of: how inbound items are read; which permission the read requires and whether it is inside the Standard Access set a Business app receives automatically; what identity fields a commenter carries (display name, handle, identifier, profile link); whether that identifier is stable across two comments by the same person; whether a reply can be sent at the access level the read required; how results are paginated; and what the read rate limits are. Each claim MUST cite its source.
- **FR-002**: The document MUST be produced from live observation on a real Standard Access app with real comments, not from mocks and not from memory, and MUST state the date it was checked.
- **FR-003**: A question the live observation and official documentation do not settle MUST be recorded as unverified, with what was tried, and MUST NOT be presented as settled.
- **FR-004**: The consequences for the design — in particular whether the Meta surfaces can present a recognisable person at all — MUST be recorded in `docs/decisions.md`.
- **FR-005**: No Meta behaviour in this entry may depend on an identity field whose verdict is not confirmed. A test or review check MUST make this traceable: every identity field the Meta surfaces display maps to a confirmed verdict.

**Ingesting inbound items**

- **FR-006**: The system MUST read inbound engagement for each connected account whose provider declares the capability, without any user action, and make it available in that project only.
- **FR-007**: Reading MUST happen inside the existing scheduler tick, MUST claim each account's reading work with the same row-claiming and leasing discipline publishing work uses, MUST be safe to run concurrently and safe to kill mid-run, and MUST keep the tick inside its existing 30-second bound.
- **FR-008**: Reading MUST be bounded per account per run and MUST carry a per-account cursor, so a volume larger than one run can read is caught up over later runs with nothing skipped and nothing read twice.
- **FR-009**: An inbound item MUST be identified by the platform's own identifier for it, and storing the same identifier twice for the same account MUST NOT create a second item, a second notification or a second draft.
- **FR-010**: The stored text and author of an inbound item MUST be immutable once stored, so a reviewer always sees the text a draft was written against.
- **FR-011**: When the platform reports an item's original edited or deleted, that MUST be recorded beside the item as a new fact; a deleted item MUST become unreplyable, and an edited item with a pending draft MUST be blocked from sending until a reviewer looks again.
- **FR-012**: Every inbound item MUST record which project, which connected account and which platform it arrived through, MUST carry `project_id`, and MUST be reachable only through the scoped data-access layer.
- **FR-013**: An inbound item MUST record what it is a reply to, and where the parent is a post Docket published, the inbox MUST show the brand's own text beside the comment.
- **FR-014**: A failure to read one account MUST NOT stop the others, MUST NOT advance that account's cursor, and MUST surface as the kind of problem the product already surfaces: expired or rejected credentials flag the account for reconnecting, a rate-limit refusal backs off, and a persistent failure is visible against the account.
- **FR-015**: Reading MUST NOT require any new infrastructure, inbound public endpoint, webhook registration, queue or session-level database feature.

**Identity and presentation**

- **FR-016**: An inbound item MUST be presented with whatever identity the platform actually supplies and no more. The system MUST NOT invent, infer or fill in a display name, handle or profile link.
- **FR-017**: Where a platform supplies no stable identifier for an author, the system MUST NOT present two items as being from the same person, and MUST say plainly that it cannot tell.
- **FR-018**: Identity MUST NOT be merged across platforms or across accounts; each item stands on the identity of the surface it came from.

**Drafting a reply**

- **FR-019**: A member with the reply permission MUST be able to request a drafted reply for an inbound item, and MUST be able to request another.
- **FR-020**: A draft MUST be written from the project's brand voice: the project's voice profile, the project's brand identity (tagline, description, website), the account's posting instructions, the brand's own parent content where known, and the inbound item's text.
- **FR-021**: A draft MUST record the voice profile and the immutable voice version it was written from.
- **FR-022**: Drafting MUST NOT run automatically for an item. *(The opt-in per-account auto-draft switch originally specified here is cut — see Decisions, "Drafting is on request only".)*
- **FR-023**: Drafting MUST be billed as the project's own LLM spend, counted where generation spend is already counted, and MUST be subject to the existing credit hold: an on-request draft MUST receive the existing billing refusal when the project is under a hold.
- **FR-024**: A failed, empty or refused draft MUST NOT store a partial draft, and MUST tell the member what happened.
- **FR-025**: A draft MUST be measured against the sending platform's own declared text limit using that platform's own counting rule, and a draft exceeding it MUST be shown as blocking rather than truncated.
- **FR-026**: A member MUST be able to edit a draft before approving it, and MUST be able to write a reply with no draft at all.
- **FR-027**: A draft MUST NOT be requestable for an item with no text to answer, nor for an item that is withdrawn, nor for an account that cannot send a reply.

**Review and approval — nothing is sent unreviewed**

- **FR-028**: A reply MUST leave Docket only as the direct result of a signed-in member holding the reply permission approving it. There MUST be no scheduled send, no delayed send, no send on a timer, and no path by which an unapproved reply is sent.
- **FR-029**: The project's approval policy MUST NOT be able to auto-approve a reply. A project set to `auto_approve` MUST still require a person for every reply, and a test MUST assert this.
- **FR-030**: No API operation and no MCP tool may send a reply, request a draft that would be sent, or approve one. A test MUST assert that the API operation surface is unchanged by this entry.
- **FR-031**: Reply drafts awaiting a decision MUST appear in the existing Review surface alongside posts awaiting review, and the existing review count MUST include them.
- **FR-032**: Post review and reply review MUST share one decision implementation, providing for both: a row lock, same-process serialisation of competing decisions, a refusal when the item has already been decided, and a record of which member decided what and when. There MUST NOT be a second implementation of approval.
- **FR-033**: A reply MUST NOT be approvable in bulk. Items MUST be dismissable in bulk, and a dismissal MUST send nothing.
- **FR-034**: A dismissal MUST record who dismissed it and when, MUST remove the item from the queue, and MUST leave it readable in the inbox.
- **FR-035**: Approving a reply with empty text MUST be refused.
- **FR-036**: A member holding engagement view but not reply MUST be able to read items and drafts and MUST NOT be able to request a draft, edit one, approve one, dismiss an item or send anything. Every refusal MUST be enforced on the server, not only in the interface.
- **FR-037**: A member holding no engagement permission MUST NOT see the inbox in navigation, MUST NOT have its count computed for them, and MUST be refused a direct link to it without the refusal disclosing a count.

**Sending a reply**

- **FR-038**: An approved reply MUST be sent as a reply to the item it answers, on the account the item arrived at.
- **FR-039**: Sending MUST be idempotent per inbound item, recorded durably at the moment of the send so that a crash, a restart or a concurrent attempt between sending and recording cannot produce a second send. A second send for the same item MUST be refused on that record rather than on timing.
- **FR-040**: A send whose outcome is unknown MUST be recorded as ambiguous, MUST NOT be retried automatically, and MUST be surfaced for a human decision the way an ambiguous publish already is.
- **FR-041**: A send the platform refuses as a duplicate MUST be treated as already answered rather than as a failure.
- **FR-042**: A send MUST NOT consume write allowance that scheduled publishing needs: within one run, publishing MUST be served first, and replies MUST be held back under a per-account reserve rather than competing freely.
- **FR-043**: A reply held back for allowance, or waiting for a later run, MUST be shown as waiting — never as sent and never as failed.
- **FR-044**: A send that fails for a stated reason MUST report that reason, MUST flag the account where the reason is a credential or permission problem, and MUST leave the item answerable once the cause is fixed.
- **FR-045**: A sent reply MUST record the exact text sent, the time, the member who approved it, and the platform's identifier for the reply, and MUST appear in the thread in Docket.

**Notifications and activity**

- **FR-046**: New inbound items MUST raise attention through the existing notification mechanism, honouring each member's existing per-kind and per-platform switches and their existing reading position, with one new kind for engagement.
- **FR-047**: A member who has never touched the engagement switch MUST be treated as having it on with no position of its own, consistent with the existing switches, and items that arrived before the switch existed MUST NOT retroactively notify.
- **FR-048**: An item already stored MUST NOT raise a second notification.
- **FR-049**: Sending a reply, and a send that becomes ambiguous, MUST each be recorded in the append-only activity log, attributed to the account, the platform and the member who approved it.
- **FR-050**: Adding the new activity kinds MUST leave an *upgrade* from an already-installed schema working, not only a fresh install: the existing migration guard test MUST stay green, and the known failure mode recorded in `docs/decisions.md` on 2026-10-15 MUST be covered by test rather than avoided by care.
- **FR-051**: Introducing the engagement notification switch MUST leave every member's existing switch settings meaning exactly what they meant before.

**Platform surfaces and the provider contract**

- **FR-052**: Engagement MUST be a declared provider capability: a provider states which inbound kinds it can read and whether it can send a reply, and implements the read and the send. Adding engagement to a provider MUST NOT require a change to the inbox, the drafting, the review path, the notifications or the activity log.
- **FR-053**: A provider that declares no engagement capability MUST be absent from the inbox with no error and no empty section implying a fault.
- **FR-054**: Bluesky MUST support reading replies and mentions, and sending a reply, using the existing persisted-session and serialised-refresh behaviour and making no live calls in tests.
- **FR-055**: The Meta surfaces MUST be built only on confirmed findings from FR-001, and a surface whose required permission the research found to be outside Standard Access MUST be presented as unavailable with its reason and a link to the setup documentation, with no call attempted.
- **FR-056**: Direct messages MUST be modelled as an inbound kind distinct from a public comment, MUST be visibly distinguished wherever the two appear together, and MUST tell a reviewer that a reply goes privately to one person. No platform's direct messages may be read, drafted or sent before that platform's facts are committed to research.
- **FR-057**: Moderation actions — hiding, deleting, liking or reporting an item, or blocking its author — MUST NOT be implemented, and their absence MUST be recorded as a gap.
- **FR-058**: The system MUST NOT classify, score, rank or filter inbound items by spam, sentiment or priority, and MUST NOT withhold any item the platform returned.

**Privacy, retention and secrets**

- **FR-059**: Inbound items MUST be deleted when their account is disconnected or removed from the project, and when the project is deleted, leaving nothing readable or countable anywhere.
- **FR-060**: Inbound items that have no pending draft and no outstanding attention MUST be removed after a bounded retention period, stated in the documentation and configurable by the operator, so a self-hosted install does not accumulate third parties' words indefinitely.
- **FR-061**: An item the platform reports deleted MUST be honoured: it becomes unreplyable and is removed on the next retention pass rather than kept indefinitely.
- **FR-062**: No credential, token or secret may appear in any engagement response, inbox view, draft, prompt, activity entry, notification, error message or log line, and the existing secret scan MUST cover the engagement paths and stay green.
- **FR-063**: An inbound author's identity MUST NOT be sent anywhere other than the platform it came from. It MUST NOT be included in telemetry, and what the drafting prompt carries about an author MUST be documented.
- **FR-064**: `docs/privacy.md` MUST be updated to state what inbound engagement data is stored, why, for how long, and how it is deleted.

**Documentation and scope**

- **FR-065**: `docs/build-prompt.md` and the constitution's out-of-scope list MUST be amended so neither still says comment and inbox management is out of scope, with the constitution change made in a `docs(constitution):` commit and a version bump.
- **FR-066**: A documentation page MUST be published in `docs/` and added to the site navigation, covering: which platforms are supported and which are not and why; that nothing is ever sent without a person approving it; who may read and who may reply; what drafting costs; retention and deletion; and the platform permissions each supported surface needs.
- **FR-067**: `docs/adding-a-provider.md` MUST be updated with the engagement capability, so the next provider author knows how to opt in.
- **FR-068**: `docs/security.md` MUST state that engagement adds no new credential type and no new trust boundary, and that sending is reachable only by a signed-in member.
- **FR-069**: The recorded gaps — no moderation, no API or MCP surface, no webhooks, and direct messages pending research — MUST be written down where a reader can find them, not left implicit.

### Key Entities

- **Inbound item** (new): one thing somebody said to a connected account — a reply, a comment, a mention or a direct message. Carries the project, the account, the platform, the platform's own identifier for it, its kind, its text as it arrived, its author as the platform supplied them, when it was said, what it answers, and its state: waiting, answered, dismissed, withdrawn or edited-upstream. Immutable in its text and author once stored.
- **Inbound author** (new, part of an item): whatever identity the platform supplied — a display name, a handle, an identifier, a profile link, any of which may be absent. Never invented, never merged across platforms, and carrying whether its identifier is stable enough to recognise the same person twice.
- **Reply draft** (new): a proposed answer to one inbound item. Carries its text, whether a model or a person wrote it, the voice profile and version it was written from, when it was written, who asked for it, and its review state: waiting, approved, rejected or dismissed, with who decided and when.
- **Reply send ledger entry** (new, in the shape of `external_item_claims`): the durable record that one inbound item has been answered. Written in the same transaction as the send, never updated, never deleted; the authority on whether Docket has already replied.
- **Account engagement state** (new, per connected account): the reading cursor, the lease, when it last read successfully, and whether reading is currently failing and why.
- **Engagement capability** (new, declared on a provider): which inbound kinds the provider can read, and whether it can send a reply. The only place a platform's engagement support is stated.
- **Approval policy** (existing, unchanged): still governs posts. Pinned to review-required for replies regardless of its value.
- **Voice profile and voice profile version** (existing, unchanged): the brand voice a draft is written from and the exact version recorded against it.
- **Activity event** (existing, gains kinds): the append-only log, gaining a reply-sent kind and an ambiguous-send kind.
- **Notification preference** (existing, gains a switch key): the per-kind switch gains an engagement kind.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A person running a brand on Bluesky stops opening Bluesky to find out whether anyone replied: every reply and mention to a connected account appears in Docket, with its author and the brand's own post beside it, within five minutes of being said.
- **SC-002**: Answering a comment takes under a minute from opening it — read the comment, read the draft, edit it, approve — and the reply is live on the platform within a minute of approval.
- **SC-003**: Zero replies are sent that no person approved. Over the whole feature there is no configuration, no policy value, no permission, no key and no scheduled process that can send one, and this is demonstrated by test rather than asserted — including with the project set to auto-approve.
- **SC-004**: Every reply that is sent has exactly one send: no inbound item is ever answered twice, including when two members approve at the same instant, when a send's outcome is unknown, and when the work is killed mid-send and resumed.
- **SC-005**: A send of unknown outcome is never retried automatically, and reaches a person as a decision to make, 100% of the time.
- **SC-006**: Engagement never costs a scheduled post its place: with an account at its write allowance, every scheduled post still goes out at its time, and replies wait.
- **SC-007**: With a backlog larger than one run can read, every scheduled post still goes out at its time and the tick still completes inside 30 seconds.
- **SC-008**: No inbound item from one project is ever readable or countable from another, verified by the cross-project scope test extended to cover the inbox.
- **SC-009**: Drafting spend is attributable: an operator can see what engagement drafting cost the project alongside what generation cost, and a project spends nothing on drafting until somebody asks for one.
- **SC-010**: Every identity field shown for a Meta surface traces to a confirmed verdict in the committed research, and a reader of the research can tell, per surface, exactly what is known, what is contradicted and what is unverified.
- **SC-011**: A surface that needs a permission outside Standard Access is visible as unavailable with its reason before anybody tries to use it — nobody discovers it by a failure.
- **SC-012**: Adding engagement to the next provider touches that provider's folder and the research document, and nothing else: no change to the inbox, the drafting, the review path, the notifications or the activity log.
- **SC-013**: No secret appears on any engagement path: the existing secret scan covers them and passes.
- **SC-014**: A self-hosted install's engagement data does not grow without bound: items past the retention period, and items deleted upstream, are gone, and disconnecting an account or deleting a project leaves none of its inbound data behind.
- **SC-015**: An operator can answer "what does Docket store about people who comment on my posts, and for how long" from the published documentation alone.
- **SC-016**: The documented scope is self-consistent: no document still says comment and inbox management is out of scope, and the four recorded gaps are findable in the documentation.

## Assumptions

- **"The existing Review queue and approval policy" means the existing review *mechanism*, with the policy input pinned.** The user's sentence ends "so nothing is ever sent unreviewed", and the existing policy includes `auto_approve`, so the two cannot both be honoured literally. Taken as: share the decision path, the locking, the reviewer record and the Review screen; never let a policy value skip the person. If the intent was that `auto_approve` should also auto-send replies, this is the assumption to overturn, and FR-029 is the single requirement that changes.
- **Direct messages are sequenced last, not cut.** US5 and FR-056 specify them; no platform's DM facts exist in `docs/research/`, so they cannot be built in this entry without breaching constitution I. If DMs must ship inside this entry, the research in US1 has to widen to cover them — which also widens the human spike, and for Meta brings in messaging permissions that are not in the Standard Access set this entry assumes.
- **The identity spike is a human task and is scheduled last despite being first in risk order.** It needs live Meta credentials, real accounts and a browser, none of which a pipeline phase has. Nothing in US2 or US3 waits on it. Ordering it first would stall every other task behind it.
- **Bluesky needs its own research too.** `docs/research/bluesky.md` has nothing on reading notifications, replies or threads. That part of US1's research is desk work from the lexicons and the client package, not a live spike, and it gates US2 — so it is the first thing to write.
- **Polling, not webhooks.** Constitution VI's no-new-infrastructure rule and the absence of an assumed public inbound endpoint in a self-hosted deployment. A five-minute arrival target is set accordingly; nothing in the design depends on real-time delivery.
- **Volume is a brand's volume, not a platform's.** The design assumes tens to low hundreds of inbound items per account per day, caught up over successive runs. It is bounded and will not lose items above that, but it is not built for a viral thread's full comment history.
- **Replies are text only.** No image, video or link-card reply, on any platform, in this entry. The platforms' text limits and counting rules are already declared per provider and are reused unchanged.
- **One reply per inbound item.** Threading a back-and-forth conversation inside Docket is not built: a reply to Docket's reply arrives as its own item with Docket's text as its parent, which is enough to read a conversation in order without modelling one.
- **The default retention period is 90 days**, operator-configurable, counted from when an item was said, applying only to items with no pending draft and no outstanding attention. Industry-ordinary for inbound social data and short enough that a self-hosted install does not become an archive of strangers' words.
- **The LLM is given the comment's text and the brand's context, and as little about the author as the answer needs.** Whatever it is given is documented, because it leaves the installation.
- **The inbox is its own screen, with the Review queue as the place decisions are made.** Reading dozens of comments and deciding on a handful of drafts are different activities with different shapes; forcing both into one list would make the Review queue worse at the job it already does. The count, the notifications and the decision path are shared.
- **Existing surfaces absorb failures.** An engagement read that fails and an engagement send that becomes ambiguous appear where publishing's equivalents already appear — the account's state and the failures surface — rather than in anything new.
- **No new runtime dependency.** Every platform read and write in scope goes through a client the project already has, or plain HTTP it already makes. If the research in US1 finds otherwise, it is a `NEEDS DEPENDENCY` for planning, not something to hand-roll.
