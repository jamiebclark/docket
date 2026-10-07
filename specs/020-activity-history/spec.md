# Feature Specification: Activity history — one log of publish successes and failures, per project and across projects

**Feature Branch**: `020-activity-history`

**Created**: 2026-10-07

**Status**: Draft

**Input**: User description: "Give owners one place to see what happened: every publish success and failure, across a project and across all the projects they belong to, filterable by outcome, platform, account, date and project. Before specifying, read src/server/db/schema/attempts.ts (publish_attempts and its outcome enum), src/server/db/schema/posts.ts (post_targets statuses, indexes), src/server/db/schema/webhooks.ts and src/server/services/webhooks/ (where post.published, post.failed and account.needs_reauth are emitted), src/server/services/failures.ts and src/app/p/[projectSlug]/failures/page.tsx (the existing failures screen, filters, attempt-log rendering and actions to reuse, not duplicate), src/app/p/[projectSlug]/posts/[postId]/page.tsx (per-target attempt history), src/server/services/connect.ts (handleOAuthCallback failure outcomes and the G18 banner message), src/server/dal/ (forProject scoping, listMyProjects, the project_id scope-enforcement test harness), src/app/api/v1/ and docs/n8n.md (public API conventions, scopes, OpenAPI), src/components/shell/LeftNav.tsx, the docket-ui skill, docs/design-system.md, .specify/memory/constitution.md and docs/decisions.md. Must deliver: an append-only activity event record (recommended: an `activity_events` table: project_id, occurred_at, kind, outcome, post_id/post_target_id, social_account_id, provider_key, actor (scheduler | user | api key, as publish_attempts records it), a short user-facing message (<=500 chars, secrets never stored; reuse the existing scrubbing), and a small details jsonb). Kinds at minimum: post target published; post target failed (fatal); post target ambiguous; post target retry scheduled (retryable error, with next attempt time); target resolved/retried by a person or API key (from the 012/015/016 recovery actions); account needs reauth; account connect failed (OAuth callback refusals, using the group's own message per G18, and credential-connect refusals). Write events at the same points the webhook events are emitted and in the recovery and connect services, inside the same transaction as the state change where one exists, so the log cannot disagree with the post state. Indexed for (project_id, occurred_at desc) and the filters below. The plan may choose a derived view instead only if it shows the same guarantees and performance; record the choice in docs/decisions.md. Backfill in the migration (or an idempotent startup/backfill script run by the migrate step) so existing published, failed and ambiguous targets appear with their real times. Per-project Activity screen /p/[projectSlug]/activity (left nav, Publish group, after Failures): newest first, paginated; each row shows time in the project timezone, outcome badge, platform mark (ProviderIcon) and account, post excerpt linking to the post, the message, and the actor; failed/ambiguous rows link to their Failures entry and its actions instead of re-implementing them. Filters (URL query params, shareable, keyboard accessible, per the docket-ui skill): outcome (multi: published, failed, ambiguous, retrying, resolved, needs reauth, connect failed; plus presets 'successes' and 'problems'), platform, account, date range (from/to in the project timezone, with quick ranges today / 7 days / 30 days). Empty, loading and error states. Any member who can view posts can see it. All-projects Activity /activity (linked from the user menu and the project switcher): the same rows and filters plus a project filter, covering only projects the user is currently a member of (membership re-checked per request like the DAL; a removed member loses access immediately); each row names and links its project. Must pass the project_id scope-enforcement test harness (extend it for a query that spans the caller's own project ids). Summary counts above the list for the current filter (successes, problems) so 'how did last week go' is answerable at a glance. Public API: GET /api/v1/activity for the API key's project with the same filters and cursor pagination, a read scope consistent with existing ones (e.g. post:view), OpenAPI with examples, and a short docs/n8n.md section. Docs: a 'History and activity' section in docs/accounts.md or a new docs page linked from docs/index.md and mkdocs.yml, covering what is recorded, what is not (no publish content beyond an excerpt, no secrets) and retention (keep everything; note the table size and an index-backed date filter). Tests: events written for every kind above (including inside the recovery and connect paths), no event on a rolled-back transaction, backfill idempotent, filters (each alone and combined, timezone edges for date ranges), all-projects scoping (non-member and removed member see nothing; scope harness passes), API filters, pagination and auth, no secret values in messages (extend the secret-scan test), and rendering of each outcome. Does NOT: an unread badge, notification feed, mark-as-read or per-user notification settings (the activity-notifications entry builds those on these events); email or push delivery (webhooks already cover external delivery); analytics such as engagement metrics; deleting or editing history."

