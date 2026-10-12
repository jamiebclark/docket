# Feature Specification: Email delivery — Docket's first mailer, and problems that reach people who are not signed in

**Feature Branch**: `060-email-delivery`

**Created**: 2026-10-11

**Status**: Draft

**Input**: User description: "Before specifying, read .specify/roadmaps/notifications.md in full — its goal paragraph, the 'Behaviour on main that every entry builds on' bullet list (invitation delivery already behind the InvitationDelivery / defaultInvitationDelivery interface in src/server/services/invitations/delivery.ts:16-21 injected at index.ts:67, with Docket having no mailer of any kind today; the all-or-none env group pattern of STORAGE_GROUP in src/server/env.ts:72-88; the worker tick at /api/internal/tick with WORKER_INTERVAL_SECONDS, RUN_WORKER_IN_PROCESS and budgets in src/server/scheduler/config.ts as the only recurring server-side execution Docket has) and the 'Rules for every entry' list — in particular the secrets rule: SMTP credentials, signed unsubscribe tokens and recipient addresses are never logged, never in error messages, never in attempt summaries, and the secret-scan test must stay green. Also read specs/022-problem-notifications/ and decisions N1-N12 in docs/decisions.md in full, and record any reversal next to the original decision.

Scope of this entry: give Docket its first mailer and use it to deliver problems to people who are not signed in. A Mailer interface mirroring InvitationDelivery in shape, a default SMTP implementation, and an all-or-none SMTP env group following STORAGE_GROUP (src/server/env.ts:72-88) — email off when the group is unset, exactly as media is off without S3, and a startup validation issue if a satellite variable is set without the group. Per-user choice of immediate or a daily digest at a chosen local hour, honouring the preferences from notification-preferences (entry 2) and the read/snooze state from per-event-read-state (entry 1): never mail a problem the person has already read, dismissed or snoozed, and assemble the digest at send time rather than queueing per event. Quiet hours belong here — within them, immediate mail defers to the next allowed hour rather than being dropped. Digests run on the existing worker tick, inside its budget, with per-user send bookkeeping that survives a crash and never double-sends. Every email carries a one-click unsubscribe that works without a login (a signed, scoped, expiring token — never a bare user id) and lands on a page explaining exactly what was turned off. A delivery log in the shape of the webhook delivery log (src/server/services/webhooks/deliver.ts, src/server/dal/webhooks.ts) records attempts, failures and bounces without storing message bodies. Retrofit defaultInvitationDelivery so invitations are emailed when SMTP is configured and fall back to today's copy-the-link flow when it is not, and update docs/build-prompt.md:85, docs/accounts.md:44 and .env.example accordingly.

Testing the author attached to this entry: the env group (all-or-none, satellite-without-group, off-when-unset); immediate vs digest selection; quiet-hours deferral across DST and across time zones; no double-send under a crashed and retried tick; read, snoozed and preference-filtered events excluded; unsubscribe token signing and expiry plus tamper rejection; bounce handling; invitation fallback both ways; and that no SMTP credential or recipient address reaches a log line.

Must NOT take on: push or chat delivery — webhooks still cover automation, see docs/n8n.md; notifications for successes; per-event actions inside the email beyond unsubscribe; real-time transport (entry 4, realtime-updates)."

**NEEDS DEPENDENCY: `nodemailer`** (or an equivalent installed SMTP client). Docket has no mail package at all: nothing in `package.json` or `node_modules` speaks SMTP, and headless phases cannot reach the npm registry (decision #19). **NEEDS RESEARCH: SMTP and the mail-client one-click unsubscribe headers** — there is no `docs/research/smtp.md`, so neither the protocol facts a hand-written client would need nor the exact header names and semantics FR-026 depends on are available to a phase, and constitution VI forbids hand-rolling a substitute for a package. The consequence is bounded and stated in FR-004 and FR-005: **everything except the wire transport is specified, built and tested in this entry** against the mailer interface with a recording test mailer — the capability check, the environment group, cadence selection, assembly, quiet hours, DST, the no-double-send bookkeeping, unsubscribe, the delivery log, bounce pausing, the invitation retrofit and every screen. The single task that opens a connection to an SMTP server is marked `NEEDS DEPENDENCY` and left for the session that can install the package; until then an install that configures the SMTP group is told, at startup and in the UI, that email is configured but unavailable, and nothing is silently dropped without a record (FR-005).

## Context and sources

- Roadmap `.specify/roadmaps/notifications.md`, entry **3 of 4**, slug `email-delivery`. The roadmap's goal is to finish the notification story `022-problem-notifications` deliberately left half-built; this entry closes the first item on 022's own Out of Scope list — "notifications outside the app (email, push, chat)" — for email only, and takes the quiet hours entry 2 deliberately handed on.
- It is third because it consumes, unchanged, two things the earlier entries settled: the per-event read and snooze state (entry 1, `specs/042-per-event-read-snooze/`, decisions **N13–N24**) and the per-kind/per-platform eligibility rule (entry 2, `specs/043-notification-preferences/`, decisions **N25–N41**, promised to this entry by **N40**). It adds no new notion of what a person wants to hear about; it decides only *whether and when* what they already want to hear about leaves the building.
- **Behaviour on `main` that this feature builds on** (read from `specs/022-problem-notifications/`, `specs/042-per-event-read-snooze/`, `specs/043-notification-preferences/` and decisions **N1–N41** in `docs/decisions.md`):
  - **Docket has no mailer of any kind.** It sends no email today, and says so in `docs/accounts.md` and `docs/build-prompt.md`.
  - **Invitation delivery is already behind an interface** — `InvitationDelivery` with one `deliver()` method and two result shapes, "in app" for an invitee who already has a login and "manual link" for one who does not, implemented by `defaultInvitationDelivery` and injected into the invitation service. `docs/build-prompt.md` promised exactly this: "keep delivery behind a small interface so email can be added later". Invitation tokens are already unguessable, stored hashed, single-use and expiring (`INVITATION_TTL_DAYS`, default 7).
  - **All-or-none environment groups** follow the media-storage group: setting any member of the group requires every member, setting an optional satellite without the group is a startup validation issue, leaving the group unset turns the whole capability off, and no validation message ever carries a value. The same pattern governs the LLM provider and every social platform's app credentials.
  - **The worker tick is the only recurring server-side execution Docket has.** One bounded run (`SCHEDULER_TICK_BUDGET_SECONDS`, default 20, well under 30 s), reached by `POST /api/internal/tick` with a bearer secret, by the worker container every `WORKER_INTERVAL_SECONDS`, or in-process when `RUN_WORKER_IN_PROCESS` is set. Its sections run concurrently under one deadline, each catching its own failure; it is safe to run in several processes at once and safe to kill mid-run, because work is claimed with `FOR UPDATE SKIP LOCKED` plus a lease, and no outbound call happens inside a held transaction.
  - **The webhook delivery log is the house shape for "we tried to reach something outside Docket"**: an append-only attempts table carrying the attempt number, the instant, a status code, a classified error kind, a duration and a bounded, redacted response excerpt; a delivery row carrying status, attempt count, next attempt, lease owner and lease expiry; retries with exponential backoff and a cap; and an endpoint that disables itself with a recorded reason after enough consecutive failures.
  - **Attention events** are decision **N1**, unchanged by this entry: *failed*, *ambiguous* and *needs reauth* for every member, plus *connect failed* only for the member who attempted it.
  - **What may notify a person** is one rule in one place (`src/lib/notifications/eligibility.ts`, **N39**/**Q4**): the project floor, the per-kind switch and the per-platform switch, ANDed, with absence meaning on and a fresh-start position per switch (**N27**, **N28**, **N35**). Above the floor, a sparse per-event mark means "hidden until" — for ever for read, a finite instant for snoozed (**N15**).
  - **Reads of notification state** go through `src/server/dal/notifications.ts`, whose project-set reader is the one sanctioned cross-project reader; the scheduler's own cross-project work goes through the named `crossProject()` escape hatch, as housekeeping and webhook delivery already do.
  - **Projects carry an IANA time zone; people do not.** Wall-clock arithmetic uses `@js-temporal/polyfill` with explicit DST disambiguation (`"compatible"`), which is how both the scheduler and entry 1's snooze resolver already work.
  - **A person's address is the one on their account** (`user.email`, unique). `user.email_verified` exists because Better Auth's schema has it; nothing in Docket ever sets it.
  - **The public base URL is `BETTER_AUTH_URL`**, already used for invitation links and required to equal the address in the browser. **`BETTER_AUTH_SECRET`** already signs session cookies.
  - **Secrets never leak** (constitution VII): credentials never reach logs, attempt records, error messages or snapshots; the scheduler has a `redact()` helper and a secret-scanning discipline that must stay green.
- No external platform facts are involved beyond SMTP itself, which is `NEEDS RESEARCH` as stated above. One new runtime dependency is expected and is `NEEDS DEPENDENCY`. New environment variables, one new recurring tick section and new tables are expected.
- **Not touched by this entry**: the activity log and its screens, the bell, the panel, the callout, the in-app counting rules, the public API, webhooks, the provider framework, publishing and the queue.

## Decisions made while specifying

These are judgement calls. Planning records each one in `docs/decisions.md`, **next to the decision it replaces or extends**, as the roadmap's rules require. Numbering continues from entry 2 (N25–N41).

### The mailer, and when email exists at all

- **N42 — One mailer capability, shaped like invitation delivery, injected and never imported by a screen.** A single `Mailer` with one method that takes a recipient, a subject and a body in both plain text and a minimal HTML alternative, and returns a classified outcome — sent, permanently rejected, temporarily failed, or unavailable. Email is therefore a capability that is either configured or absent, exactly as media storage is absent without a bucket, and every caller asks one question: "is there a mailer?"
- **N43 — The SMTP group is the two variables that are meaningless alone; credentials are an all-or-none pair that requires the group.** The group is the server host and the address mail is sent from. Username and password are a pair — both or neither — and setting either without the group is an error, because an unauthenticated relay on a private network is a real and common deployment and the group must not force dummy credentials on it. Port and transport security are optional satellites with defaults, and setting any satellite without the group is an error. With the group unset, email is off: nothing is sent, no setting is offered and the UI says so. No validation message ever carries a value.
- **N44 — The wire transport is the one piece this entry cannot finish, and it is marked rather than faked.** `NEEDS DEPENDENCY: nodemailer`, `NEEDS RESEARCH: SMTP`. No hand-rolled SMTP client, no "temporary" call out to a `sendmail` binary, and no silent swallow: with the group configured but the transport unavailable, the capability reports *unavailable*, startup says so once, each would-be send is recorded in the delivery log as unavailable without a retry storm, and no person's bookkeeping advances — so installing the package later starts delivery with nothing lost but time.
- **N45 — Email is opt-in per person, deliberately the opposite of N27's default-on.** N27's rule — absence means "may notify me" — is right for a badge the person only sees when they come looking, and wrong for their inbox. Configuring a mail server must never, by itself, start mailing people who never asked for mail. So the default cadence is **off** for everybody, including people who already have notifications fully on, and nothing in the migration opts anybody in. **This is not a reversal of N27**: N27 governs *which events* may notify a person, and still does, unchanged; N45 governs *which channels* carry them.
- **N46 — Email settings are per person and account-wide; what may be mailed is still the per-project rule.** Cadence, hour, time zone and quiet hours belong to the person's inbox, not to a project, so there is one set of them per person. Which problems may be mailed is **N39**'s one rule, imported unchanged (**N40**): no per-project email switch of its own, no second notion of what someone cares about, and nothing here can mail an event the bell would not count.

### Cadence, and the clock

- **N47 — Three cadences: off, immediate, or a daily digest at a chosen hour.** Immediate and the digest are the *same assembly, at a different due instant* — one query at send time over everything still eligible, never a per-event queue — so there is one body of code, one set of filters and one bookkeeping rule. "Immediate" means "on the next tick after the problem appears", which the install's tick interval makes concrete (a minute by default); the setting says so in words rather than promising instant mail.
- **N48 — The person's time zone is stored with their email settings, and shown in words beside every hour.** A per-person zone is unavoidable: digests, quiet hours and DST are all wall-clock rules, and a person's projects may disagree about the zone. Until the person chooses, Docket uses the zone their projects agree on, and UTC when they do not agree or there are none — a deterministic default, stated on screen, never guessed silently from a request. The control is pre-filled from the browser's zone when client JavaScript is available, and still fully usable without it.
- **N49 — Quiet hours govern immediate mail only; a chosen digest hour is exempt.** A digest hour is an explicit instruction ("07:00, please"), so honouring quiet hours over it would be Docket overriding the person. Inside quiet hours, immediate mail is **deferred, never dropped**: everything still eligible when the window ends arrives as **one** message at the window's end, not as a burst of the messages that were held back.
- **N50 — Wall-clock rules are resolved per local day with explicit DST disambiguation.** A due hour that does not exist on a spring-forward day sends at the next instant that does; a due hour that happens twice on a fall-back day sends **once**, at the first occurrence. Quiet-hour windows may wrap midnight. Resolved instants are stored absolute and never recomputed, which is entry 1's snooze rule (**M8**) applied to a second kind of wall-clock promise.
- **N51 — The filter runs at send time, never at queue time.** A problem the person has read, dismissed or snoozed in the app, or that a preference switch excludes, is not mailed — including when it became read or ineligible in the minutes between appearing and the mail going out. A snoozed problem that is still snoozed at send time is not mailed, and is mailed after the snooze runs out if it is still eligible then.
- **N52 — An empty message is never sent.** Nothing eligible means no mail, no "all clear", no bookkeeping change, and the next due instant simply rolls forward.
- **N53 — A missed digest is sent late only while it is still the same local day.** A worker that was down for two hours sends the digest two hours late; a worker that was down for two days does not send a two-day-old digest at a random hour — that digest is skipped and its problems appear in the next one, because the mailed-through position only advances on an actual send, so nothing is lost.

### Never twice

- **N54 — Never twice, even at the cost of never.** A crash between handing a message to the mail server and recording that it was handed over leaves an unknowable outcome, and an unknowable outcome is **recorded as sent and never retried** — the same choice constitution V makes for publishing ("a missed post beats a duplicate post"), for the same reason: a duplicate problem email teaches people to filter Docket into the bin.
- **N55 — What has been mailed is a forward-only position per person and project**, mirroring the read floor: a problem at or below it is never mailed again, whatever happens to its read state, its snooze or its preferences afterwards. A person's bookkeeping also carries their next due instant and a claim, so two processes ticking at once, and a tick killed mid-run, cannot both send.

### Getting out of it

- **N56 — The unsubscribe link carries a signed, scoped, expiring token and names nobody.** No user id, no address, no project slug and no event id in the URL: a token that states who it is for and what it may change, signed with the server's existing secret, rejected on tamper or expiry, and useless for anything but turning email off. It outlives the mail that carries it by a wide margin (60 days) and is not single-use, because a person who finds the mail a month later must still be able to act on it.
- **N57 — The link lands on a page with one pre-filled submit; it does not act on the GET.** Mail clients, security scanners and corporate gateways fetch the links in mail without being asked to, and a GET that unsubscribes people silently unsubscribes them. A mail client's **own** unsubscribe button — the one-click path mail clients already know how to use — does act immediately, because that one is unambiguously the person pressing it. Either way the page afterwards says, in plain words, exactly what was turned off and what is still on.
- **N58 — One click turns off every problem email for that person**, which is what someone pressing "unsubscribe" in anger means. The same page then offers the two finer things they might have meant — stop just this project's problems, or switch to one digest a day — and a way to turn it back on, all without signing in beyond the token's scope. Turning email off never changes their in-app notifications: the bell is not an inbox (**N5**'s "hides, does not delete", applied to channels).
- **N59 — Being unsubscribed is a fact about the person's settings, not a separate flag.** One-click sets the cadence to off; the per-project variant records that project as excluded from email only. There is no second "suppressed" state that can disagree with the settings screen — the lesson of **N26**.

### Failure, and what is written down

- **N60 — The delivery log stores no body, no subject, no recipient address and no free text from the SMTP conversation.** One row per attempt: which person (by reference), which cadence, how many problems it covered, the outcome class, the numeric SMTP code, the duration and the instant. A server's refusal text routinely quotes the recipient address, so it is classified and discarded rather than excerpted — the one place this entry deliberately departs from the webhook log's shape, and the reason is the roadmap's secrets rule.
- **N61 — Repeated failure or a permanent rejection pauses that person's email with a reason they can see.** A permanent rejection pauses immediately; temporary failures retry with backoff and pause after enough consecutive ones — the webhook endpoint's self-disabling rule, with the person, not an operator, able to resume it. A paused person still has every in-app notification.
- **N62 — Only a rejection during the conversation is a bounce.** Docket receives no mail, so a delivery report that arrives later at the sending address is invisible to it. That is stated plainly in the docs rather than implied by silence, and inbound mail is out of scope.
- **N63 — A person sees their own delivery outcome and nobody else's.** Their settings show when email was last sent to them, whether the last attempt failed, and why, in plain words. There is no administrative view of anyone's delivery log, no public-API operation for it, and no cross-person page.

### Invitations

- **N64 — Invitations are transactional and are emailed whenever email exists, in addition to today's in-app notification.** They are a direct, person-to-person act with a 7-day deadline, so they are not governed by cadence, quiet hours, preferences or the digest, and they carry no unsubscribe — there is nothing recurring to unsubscribe from. The invitee who already has a login keeps the in-app invitation exactly as it is today, and is also mailed, because they may not be signed in.
- **N65 — The fallback is today's behaviour, unchanged, and the inviter is always told which happened.** No email configured, email unavailable, or a send that fails: the inviter gets the copyable single-use link exactly as now. When the mail went out, the inviter is told so and the link is still shown, because a mail that never arrives must not strand an invitation. The link, the token, its hashing, its single use and its expiry do not change.
- **N66 — Docket mails the address on the account and does not require it to be verified.** Nothing in Docket verifies addresses — the address came from an invitation or the operator's bootstrap — so demanding verification would mean mailing nobody. A permanently rejected address pauses that person's email (**N61**), which is the honest version of the same protection.
- **N67 — An email reveals nothing the person could not already see.** Each problem names its project and links into Activity, which still requires signing in; no credential, no token beyond the unsubscribe scope, and no other person's data appears. A digest spans only the person's own projects.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Hear about a problem without being signed in (Priority: P1)

Someone who looks at Docket twice a week turns on immediate email. A scheduled post fails on Tuesday night; within a minute they have an email naming the project, the account and what went wrong, with a link to it in Activity. They fix it on Wednesday morning instead of the following Monday.

**Why this priority**: This is the entry. Every other story here refines when the mail goes out; this one is the reason there is any mail at all.

**Independent Test**: Configure a recording mailer, turn immediate email on for a person, write one failed attention event in their project, run one tick, and check exactly one message was handed over, addressed to them, naming that problem, with a link into Activity and an unsubscribe link — and that a second tick sends nothing.

**Acceptance Scenarios**:

1. **Given** a person with immediate email on and no problems, **When** a failed event appears in a project they belong to, **Then** the next tick sends them exactly one message naming that problem, its project and its account, and a following tick sends nothing more.
2. **Given** two problems appearing a few seconds apart, **When** the next tick runs, **Then** they arrive as one message listing both, not as two messages.
3. **Given** a problem of a kind or platform the person has switched off, or in a project where every kind is off, **When** ticks run, **Then** no message mentions it and nothing else is suppressed.
4. **Given** a person who has not turned email on, **When** problems appear, **Then** they are sent nothing, ever, and their bell behaves exactly as before.
5. **Given** a person whose only problem was marked read, dismissed or snoozed in the app before the tick ran, **When** the tick runs, **Then** no message is sent.
6. **Given** a snoozed problem whose snooze has run out and which is still eligible, **When** the next tick runs, **Then** it is mailed.
7. **Given** a person in several projects with problems in more than one, **When** a message is assembled, **Then** it covers only their own projects, grouped by project, and nothing from a project they do not belong to.

---

### User Story 2 - One email a day, at an hour I choose (Priority: P1)

Someone who does not want to be interrupted picks a daily digest at 07:00. Each morning at 07:00 their time they get one message listing the problems that still need them, and nothing at all on a day where there is nothing to say.

**Why this priority**: A digest is what makes email bearable for anyone running busy projects, and the roadmap names it as the per-person choice beside immediate.

**Independent Test**: With a person on a 07:00 digest in a named zone, seed problems through the day, run ticks every simulated minute across the whole day, and check exactly one message is handed over, after 07:00 local, listing every still-eligible problem once; then repeat on a day with nothing eligible and check nothing is sent.

**Acceptance Scenarios**:

1. **Given** a 07:00 digest and problems from the previous day, **When** ticks run through the day, **Then** exactly one message is sent, at or just after 07:00 in the person's zone, listing each still-eligible problem once.
2. **Given** a digest day where every problem was read, snoozed or made ineligible before the hour, **When** the hour passes, **Then** nothing is sent and no state changes.
3. **Given** a digest was sent this morning, **When** new problems appear during the day, **Then** they wait for tomorrow's digest and no message goes out in between.
4. **Given** the worker was down from 06:00 until 09:00, **When** it starts, **Then** the 07:00 digest is sent once, late, on the same local day.
5. **Given** the worker was down for two days, **When** it starts, **Then** no stale digest is sent, and the next due digest contains the problems that are still eligible, each exactly once.
6. **Given** a person switching from immediate to digest, or back, **When** the change is saved, **Then** nothing already mailed is mailed again, and nothing eligible is lost.
7. **Given** a digest hour on a day when the person's zone skips that hour, **When** that day passes, **Then** exactly one digest is sent at the next instant that exists; **given** a day where the hour happens twice, **Then** exactly one digest is sent, at the first occurrence.

---

### User Story 3 - Not at three in the morning (Priority: P2)

Someone on immediate email sets quiet hours from 22:00 to 07:00. A post fails at 02:14; their phone stays quiet, and at 07:00 they get one message with that failure and anything else that happened overnight.

**Why this priority**: It is the piece entry 2 deliberately handed on, and the difference between email people keep on and email people turn off. It is P2 only because immediate and digest email are useful before it exists.

**Independent Test**: With immediate email and quiet hours 22:00–07:00, write problems at 23:00, 02:00 and 06:30 local, run ticks every simulated minute, and check nothing is handed over before 07:00 and that exactly one message at 07:00 contains all three.

**Acceptance Scenarios**:

1. **Given** quiet hours and a problem appearing inside them, **When** ticks run, **Then** nothing is sent until the window ends, and nothing is dropped.
2. **Given** several problems appearing through the quiet window, **When** it ends, **Then** they arrive as one message, not one per problem.
3. **Given** a problem that was read or snoozed during the quiet window, **When** the window ends, **Then** it is not in the message, and an otherwise empty message is not sent.
4. **Given** quiet hours that wrap midnight and a person whose zone changes offset inside the window, **When** the window ends, **Then** it ends at the correct local hour on that day, once.
5. **Given** a person on a digest whose chosen hour falls inside their own quiet hours, **When** the hour comes, **Then** the digest is sent — the explicit choice wins — and that is stated on the settings screen.
6. **Given** quiet hours set to an empty window, **When** problems appear, **Then** immediate email behaves as if none were set.

---

### User Story 4 - Stop the email from the email, without signing in (Priority: P1)

Someone on holiday gets a problem email, presses "unsubscribe" at the bottom, and is told in one page exactly what has been turned off — with the option to keep a daily digest instead, or to silence only the project that is noisy — without a login and without finding the right settings screen.

**Why this priority**: Mail nobody can stop is mail that gets reported as spam, and the roadmap requires it to work without a session. It is also the only write path in this entry reachable by someone holding no session at all.

**Independent Test**: Take the unsubscribe link out of a sent message. Check it contains no user id, address or project slug; that fetching it changes nothing; that submitting the page turns email off and says so; that a tampered, truncated or expired token is refused with the same neutral page and changes nothing; and that the mail client's one-click path turns email off directly.

**Acceptance Scenarios**:

1. **Given** any problem email, **When** it is examined, **Then** it carries an unsubscribe link whose address contains no user id, no email address, no project slug and no event id, plus the standard header that lets a mail client offer its own unsubscribe button.
2. **Given** the link, **When** it is merely fetched (by a scanner, a preview or a prefetch), **Then** nothing changes and a page with one clearly labelled submit is shown.
3. **Given** the page, **When** the submit is used, **Then** every problem email for that person stops, the page says exactly that, says what is still on (their in-app notifications), and offers a daily digest instead and a way back.
4. **Given** the page, **When** the per-project option is used, **Then** only that project stops being emailed, the page names it, and other projects still are.
5. **Given** a tampered, truncated, re-signed or expired token, **When** it is used, **Then** it is refused with one neutral page, nothing is written, and the response reveals nothing about whether a person, project or token exists.
6. **Given** a token whose person no longer exists, **When** it is used, **Then** nothing is written and the same neutral page is shown; **given** a token naming a project the person has since left, **When** the per-project option is used, **Then** nothing is written and the page reveals nothing about that project.
7. **Given** email was already off, **When** the link is used again, **Then** it still succeeds and still says what the state is — using it twice is not an error.
8. **Given** a mail client's own one-click unsubscribe, **When** it is pressed, **Then** email for that person stops with no page and no session.

---

### User Story 5 - An operator turns email on, and an install without it is untouched (Priority: P1)

An operator adds a mail server to their configuration and restarts; the email settings appear for every member. An operator who does not adds nothing, sees nothing new, and notices no difference anywhere in Docket. An operator who sets half of it is told which variable is missing, by name, before the app serves a request.

**Why this priority**: Most self-hosted installs will never configure SMTP, and they must be exactly as they are now. The all-or-none group is the roadmap's explicit requirement and the only owner-only part of this entry.

**Independent Test**: Validate the environment with: nothing set; the full group; one group member missing; a satellite set without the group; a username without a password. Check which combinations are accepted, that every message names the variable and carries no value, and that with nothing set no email setting, screen, control or tick work exists.

**Acceptance Scenarios**:

1. **Given** no mail configuration, **When** Docket starts, **Then** it starts normally, every person's email cadence reads as unavailable rather than off-by-choice, the reason is stated, and no mail is ever attempted.
2. **Given** some but not all of the group, **When** the environment is validated, **Then** each missing variable is reported by name with a reason, no value appears in any message, and the app refuses to serve rather than half-working.
3. **Given** an optional satellite set with no group, **When** the environment is validated, **Then** it is reported as an error pointing at the group, in the same words the storage group uses.
4. **Given** a username with no password, or a password with no username, **When** the environment is validated, **Then** it is reported; **given** neither, **Then** the configuration is accepted and the relay is used unauthenticated.
5. **Given** the full group, **When** Docket starts, **Then** every member role sees their own email settings, and the settings name no variable and print no command to anyone who is not an owner.
6. **Given** the group is configured but the transport is unavailable (`NEEDS DEPENDENCY`), **When** mail would be sent, **Then** startup says so once, each would-be send is recorded as unavailable, no person's bookkeeping advances, nothing is retried in a tight loop, and no person is told a lie about having been emailed.
7. **Given** an install that later removes the configuration, **When** it restarts, **Then** nothing is sent, stored settings are kept untouched for the day it comes back, and the screens say email is unavailable.

---

### User Story 6 - Never twice, and nothing lost (Priority: P1)

The worker is killed mid-send, two workers tick at the same moment, and a send times out with an unknowable outcome. Nobody gets the same problem email twice. (Restoring the database to a point before a send is the one case Docket cannot defend against — the bookkeeping goes back with everything else — and the documentation says so rather than implying otherwise.)

**Why this priority**: Duplicate problem mail is the failure that loses the channel for good, and the roadmap asks for bookkeeping that survives a crash. The tick is also shared, bounded work: email must not starve publishing.

**Independent Test**: Run two ticks concurrently against the same due person and check one message. Kill the process between handing over and recording and check the next tick sends nothing for that window. Run with a mailer that throws after accepting, and one that hangs past the budget, and check the recorded outcome and that no second message follows.

**Acceptance Scenarios**:

1. **Given** two processes ticking simultaneously with the same person due, **When** both run, **Then** exactly one message is handed over and the other process does other work.
2. **Given** a process killed after the mail server accepted the message but before it was recorded, **When** the next tick runs, **Then** that window is treated as sent and is not sent again.
3. **Given** a mailer that fails temporarily, **When** ticks run, **Then** it is retried with increasing delay, the attempts are recorded, and the content is re-assembled at each attempt rather than replayed from a queue.
4. **Given** repeated temporary failures, **When** the threshold is reached, **Then** that person's email is paused with a reason they can see and resume, and no further attempt is made until they do.
5. **Given** a permanent rejection of the address, **When** it happens, **Then** email for that person is paused at once with a reason, and their in-app notifications are untouched.
6. **Given** the tick's time budget is nearly spent, **When** the email section runs, **Then** it stops cleanly inside the budget, leaves the rest due, and does not delay or fail publishing, generation, webhooks or housekeeping.
7. **Given** many people due at once, **When** ticks run, **Then** the longest-waiting are served first and everyone is served within a bounded number of ticks.
8. **Given** a person removed from a project, or whose account is deleted, **When** that happens, **Then** their pending email work and bookkeeping for it go with the membership, in the same transaction, and no mail about that project follows.

---

### User Story 7 - Invitations arrive by email, and still work when they cannot (Priority: P2)

An owner invites a new colleague. With a mail server configured the invitation is emailed and the owner is told so, with the link still on screen if they want to send it themselves. On an install with no mail server, the owner gets exactly today's copyable link.

**Why this priority**: It is the promise `docs/build-prompt.md` made when the delivery interface was introduced, and the most visible everyday use of the new mailer. It is P2 because the roadmap's subject is problem notifications.

**Independent Test**: Invite an address with no Docket account, and one with an account, in each of three conditions — no mail configured, mail configured and accepting, mail configured and failing — and check the nine outcomes: what was mailed, what the inviter is told, that the link still works, and that the invitation itself is unchanged.

**Acceptance Scenarios**:

1. **Given** mail is configured and the invited address has no account, **When** the invitation is created, **Then** it is emailed with the single-use link, the inviter is told it was emailed, and the link is still shown to copy.
2. **Given** mail is configured and the invited address already has an account, **When** the invitation is created, **Then** they get the in-app invitation exactly as today **and** an email, naming the project, the role and the deadline.
3. **Given** mail is not configured, **When** the invitation is created, **Then** the flow is exactly today's: in-app for an existing account, otherwise the copyable link, with no mention of email.
4. **Given** mail is configured but the send fails or is unavailable, **When** the invitation is created, **Then** the invitation still exists, the inviter is shown the copyable link and told plainly that the email did not go out, and the failure is recorded without storing the address.
5. **Given** an invitation email, **When** it is examined, **Then** it carries no unsubscribe link, is not affected by cadence or quiet hours, and is sent whatever the invitee's email settings say.
6. **Given** a revoked, expired or already-used invitation, **When** its link is used, **Then** it behaves exactly as today; emailing changed nothing about tokens, hashing, single use or expiry.
7. **Given** an invitation is regenerated, **When** that happens, **Then** the new link is emailed if mail is configured, and the old one stops working as today.

---

### User Story 8 - Nothing leaks (Priority: P1)

The mail server's password, the person's address and the body of every message stay out of the logs, the stored records, the error messages and the tests' snapshots — including when the server refuses the message with the address quoted in its reply.

**Why this priority**: The roadmap makes this a rule of the entry, and this is the first feature in Docket that handles both a credential and a personal address on the same path.

**Independent Test**: Run every failure path — bad credentials, refused recipient, transport-security failure, timeout, a 5xx quoting the address — with logging captured, and assert no configured credential, no address and no message body appears in any log line, stored row, returned error or test snapshot. Run the secret-scanning test.

**Acceptance Scenarios**:

1. **Given** any failure, **When** it is handled, **Then** no configured credential and no part of one appears in any log line, stored row, response or snapshot.
2. **Given** a server reply that quotes the recipient address, **When** the attempt is recorded, **Then** only a classified outcome and the numeric code are stored; the reply text is not.
3. **Given** any attempt, **When** the delivery log is read, **Then** it holds no message body, no subject text, no address, and refers to the person by reference only.
4. **Given** a person's own settings, **When** they look, **Then** they can see their own last outcome and reason in plain words, and nothing about anyone else.
5. **Given** an unsubscribe token, **When** anything other than the message it was minted for is examined, **Then** the token does not appear: tokens are never logged and never stored in clear.
6. **Given** the secret-scanning test, **When** the suite runs, **Then** it is green.
7. **Given** an API key instead of a session, **When** any email setting is read or changed, **Then** it is refused; there is no public-API operation for email.

---

### Edge Cases

- A person belongs to no project, or to projects where every kind is off: no mail is ever assembled for them, and the settings say so plainly rather than promising mail that cannot come.
- A problem appears a second after a digest was sent: it waits for the next digest, and the mailed-through position proves it was not already covered.
- A person changes their digest hour from 07:00 to 06:00 at 06:30, with today's 07:00 digest not yet sent: exactly one digest is sent today, and changing the hour never produces two in one day or silently skips a day's problems.
- A person changes their time zone: the next due instant is recomputed from the new zone, and no already-sent window is re-sent.
- A person's zone is one the system does not recognise (removed from the zone database, or stored before an upgrade): it falls back to UTC, says so on screen, and nothing crashes.
- Immediate cadence with a tick interval of a minute, and twenty problems appearing in that minute: one message listing twenty, inside the tick budget.
- The same person is due for both a deferred quiet-hours batch and a digest at the same instant: one message, not two.
- The mail server accepts the message and then silently drops it: Docket records it as sent, because that is all SMTP can tell it, and the docs say so.
- The mail server is unreachable for a day: attempts back off, the person is paused with a reason after the threshold, and when they resume, the still-eligible problems are mailed — not a day of history.
- An address is rejected permanently and the person later changes the address on their account: the pause is theirs to lift, and the new address is used from then on.
- Two tabs change email settings at once: the later write wins, and no change can cause an already-sent window to be sent again.
- An unsubscribe token signed with a secret that has since been rotated: it is refused as tampered, with the same neutral page, and the person can still change everything after signing in.
- A project is renamed or deleted between assembly and sending: the message names what it knew at assembly; a deleted project's problems are not mailed.
- The transport is installed on an install that has been running configured-but-unavailable for a week: the first tick afterwards mails what is still eligible, once, and not a week of backlog.
- The tick runs in-process on a single-container install: the email section behaves identically and still respects the budget.
- A project has a very bad day and produces hundreds of problems: the message lists the bounded number and says how many more there are, with a link; the position advances over the counted overflow as well as the listed problems, so a bad day produces one message rather than a run of them.
- The database is restored to a point before a send: the mailed-through position goes back with it, so that one message may arrive twice. This is the single case the no-double-send rule cannot cover, and `docs/deployment.md` says so beside the backup instructions rather than leaving an operator to discover it.
- A person at entry 1's 200-mark cap, or whose project floor has risen past everything: neither changes what is mailed beyond the eligibility rule saying there is nothing to mail.

## Requirements *(mandatory)*

### Functional Requirements

**Configuration, and the capability**

- **FR-001**: The system MUST treat email as a capability that is present only when it is configured, through one all-or-none environment group whose members are the server host and the sending address, with username and password an all-or-none pair that requires the group, and port and transport security optional satellites with documented defaults (N43). Setting any group member MUST require all of them; setting any satellite without the group MUST be a startup validation issue; setting one credential without the other MUST be a startup validation issue.
- **FR-002**: With the group unset, the system MUST send no mail, MUST offer no email setting as an available choice, MUST state that email is unavailable wherever it would otherwise be offered, and MUST behave in every other respect exactly as it does today.
- **FR-003**: No validation message, log line or screen MUST ever contain the value of any mail variable. Messages shown to people who are not owners MUST NOT name variables or print commands; they MUST point at the documentation (roadmap rule, N43).
- **FR-004**: The mailer MUST be reached through one interface with a single send operation and a classified outcome — sent, permanently rejected, temporarily failed, or unavailable — mirroring the invitation-delivery interface in shape, injectable, and never imported by a screen or a server action directly (N42). Every behaviour in this specification other than the wire transport MUST be testable through that interface with a recording test mailer and no network.
- **FR-005**: The default implementation MUST speak SMTP using an installed mail package. The system MUST NOT hand-roll an SMTP client and MUST NOT shell out to a mail binary (N44, constitution VI). Until the package is installed, the implementation task MUST be marked `NEEDS DEPENDENCY: nodemailer` and the capability MUST report *unavailable* when the group is configured: startup MUST say so once, each would-be send MUST be recorded as unavailable, no person's send bookkeeping MUST advance, nothing MUST be retried in a tight loop, and no person MUST be told that mail was sent.

**What a person chooses**

- **FR-006**: The system MUST keep, per person, an email cadence of exactly one of: off, immediate, or a daily digest at a chosen hour (N47); a time zone (N48); and an optional quiet-hours window that may wrap midnight (N49).
- **FR-007**: The default cadence for every existing and every new person MUST be off (N45). No migration, upgrade or configuration change MUST ever turn a person's email on.
- **FR-008**: Email settings MUST be per person and MUST NOT be per project (N46). Until a person chooses a time zone, the system MUST use the zone their projects agree on and UTC otherwise, MUST state the zone in words beside every hour it governs, and MUST NOT infer a zone silently from a request.
- **FR-009**: Which problems may be mailed MUST be decided by the existing one eligibility rule — the project floor, the per-kind switch and the per-platform switch — imported unchanged (N46, consuming N39/N40). This feature MUST NOT add any second notion of which events a person cares about, and MUST NOT mail any event that rule finds ineligible.
- **FR-010**: Every member role MUST be able to set their own email settings; nothing here MUST be owner-only except the server configuration (roadmap rule, N10 unchanged). A person MUST only ever read or change their own.

**Assembly**

- **FR-011**: A message MUST be assembled at send time from the problems that are eligible then, grouped by project, each naming its project, its platform or account where it has one, what went wrong in plain words, when it happened in the person's zone, and a link into Activity (N47, N67). Nothing MUST be queued per event. A message MUST list at most a bounded number of problems — the bound fixed in the plan — and MUST say how many more there are with a link to see them, so that a bad day cannot produce an unreadable message.
- **FR-012**: Assembly MUST exclude every problem the person has read, dismissed or snoozed, and everything a preference switch excludes, as at the moment of sending (N51). A snooze that has run out MUST make its problem mailable again if it is still eligible.
- **FR-013**: The system MUST NOT send a message with nothing in it (N52). When there is nothing to send, no mailed-through position MUST advance and no attempt MUST be recorded; only the next due instant moves on.
- **FR-014**: A message MUST carry a plain-text part and a minimal HTML alternative rendering the same content, with the text part authoritative; it MUST be readable without images, without remote content, and without colour alone conveying anything.
- **FR-015**: A message MUST reveal nothing the recipient could not already see in Docket, MUST cover only projects they currently belong to, and MUST NOT include any credential, any token other than its own unsubscribe scope, or any other person's data (N67).

**Timing**

- **FR-016**: Immediate cadence MUST send on the first tick after an eligible problem appears, outside quiet hours, and MUST coalesce everything eligible at that moment into one message (N47).
- **FR-017**: A digest MUST be due at the chosen hour in the person's zone, MUST be sent at most once per local day, and MUST be sent late if the worker was unavailable at the hour — but only while it is still the same local day in that zone; otherwise it MUST be skipped with its problems rolling into the next due message (N53).
- **FR-018**: Inside quiet hours, immediate mail MUST be deferred to the end of the window and MUST then be sent as one message, never dropped and never as a burst of held-back messages (N49). A chosen digest hour MUST be exempt from quiet hours, and the screen MUST say so.
- **FR-019**: Every wall-clock rule — the digest hour and both ends of the quiet window — MUST be resolved per local day with explicit DST disambiguation: a non-existent hour MUST resolve to the next instant that exists, and an hour that occurs twice MUST produce exactly one send, at its first occurrence (N50). Resolved instants MUST be stored absolute and MUST NOT be recomputed afterwards.
- **FR-020**: Changing cadence, hour, zone or quiet hours MUST take effect from the change onwards, MUST NOT re-send anything already sent, and MUST NOT cause two messages in one local day or silently skip a day's problems.

**Never twice**

- **FR-021**: The system MUST record, per person and per project, a forward-only position covering what has been mailed; a problem at or below it MUST NEVER be mailed again, whatever happens to its read state, snooze or preferences afterwards (N55). When a message reports an overflow count instead of listing every problem (FR-011), the position MUST advance over the counted overflow too, so one bad day produces one message and not a run of them.
- **FR-022**: Sending MUST be claimed with a lease so that concurrent ticks and a tick killed mid-run cannot both send; an unknown outcome — a crash or a timeout between handing the message over and recording it — MUST be recorded as sent and MUST NOT be retried (N54).
- **FR-023**: A temporary failure MUST be retried with increasing delay up to a cap, with each attempt re-assembling the content rather than replaying a stored message. A stated number of consecutive temporary failures — fixed in the plan, as the webhook endpoint's self-disabling threshold is — or one permanent rejection, MUST pause that person's email with a reason they can see and resume themselves (N61). A pause MUST NOT affect their in-app notifications.
- **FR-024**: The email work MUST run as a section of the existing worker tick, inside its time budget, claiming work the way the tick already claims work — so that several processes may tick at once and a tick may be killed mid-run without losing or duplicating work — serving the longest-waiting first, and MUST NOT delay or fail publishing, token refresh, generation, webhooks or housekeeping (roadmap, constitution engineering constraints). No send MUST happen while a database transaction is held open.
- **FR-025**: A person's pending email work and their per-project mailed-through position MUST be deleted with the membership, in the same transaction, and with the project or the user (N8's shape, unchanged).

**Getting out of it**

- **FR-026**: Every problem email MUST carry an unsubscribe link whose address contains a signed, scoped, expiring token and no user identifier, address, project slug or event identifier, plus the standard headers that let a mail client offer its own unsubscribe button (N56). Those header names and their exact semantics MUST come from research, not memory (`NEEDS RESEARCH`, constitution I).
- **FR-027**: Fetching the link MUST change nothing; it MUST render a page with one clearly labelled submit (N57). A mail client's own one-click unsubscribe MUST act immediately without a page and without a session. After acting, the page MUST state exactly what was turned off and what remains on.
- **FR-028**: The one-click meaning MUST be "stop every problem email for this person" (N58). The page MUST additionally offer stopping only one named project's problem email, switching to a daily digest, and a way back, all within the token's scope and without a login.
- **FR-029**: A tampered, truncated, re-signed, expired or unknown token MUST be refused with one neutral page that writes nothing and reveals nothing about whether any person, project or token exists. A token whose person is gone, or whose per-project scope names a project the person has left, MUST write nothing and MUST give the same page. Using a valid token twice MUST succeed and MUST be idempotent (N56).
- **FR-030**: Being unsubscribed MUST be stored as the person's own settings — cadence off, or that project excluded from email — and MUST NOT introduce a second suppression state that can disagree with the settings screen (N59). Turning email off MUST NOT change any in-app notification.
- **FR-031**: Tokens MUST NOT appear in any log line, any stored row in clear, any response other than the message they were minted for, or any test snapshot.

**Written down**

- **FR-032**: Every attempt MUST be recorded: which person (by reference), the cadence, how many problems it covered, the outcome class, the numeric code where there is one, the duration and the instant — in the shape of the webhook delivery log (N60).
- **FR-033**: The delivery record MUST contain no message body, no subject text, no recipient address and no free text from the mail server's replies (N60, roadmap secrets rule). Failures MUST be classified — unavailable, refused, rejected permanently, timed out, connection failed, transport security failed, internal — and the reply text MUST be discarded.
- **FR-034**: No configured credential, no part of one, and no recipient address MUST reach any log line, error message, attempt record, response or test snapshot; the secret-scanning test MUST stay green (roadmap secrets rule, constitution VII).
- **FR-035**: A person MUST be able to see, in their own settings, when email was last sent to them, whether the last attempt failed, the reason in plain words, and whether their email is paused, with a control to resume (N63). There MUST be no view of anyone else's delivery log, and no public-API operation for email.
- **FR-036**: Only a rejection during the mail conversation MUST be treated as a bounce; asynchronous delivery reports MUST be documented as invisible to Docket (N62).

**Where it is set**

- **FR-037**: The personal Notifications page MUST gain the email settings — cadence, hour, zone, quiet hours, the paused state and the last outcome — as one section, using the existing primitives, fully keyboard operable with visible focus and labelled controls, working with no client JavaScript, and confirming each change in words (roadmap rules, `docs/design-system.md`, the docket-ui skill).
- **FR-038**: The settings MUST say in words: that email carries only problems, not successes; that it follows the per-project kind and platform switches already set; that turning it off leaves the in-app notifications untouched; that a digest hour is honoured even inside quiet hours; and what "immediate" means on this install. Where email is unavailable, they MUST say so instead of offering a choice that cannot work.
- **FR-039**: The unsubscribe landing page MUST be reachable with no session, MUST follow the same accessibility rules, and MUST NOT require client JavaScript.

**Invitations**

- **FR-040**: When email is available, an invitation MUST be emailed — naming the project, the role, who invited them and the deadline — in addition to the unchanged in-app invitation for an invitee who already has a login (N64). It MUST carry no unsubscribe and MUST NOT be governed by cadence, quiet hours or notification preferences.
- **FR-041**: When email is unavailable, or the send fails, the flow MUST be exactly today's: in-app for an existing account, otherwise the copyable single-use link (N65). The inviter MUST always be told which happened, and the copyable link MUST remain available even when the email was sent. The invitation record, its token, its hashing, its single use and its expiry MUST NOT change.
- **FR-042**: A failed invitation email MUST be recorded under the same rules as any other attempt (FR-032, FR-033) and MUST NOT roll back the invitation.

**Isolation, authorization and migration**

- **FR-043**: Every read of notification state for email MUST stay pinned to one project, or go through the one sanctioned cross-project reader or the named cross-project escape hatch the scheduler already uses, and MUST pass the project-scope test harness (constitution III).
- **FR-044**: Every email setting path MUST be the caller's own: sessions only, API keys refused, another person's settings unreachable, and a request naming a project the caller does not belong to indistinguishable from one naming a project that does not exist (N41's shape, unchanged).
- **FR-045**: Schema changes MUST ship as committed SQL migrations, MUST leave the committed migrations and the schema in agreement, MUST be safe to apply to a live install with existing rows with no operator step, and MUST NOT reset or alter any notification state — no reading floor, sparse mark or preference row (roadmap rule).

**Docs and tests**

- **FR-046**: `.env.example` MUST document every new variable in the house format (Required/Optional/Group, what it does, format, default). `docs/build-prompt.md`'s "Invitation delivery, for now, uses no email at all" and `docs/accounts.md`'s "Docket sends no email" MUST be corrected to describe both paths. `docs/deployment.md` MUST cover configuring a mail server, what happens without one, and that delivery reports are invisible to Docket; `docs/activity.md`'s Notifications section MUST describe email, cadence, quiet hours and unsubscribe; `docs/n8n.md` MUST stay the answer for automation. The decisions N42–N67 MUST be appended to `docs/decisions.md`, each next to the decision it extends or departs from (N5, N6, N10, N27, R1, R14 and the webhook-log decisions), stating what changes and what does not.
- **FR-047**: The specification, plan and docs MUST state what this entry does not do and which later entry owns it: real-time transport (`realtime-updates`), and — owned by nothing in this roadmap — push and chat delivery, success notifications, per-event actions inside an email, and inbound mail.
- **FR-048**: Tests MUST cover:
  - **the environment group**: nothing set (email off, nothing offered, nothing attempted); the full group; each group member missing; each satellite without the group; a username without a password and vice versa; no credentials at all accepted; and that no message carries a value;
  - **cadence selection**: off sends nothing ever; immediate on the next tick; digest once per local day at the chosen hour; a switch between cadences mid-day; a person with no projects and a person with every kind off;
  - **quiet hours**: deferral to the window end as one message; a window that wraps midnight; across two zones with different rules; across both DST transitions in each direction, including a window end in a skipped hour and in a repeated hour; a digest hour inside quiet hours still sending;
  - **DST and zones**: a digest hour that does not exist; one that occurs twice sending exactly once; a zone change by the person; an unrecognised stored zone falling back;
  - **assembly**: read, dismissed, snoozed, expired-snooze, kind-off, platform-off and below-floor events excluded; multi-project grouping; a problem appearing just after a send; the 100-cap interaction; nothing sent when nothing is eligible;
  - **no double-send**: two concurrent ticks; a tick killed between handing over and recording; a mailer that throws after accepting; a mailer that hangs past the budget; the forward-only position never moving backwards;
  - **failure and pausing**: temporary-failure backoff; the consecutive-failure threshold; a permanent rejection pausing at once; resume by the person; that pausing never touches in-app notifications;
  - **the tick**: inside the budget; concurrent-safe; kill-safe; fairness across many due people; no effect on the other sections; in-process mode;
  - **unsubscribe**: the link containing no identifier; a GET changing nothing; the submit turning email off; the per-project variant; the digest-instead variant; tamper, truncation, re-signing with another secret, and expiry all refused identically; a token for a deleted person or an ended membership; reuse being idempotent; the mail-client one-click path;
  - **invitations**: all nine combinations of invitee-has-account × (no email, email accepting, email failing); the email's contents; no unsubscribe on it; the inviter's message; the link still working; regeneration; revoked, expired and used links unchanged;
  - **secrets**: every failure path with logs captured, asserting no credential, address or body appears in any log line, stored row, response or snapshot; the reply text discarded; tokens never logged; the secret-scanning test green;
  - **authz and isolation**: sessions only; API keys refused; another person's settings unreachable; a foreign and a non-existent project indistinguishable; the project-scope harness; membership removal and rollback; project and user deletion;
  - **migration**: applied to an install with existing notification rows, changing no floor, mark or preference, turning nobody's email on, and leaving schema and migrations in agreement;
  - **the screens**: the settings section in each state (unavailable, off, immediate, digest, paused, last failure), keyboard operation, accessible names, confirmations, and both it and the unsubscribe page working with no client JavaScript.

### Key Entities

- **Mailer** (not stored): the capability — present or absent — that takes one message for one address and reports sent, rejected permanently, failed temporarily, or unavailable.
- **Email settings**: for one person — cadence (off, immediate, digest), the digest hour, their time zone, the quiet-hours window, whether email is paused and why, and the instant they were last mailed. Default off for everybody (FR-007). Deleted with the user.
- **Email exclusion**: for one person and one project, that this project's problems are not emailed (set by the per-project unsubscribe). Absent means included. Deleted with the membership.
- **Mailed-through position**: for one person and one project, the forward-only position covering everything already mailed (FR-021). Deleted with the membership.
- **Email send claim**: for one person, the next due instant plus the lease that makes concurrent ticks and a killed tick safe (FR-022).
- **Email delivery record**: one per attempt — person by reference, cadence, how many problems, outcome class, numeric code, duration, instant. No body, no subject, no address, no reply text (FR-033).
- **Unsubscribe token** (not stored in clear): a signed, scoped, expiring grant naming what it may change and nothing else (FR-026).
- Existing entities referenced, unchanged in meaning: activity event, notification state (the floor), notification event mark, notification preference, project, member, user, session, invitation, social account, platform.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A person who is not signed in learns about a failed post by email within one tick interval of it appearing (a minute on a default install), or within one day on a digest, having chosen the cadence in at most two actions from the Notifications page with the keyboard alone.
- **SC-002**: Across tests covering concurrent ticks, a tick killed at every stage of a send, a mailer that fails after accepting, and a send whose outcome is unknowable, **0** problems are mailed to the same person twice.
- **SC-003**: In tests, **0** problems that the person has read, dismissed or snoozed, and **0** excluded by a kind or platform switch, appear in any message; and **0** messages are sent with nothing in them.
- **SC-004**: With quiet hours set, **0** messages are handed over inside the window, and 100% of the problems still eligible at its end arrive in exactly **1** message.
- **SC-005**: Across both DST transitions, in at least two zones with different rules, a daily digest is sent exactly **once** per local day — never twice, never skipped.
- **SC-006**: On an install with no mail configuration, **0** behaviour changes: no mail attempted, no new control offered as available, and every existing notification test passing unchanged.
- **SC-007**: In tests of every failure path with logs captured, **0** log lines, stored rows, responses or snapshots contain a configured credential, a recipient address, a message body or an unsubscribe token; the secret-scanning test is green.
- **SC-008**: A person can stop every problem email from inside an email, with no login, in **1** action, and is then shown in words exactly what stopped and what did not. A tampered or expired link changes **0** settings and reveals nothing.
- **SC-009**: With 500 people due at once on a seeded install, the email section stays inside the tick's time budget, every other tick section's work is unaffected, and every due person is served within a bounded number of ticks (the bound stated in the plan and asserted).
- **SC-010**: An invitation reaches a new colleague without the inviter copying anything when mail is configured, and in 100% of the cases where mail is unavailable or fails the inviter still gets today's working link and is told why.
- **SC-011**: After upgrading an install with existing notification rows, **0** people have email turned on, **0** reading floors, sparse marks or preference rows change, and no operator step is required.
- **SC-012**: The settings section and the unsubscribe page pass the docket-ui accessibility rules — keyboard only, visible focus, labelled controls, text as well as colour for every state — and every control works with client JavaScript unavailable.

## Assumptions

- **The wire transport needs a package Docket does not have.** `NEEDS DEPENDENCY: nodemailer`; `NEEDS RESEARCH: SMTP` (there is no `docs/research/smtp.md`, and phases cannot fetch the web). Everything else in this entry is built and tested against the mailer interface, and the configured-but-unavailable state is specified rather than left to chance (FR-005). If the package is installed before planning, that one task is the only thing that changes.
- SMTP is the only transport. A hosted provider's HTTP API is not in this entry; an operator who wants one points SMTP at their provider's relay, which every such provider offers.
- "Immediate" is bounded by the install's tick interval (30–60 s by configuration), because the tick is the only recurring execution Docket has. The settings state this rather than implying instant delivery.
- Problem email is the only recurring mail. Invitations are transactional (N64); password reset, address verification and any other authentication email are out of scope, though the mailer makes them possible later.
- A person's address is the one on their account and is not verified by Docket (N66); a permanent rejection pauses their email.
- The person's time zone is new state introduced here because people have no zone today and projects may disagree (N48). It governs email only; nothing else in Docket starts using it.
- Hour granularity is enough for both the digest and quiet hours; no minute-level scheduling is offered.
- The eligibility rule and the read/snooze state are consumed exactly as entries 1 and 2 shipped them. If a change to either turns out to be needed, that is a defect in this entry's design, not a licence to change them.
- The delivery log is kept for a bounded period and pruned by the existing housekeeping section, in the shape the webhook log already uses; the plan fixes the retention.
- No infrastructure is added: no queue, no Redis, no second process. The worker tick and Postgres carry this (constitution VI).
- Mail content is plain and self-contained: no images, no remote content, and no tracking of any kind — no open pixels, no click wrapping. Nothing in Docket measures whether an email was read.
- One address per person; no per-project sending address, no reply handling, no attachments.

## Out of Scope

- **Push and chat delivery.** Webhooks remain the automation path (`docs/n8n.md`); nothing in this roadmap owns push or chat.
- **Real-time transport.** The 60-second refresh and the bell stay exactly as they are; replacing them is `realtime-updates` (entry 4).
- **Notifications about successes, retries or resolutions.** N1 stands: email carries problems only.
- **Per-event actions inside an email** beyond unsubscribe — no "mark read", "snooze" or "retry" link in the message; those need a session and live on the page the message links to.
- **Inbound mail of any kind**: no delivery-report parsing, no reply handling, no mailbox, no feedback loops (N62).
- **Any other transactional email**: password reset, address verification, sign-in links, membership-change notices, weekly summaries.
- **Hosted-provider HTTP APIs**, multiple transports, per-project sending identities, and mail-server authentication records (SPF, DKIM, DMARC — an operator's concern, pointed at in the docs).
- **Open or click tracking**, delivery analytics, and any engagement metric.
- **Changing the in-app rules**: the eligibility rule, the read floor, sparse marks, the bell, the panel, the callout, the count routes, Activity, the public API and webhooks are all untouched.
- **An operator-facing mail dashboard**, or any view of another person's delivery log or settings.