## Context and sources

- Roadmap `.specify/roadmaps/docket.json`, entry `activity-history` (owner request 2026-10-07). The next entry, `activity-notifications`, builds an unread-problems badge and feed on top of these events. So the events must be durable, typed by kind, scoped to a project, and must say who acted, including which member attempted a failed connect.
- Behaviour on `main` that this feature records (read from the current code and `docs/decisions.md` 002, 009, 010, 012, 015, 016 and G18):
  - **A post goes to one or more accounts.** Each post-to-account pair is a *target*, and it is the unit the scheduler publishes. Target statuses are draft, scheduled, publishing, published, failed, ambiguous and cancelled. A post's own status is derived from its targets.
  - **Webhooks are per post, not per target.** `post.published` and `post.failed` fire when a post's *derived* status changes (failed also covers partially failed). They fire inside the transaction that changed a target. `account.needs_reauth` fires when an account moves from active to needs-reauth, in the same transaction. That happens in one shared helper used by token refresh, publish-time refresh and the "credentials invalid" path. Activity needs per-target rows (each row has one platform and one account), so "the same points" in the request is read as **the same transactions**: an event is written in the transaction that changes the target or the account. The derived-status step is not used.
  - **Every target state change already writes a publish-attempt entry in the same transaction.** The scheduler's step recording writes one. So do the engine's settle paths (account unavailable, publish did not complete, invalid account settings, post no longer available, publish-time content validation (G15), interrupted too many times) and lease-expiry recovery (an interrupted step that may have published becomes ambiguous; otherwise it is retried). So do the person/API-key actions: resolve an ambiguous target (published, not published, not published and requeued, or no free slot), retry a failed target (now / requeue / at), and bulk retry (each target in its own short transaction). Attempt entries already carry the acting member or API key, and their error text is already scrubbed of credential values.
  - **Connect refusals have no target state.** The OAuth return can end with a platform error, a refused code exchange, a thrown exchange, no accounts found or too many accounts. Since G18 the group's own user-facing message for these travels sealed to the accounts banner. A token paste can be refused or find nothing, and a credential (password-style) connect can be refused by the provider, time out, or turn out to be a different account on reconnect. These refusals write no state today, apart from completing the connect attempt.
  - **Failures screen** (`/p/[projectSlug]/failures`) lists targets that are *currently* failed or ambiguous. It has status and account filters, grouped attempt runs and the recovery actions (retry, requeue, mark published, mark not published). The post page shows each target's full attempt history. Activity reuses these and does not copy them.
  - **Scoping.** Every project-owned query is pinned to one project id, and a test harness fails any unpinned query on a project-owned table. The only sanctioned exception is an explicitly named cross-project section, and "list my projects" uses one. All member roles (owner, admin, editor) may view posts. API keys have the permissions `read`, `write_posts`, `generate`, `auto_approve` and `manage_jobs`. There is no key permission named `post:view`; `post:view` is the member permission that `read` grants.
  - **Public API pagination** uses an opaque cursor that encodes an offset. New activity is inserted at the top of a newest-first list, so an offset cursor would repeat rows across pages.
- No external platform facts are involved, so nothing here needs `docs/research/`. No new runtime dependency is expected. One schema change (a new table plus its indexes) and a one-off backfill are expected.

## Decisions made while specifying

These are judgement calls. Planning records each one in `docs/decisions.md`.

- **D1 One event per target or account state change.** An event is written when a target enters published, failed or ambiguous, or is scheduled for an automatic retry. It is also written when a person or API key changes a target's state, and when an account becomes needs-reauth. A change that leaves the state as it was writes nothing. Examples: a step that continues, a deferral for the publishing limit, a stale result after a lost lease, and a requeue that found no free slot and left the target failed. Post-level webhook transitions are not separate events.
- **D2 Every path into a state counts, not only the provider result.** Engine settles and lease recovery that fail a target are *failed* events, and their message says why. An interrupted publish step that may have gone out is an *ambiguous* event. A retryable error on the last allowed attempt is a *failed* event ("gave up after N attempts"), not a *retrying* one. An interrupted step that is being retried is a *retrying* event.
- **D3 Resolutions are their own outcome and count as neither success nor problem.** Marking published, marking not published, requeueing, retrying (now / requeue / at) and a bulk retry each write one *resolved* event per affected target. The event records which action was taken and who took it. The summary counts successes as *published* events and problems as *failed*, *ambiguous*, *needs reauth* and *connect failed* events. *Retrying* and *resolved* count as neither. This avoids counting one post twice, for example once as ambiguous and again when someone confirms it went out.
- **D4 Which connect refusals are recorded.** Recorded as *connect failed*, with the message the person was shown (the group's own message per G18, otherwise the generic text):
  - an OAuth return with a platform error, a refused or thrown code exchange, no accounts found, or too many accounts;
  - a token paste that was refused, could not be checked, found nothing, or reached too many accounts;
  - a credential connect refused by the provider, one that could not reach it, and a reconnect that signed in as a different account.

  Not recorded:
  - a person cancelling at the platform (their own choice, not a failure);
  - a callback whose state is forged, unknown, expired, reused or bound to someone else (it cannot be safely tied to a project, and recording it would let anyone write into a project's log);
  - a caller without permission to manage accounts;
  - local form validation ("Check the highlighted fields");
  - an expired or empty account chooser.
- **D5 The read permission is the existing `read` key permission.** The member side checks "view posts", which every role has. No new key permission is added. The request's "e.g. post:view" names the member permission that `read` already grants.
- **D6 Activity pagination is stable under new events.** Both the screens and the API page by position in the newest-first order, using the event's time and a tie-breaker, not an offset. Events that arrive between page loads never cause a row to repeat or be skipped. The API cursor stays opaque, per the existing convention. Its contents differ from the offset cursor, and that is recorded.
- **D7 Dates in the all-projects view use each project's own time zone.** On a project's screen, from/to dates and the quick ranges are calendar days in that project's time zone. In the all-projects view, "today", "7 days" and "30 days" are applied in each row's own project time zone, and each row shows its time in that zone with the zone named. This keeps the rule "times are always shown in the project's time zone" with no new user-level time-zone setting. The summary counts follow the same rule.
- **D8 Summary counts ignore the outcome filter.** The counts respect every other filter: project, platform, account and dates. Viewing only problems still shows how many posts went out in the same period. The label says so ("In this period: …"). Each count links to the matching preset.
- **D9 History survives deletion of what it mentions.** Removing an account or deleting a post keeps its events. The row then shows "Removed account" or "Post deleted" (without a link) and keeps the excerpt. Only deleting the whole project removes its events.
- **D10 Backfill reflects current state, once.** Every target that is currently published, failed or ambiguous gets one event, at the real time of the change. That is the publish time for published targets, and otherwise the time of the attempt entry that settled the target, falling back to the target's last update. If a person resolved the target, that person or key is the actor. Earlier history (retries before the final state, or past reauth episodes) is not reconstructed. Accounts that need reauth today get one *needs reauth* event at the time their status last changed, so the new log is not missing a current problem. Running the backfill again adds nothing, and it never duplicates an event the live code wrote after migration.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See what happened in one project (Priority: P1)

A project member opens Activity from the project's left navigation, under Publish, after Failures. They see a newest-first list of everything that happened to publishing in that project: posts that went out, posts that failed, ones that may or may not have gone out, automatic retries, recoveries by people or API keys, accounts that need reconnecting, and connects that failed. Each row shows when it happened (in the project's time zone), an outcome badge with text, the platform mark and account name, a short excerpt of the post linking to it, the message, and who or what acted (the scheduler, a named member, or a named API key).

**Why this priority**: This is the core ask. Today successes and failures are never shown together, and nothing shows a post that went out alongside one that did not.

**Independent Test**: Seed a project with published, failed, ambiguous, retrying and resolved targets plus a needs-reauth account and a failed connect. Open the Activity screen and check that every row appears once, in newest-first order, with the right badge, platform, account, excerpt, message, actor and project-time-zone time.

**Acceptance Scenarios**:

1. **Given** a target published at 09:00 project time, **When** a member opens Activity, **Then** a "Published" row shows 09:00 with the zone, the platform mark, the account, the post excerpt linked to the post, and the actor "Scheduler".
2. **Given** a target that failed with a provider error, **When** it appears in Activity, **Then** its "Failed" row shows the scrubbed error as the message. While the target is still failed, the row links to that target's entry on the Failures screen, where retry is offered.
3. **Given** a target that became ambiguous, **When** it appears in Activity, **Then** its row reads "Needs your decision" in the ambiguous style. While the target is still ambiguous, the row links to its Failures entry, where the mark-published / mark-not-published / requeue actions are offered.
4. **Given** a failed target that a member later retried and that then published, **When** Activity is opened, **Then** it shows three rows in order: "Failed", "Resolved" (retry now, by that member) and "Published". The "Failed" row now links to the post, not to Failures, because the target is no longer failed.
5. **Given** a retryable error, **When** it appears in Activity, **Then** the "Retrying" row shows the error, the attempt number and when the next attempt is due.
6. **Given** an account whose renewal was refused, **When** it appears in Activity, **Then** a "Needs reconnecting" row names the account and platform with no post, and links to the project's accounts screen.
7. **Given** more events than fit on one page, **When** the member moves to older events and back, **Then** each page holds the next events in order, with no repeats or gaps, even if new events arrived in between.
8. **Given** a project with no events, **When** Activity opens, **Then** an empty state explains what will appear here and links to Compose. While data loads, a skeleton matching the list is shown. If loading fails, a plain-language error with a retry is shown.

---

### User Story 2 - Narrow it down and share the view (Priority: P1)

A member filters Activity by outcome (one or several of published, failed, ambiguous, retrying, resolved, needs reauth, connect failed, or the presets "Successes" and "Problems"), by platform, by account, and by a date range (from/to days in the project's time zone, or the quick ranges Today, 7 days, 30 days). The URL reflects the filters, so a copied link opens the same view. Everything works from the keyboard.

**Why this priority**: The owner's question is "what went wrong with Instagram last week", which needs filters. The list alone does not answer it.

**Independent Test**: With seeded events across outcomes, platforms, accounts and days, apply each filter alone and in combination, then reload the URL. The same rows and counts come back, and every control can be reached and operated by keyboard.

**Acceptance Scenarios**:

1. **Given** the "Problems" preset, **When** applied, **Then** only failed, ambiguous, needs-reauth and connect-failed rows show, and the URL records the choice.
2. **Given** outcomes "published" and "retrying" both selected, **When** applied, **Then** rows of both outcomes show and no others.
3. **Given** platform "Instagram" and account "Shop IG", **When** applied, **Then** only that account's rows show. An account that belongs to a different platform than the one selected yields an empty result with a "clear filters" link, not an error.
4. **Given** a project in America/New_York and a from/to range of a single day that contains a DST change, **When** applied, **Then** every event inside that local day (23 or 25 hours long) shows, and none from the day before or after.
5. **Given** "Today" at 00:30 project time, **When** applied, **Then** only events since local midnight show. Events from 23:59 the previous local day do not.
6. **Given** a shared URL with filters, **When** another member opens it, **Then** they see the same filtered view of the same project.
7. **Given** a URL with unknown or malformed filter values, **When** opened, **Then** those values are ignored, the defaults apply, and the page does not error.

---

### User Story 3 - Know at a glance how a period went (Priority: P1)

Above the list, the member sees counts for the current filters: how many successes (posts that went out) and how many problems. Picking "7 days" answers "how did last week go" without scrolling.

**Why this priority**: This is the owner's stated question. It is cheap once the events exist, and it makes the screen useful daily.

**Independent Test**: Seed known numbers of each outcome inside and outside a date range. Check that the counts for the range match exactly, that they respect the platform, account and project filters, and that they do not change when only the outcome filter changes.

**Acceptance Scenarios**:

1. **Given** 40 published and 3 problem events in the last 7 days and others before, **When** "7 days" is chosen, **Then** the summary reads 40 successes and 3 problems for that period.
2. **Given** the outcome filter "failed" is applied, **When** the summary shows, **Then** it still counts successes and problems for the other filters, and says so.
3. **Given** a count is activated, **When** clicked or chosen with the keyboard, **Then** the list switches to the matching preset.

---

### User Story 4 - See every project at once (Priority: P2)

A person who belongs to several projects opens All activity from the user menu or from the project switcher. They see the same rows and filters, plus a project filter, covering only the projects they are currently a member of. Each row names its project and links to it.

**Why this priority**: The owner runs several projects. Checking each one separately is the problem this request names. It depends on Story 1's rows and filters.

**Independent Test**: Create a user in two of three projects, seed events in all three, and check that only the two projects' events show, each labelled with its project. Remove the user from one project and check that its events disappear on the next request.

**Acceptance Scenarios**:

1. **Given** a member of projects A and B but not C, **When** they open All activity, **Then** they see A's and B's events and none of C's, each row naming and linking its project.
2. **Given** the project filter set to A, **When** applied, **Then** only A's events show and the counts cover A only.
3. **Given** the user is removed from B, **When** they next load All activity or any page of it, **Then** B's events are gone, including from counts and from pages already linked.
4. **Given** a crafted URL whose project filter names project C, **When** opened, **Then** the result is the same as a project with no matching events. Nothing reveals that C exists.
5. **Given** a user who belongs to no projects, **When** they open All activity, **Then** they see an empty state, not an error.

---

### User Story 5 - The log can be trusted (Priority: P1)

An event is written only when the change it describes actually commits, and every committed change writes its event. History is never edited or deleted, except when the whole project is deleted. Existing published, failed and ambiguous posts appear from day one. No message ever contains a secret.

**Why this priority**: A log that disagrees with the post state is worse than none, and the next entry counts these events for notifications.

**Independent Test**: Drive each path that writes an event, then force a rollback after the state change and check that no event remains. Run the backfill twice and check that the count is unchanged. Feed a provider error that echoes a credential value and check that the stored message and every screen and response show it redacted.

**Acceptance Scenarios**:

1. **Given** each scheduler path (step result, engine settle, lease recovery, retry exhaustion, publish-time validation), **When** it changes a target's state, **Then** exactly one matching event exists, written in that same transaction.
2. **Given** each recovery action from the screen and from the API (resolve published / not published / requeue / no free slot, retry now / requeue / at, bulk retry), **When** it commits, **Then** each affected target has one "Resolved" event naming the action and the member or API key.
3. **Given** a transaction that changes a target and then fails, **When** it rolls back, **Then** no event from it exists.
4. **Given** two people resolve the same ambiguous target at once, **When** both submit, **Then** one event exists, from the winner.
5. **Given** existing data at migration time, **When** the migration and backfill run, **Then** each published, failed and ambiguous target has one event at its real time. Running the backfill again adds none.
6. **Given** a provider message that contains an access token, password or app secret value, **When** the event is stored and shown, **Then** none of those values appear in storage, on screen or in API responses.
7. **Given** an OAuth return that the platform refused with its own message, **When** the person is sent back to the accounts screen, **Then** a "Connect failed" event records that same message, the platform group and the person who tried.

---

### User Story 6 - Automations can read the log (Priority: P2)

An automation with an API key for a project reads that project's activity, with the same filters, newest first, page by page with a cursor. The API reference documents it with examples, and the n8n guide has a short recipe, such as a nightly summary of problems.

**Why this priority**: Webhooks only cover delivery as events happen. Reading back what happened (for reports, or to catch up after downtime) needs a list endpoint.

**Independent Test**: With a `read` key, call the endpoint with each filter, follow the cursor to the end, and check that every matching event is returned exactly once. Check that a key for another project, a missing key and a revoked key are refused.

**Acceptance Scenarios**:

1. **Given** a key with `read` for project A, **When** it lists activity, **Then** only A's events are returned, newest first, each with its kind, outcome, time, platform, account, post reference, message, actor and details.
2. **Given** filters for outcome, platform, account and from/to, **When** passed, **Then** the API applies them exactly as the screen does, including project-time-zone day boundaries.
3. **Given** events arrive while the automation pages through, **When** it follows the cursor, **Then** no event repeats and none is skipped.
4. **Given** a malformed filter or cursor, **When** passed, **Then** the response is `400 validation_failed` with per-field details.
5. **Given** no key, a revoked key, or a key without `read`, **When** called, **Then** the API returns its usual 401 or 403 error shape.

---

### Edge Cases

- A target is retried many times before it publishes. Each retryable error is its own "Retrying" row, and the final "Published" row follows. Nothing is merged.
- A step result arrives after the lease was lost (stale result). The state does not change, so no event is written.
- A requeue or retry that finds no free slot and leaves the target failed changes no state, so no "Resolved" event is written. A resolve of an ambiguous target with no free slot does change the state (ambiguous to failed), so it writes one.
- A bulk retry skips some targets (blocked account, no longer failed, no free slot). Only the retried targets get "Resolved" events.
- The post was later deleted, or the account removed. The rows remain with "Post deleted" (no link) or "Removed account", and keep their excerpt.
- A failed or ambiguous row whose target has since moved on links to the post, not to Failures.
- An actor was removed: a member who left shows as "Former member", a deleted API key as "Removed API key", matching the attempt log.
- A connect-failed event for a platform group that covers several platforms (Facebook and Instagram share one sign-in) appears under each of those platforms' filters. It has no post, and may have no account.
- A provider message longer than 500 characters is cut to fit with an ellipsis. It is scrubbed before it is stored.
- Two events at the same instant have a stable order on every load and across pages.
- A from date later than the to date shows an inline message and no rows, not an error page.
- In the all-projects view, projects in different time zones each apply "Today" in their own zone. Each row's time names its zone.
- A very large history (hundreds of thousands of events) still opens the first page and the counts quickly, because date and filter lookups are index-backed.
- A member who can view posts but not schedule them sees every row and link. The Failures screen they land on already hides actions they cannot take.

## Requirements *(mandatory)*

### Functional Requirements

**The event record**

- **FR-001**: The system MUST keep an append-only record of activity events per project. Each event has: the project, when it happened, its kind, its outcome, the post and target it concerns (if any), the account (if any), the platform, the actor (scheduler, a member, or an API key, recorded as the attempt log records it), a user-facing message of at most 500 characters, and a small set of structured details.
- **FR-002**: Kinds MUST include at least the following. Each maps to one outcome used for badges and filters:

  | Kind | Outcome |
  |---|---|
  | target published | published |
  | target failed | failed |
  | target ambiguous | ambiguous |
  | target retry scheduled | retrying |
  | target resolved or retried by a person or API key | resolved |
  | account needs reauth | needs reauth |
  | account connect failed | connect failed |
- **FR-003**: A target event MUST be written in the same transaction as the target state change it describes (D1, D2), for every path that makes that change:
  - the scheduler's step results;
  - engine settles;
  - lease recovery;
  - retry exhaustion;
  - publish-time validation;
  - the recovery actions from screens and the API.

  A rolled-back change MUST leave no event.
- **FR-004**: A "needs reauth" event MUST be written in the same transaction as an account's change from active to needs reauth, on every path that makes that change (scheduled renewal, renewal at publish time, credentials found invalid). The rule is the same one the webhook uses.
- **FR-005**: A "connect failed" event MUST be written for the refusals listed in D4, with the message the person was shown, the platform group, the account when one was being reconnected, and the member who tried. It MUST NOT be written for the exclusions in D4.
- **FR-006**: "Retrying" events MUST carry the attempt number and the next attempt time. "Resolved" events MUST carry which action was taken: marked published (with the link, if one was given), marked not published, requeued (with the new time), retry now, retry requeue (with the new time), retry at (with the time), or bulk retry. "Published" events MUST carry the post's link on the platform when one is known.
- **FR-007**: Messages MUST be scrubbed of credential and secret values before they are stored, using the same scrubbing as the attempt log, and cut to 500 characters. Events MUST NOT store post content beyond a short excerpt. Details MUST NOT include tokens, credentials, request bodies or raw platform responses.
- **FR-008**: No product path (screen, action, API or job) MUST be able to edit or delete an event. Removing an account, or soft- or hard-deleting a post, MUST keep its events (D9). Deleting the project MUST remove its events.
- **FR-009**: Events MUST have a stable newest-first order: by time, then by a tie-breaker. Lookups by project and time, and by every filter in FR-013, MUST be index-backed.
- **FR-010**: If the plan chooses a derived view instead of a stored record, it MUST show the same guarantees (FR-003–FR-009, and agreement with post state under concurrency) and the same performance (SC-004). The choice MUST be recorded in `docs/decisions.md`.

**Backfill**

- **FR-011**: The migrate step MUST backfill events for existing data as D10 describes, at their real times. It MUST be idempotent: a second run adds no events, and it never duplicates an event the live code wrote after migration.

**Per-project Activity screen**

- **FR-012**: The project shell MUST have an "Activity" entry in the Publish group, directly after Failures, that opens the project's Activity screen. Any member who can view the project's posts MUST be able to see it, and the permission MUST be checked on the server.
- **FR-013**: The screen MUST list the project's events newest first, a page at a time, and MUST be able to move to older and newer pages without repeats or gaps (D6). Each row MUST show:
  - the time in the project time zone, with the zone named (relative times carry the absolute time as a tooltip);
  - an outcome badge that uses text as well as colour, with ambiguous in the "Needs your decision" style;
  - the platform mark and the account name;
  - the post excerpt linking to the post;
  - the message;
  - the actor.
- **FR-014**: Failed and ambiguous rows whose target is still failed or ambiguous MUST link to that target's entry on the Failures screen, where its actions are. Activity MUST NOT offer its own recovery actions. Rows whose target has moved on MUST link to the post. "Needs reauth" and "connect failed" rows MUST link to the project's accounts screen.
- **FR-015**: Filters MUST be carried in the URL so links can be shared, and MUST be operable by keyboard with labelled controls, following the docket-ui conventions. They are:
  - outcome (any combination of the seven outcomes, plus the presets "Successes" = published and "Problems" = failed, ambiguous, needs reauth, connect failed);
  - platform;
  - account;
  - from/to dates in the project time zone;
  - the quick ranges Today, 7 days and 30 days.

  Unknown or malformed values MUST be ignored. A from date after the to date MUST show an inline message.
- **FR-016**: Date ranges MUST cover whole calendar days in the project time zone, including days that are 23 or 25 hours long at DST changes. "Today" starts at local midnight. "7 days" and "30 days" include today and the preceding 6 or 29 days.
- **FR-017**: Above the list, the screen MUST show the number of successes and problems for the current filters, ignoring the outcome filter (D3, D8). The label MUST say what period the counts cover, and each count MUST link to its preset.
- **FR-018**: The screen MUST have explicit loading (a skeleton), empty (with and without filters, each with a sentence and a next step), error (a plain message with retry) and populated states.

**All-projects Activity**

- **FR-019**: An "All activity" screen MUST be reachable from the user menu and from the project switcher. It shows the same rows, filters and counts plus a project filter (one or more projects), and each row names and links its project.
- **FR-020**: It MUST include only projects the caller is a member of at the moment of each request. Membership MUST be re-checked on every request, and a removed member MUST lose that project's events immediately, including from counts and later pages. A project filter naming a project the caller does not belong to MUST match nothing and MUST NOT reveal whether that project exists.
- **FR-021**: Dates and times in the all-projects view MUST follow D7: each row's own project time zone is used for display, for date filters and for counts.
- **FR-022**: The query that spans several projects MUST be limited to the caller's own current project ids. The project-scope test harness MUST be extended to accept such a query and to fail any query on the events that is not limited to a single project or to the caller's own set.

**Public API**

- **FR-023**: The public API MUST provide a list of activity for the API key's own project. It MUST accept the filters from FR-015 (outcome values and presets, platform, account, from/to with project-time-zone day boundaries) and use opaque cursor pagination that is stable under new events (D6). It MUST use the existing `read` key permission (D5) and the existing error shapes (400 validation_failed, 401, 403 missing_permission).
- **FR-024**: Each returned event MUST include: id, kind, outcome, time (UTC, plus the project-local time), platform, account reference and name, post and target references and excerpt (when present), message, actor (type and name), and details. It MUST NOT include secrets or post content beyond the excerpt.
- **FR-025**: The API reference MUST document the operation, its filters, its pagination and its errors, with examples. The n8n guide MUST gain a short section showing how to read activity, for example a daily problems summary.

**Docs and tests**

- **FR-026**: The docs MUST gain a "History and activity" page or section, linked from the docs index and site navigation. It covers:
  - what is recorded;
  - what is not (no publish content beyond an excerpt, no secrets, no engagement metrics);
  - backfill behaviour;
  - retention: everything is kept until the project is deleted, with a note on the expected size per event and that date filters are index-backed.

  The judgement calls D1–D10 MUST be appended to `docs/decisions.md`.
- **FR-027**: Tests MUST cover:
  - events for every kind and every writing path in FR-003–FR-005, including recovery from the screen and the API, and the connect paths;
  - no event after a rollback;
  - a single event when two people race to resolve;
  - backfill correctness and idempotency;
  - each filter alone and combined, including DST and midnight edges in the project time zone;
  - all-projects scoping (a non-member sees nothing, a removed member loses access at once, a crafted project filter leaks nothing) and the extended scope harness;
  - the API's filters, cursor stability, authentication and permission;
  - no secret values in stored messages, screens or API responses, by extending the existing secret-scan test;
  - rendering of each outcome badge and row variant (live target, moved-on target, deleted post, removed account, former member, removed API key).

### Key Entities

- **Activity event**: One thing that happened to publishing in a project, at a moment. Its attributes:
  - project and time;
  - kind and outcome (FR-002);
  - optional post and target;
  - optional account;
  - platform, or platform group for connect failures;
  - actor (scheduler, member or API key);
  - a scrubbed message of at most 500 characters;
  - small details (attempt number and next attempt time, resolution action and new time, published link).

  It is append-only and survives deletion of the post or account it mentions.
- **Activity filter**: The outcome set or preset, platform, account, from/to days, quick range and, in the all-projects view only, a project set. It is fully represented in the URL and in the API query.
- **Activity summary**: Success and problem counts for a filter, ignoring its outcome part.
- Existing entities referenced, unchanged in meaning: project (with time zone), member, API key, post, post target, social account, publish attempt, connect attempt.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member can answer "how many posts went out and how many problems were there in the last 7 days" in one action from opening Activity, and in under 10 seconds.
- **SC-002**: In tests, every committed state change listed in FR-003–FR-005 produces exactly one event (100% of paths), and rolled-back changes produce none.
- **SC-003**: After migration, 100% of existing published, failed and ambiguous targets appear exactly once with their real times, and a second backfill run adds 0 events.
- **SC-004**: With 100,000 events in a project, the first page and the summary counts appear in under 1 second for any combination of filters. The all-projects view does the same across 20 projects holding 200,000 events in total.
- **SC-005**: Zero events from projects the caller does not currently belong to appear on any screen or in any response. Removal takes effect on the very next request.
- **SC-006**: Zero secret values appear in stored messages, rendered screens or API responses in the secret-scan test.
- **SC-007**: Every filter and pagination control can be used with the keyboard alone, and reopening a copied URL reproduces the same rows and counts.
- **SC-008**: Paging through the API or the screen while new events are being written returns every matching event exactly once.

## Assumptions

- All member roles (owner, admin, editor) can view posts, so every member sees Activity. Failures actions remain limited to those who can schedule.
- Connect-failed events are visible to every member who can see Activity, not only the person who tried. The notifications entry limits *alerting* to that person.
- The outcome labels match the existing badge vocabulary: Published, Failed, "Needs your decision" (ambiguous), Retrying, Resolved, "Needs reconnecting" (needs reauth), Connect failed.
- The screen page size is 50, matching the API default. The API allows up to 100 per page, as other list operations do.
- The post excerpt uses the same excerpt rule as the Posts and Failures screens.
- A reconnect that succeeds writes no event. Successful connects and other account housekeeping are not part of this feature.
- Webhooks are unchanged: no new webhook types, and no change to when existing ones fire.
- The per-post attempt history and the Failures screen are unchanged, apart from Failures gaining a stable per-target link target that Activity can point at.
- The user menu currently offers only Sign out. It gains an "All activity" link, and the project switcher gains the same link.

## Out of Scope

- Unread badges, a notification feed, mark-as-read and per-user notification settings. These belong to the `activity-notifications` entry, which builds on these events.
- Email, push or chat delivery. Webhooks already cover delivery outside Docket.
- Analytics such as engagement, reach or trend charts.
- Editing, deleting, exporting or pruning history, and retention settings.
- Recording successful connects, edits, scheduling, approvals or other non-publishing actions.
- Reconstructing past retries or reauth episodes that happened before this feature shipped (D10).
