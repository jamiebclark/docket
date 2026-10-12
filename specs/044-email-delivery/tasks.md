---

description: "Task list for Email delivery — Docket's first mailer"
---

# Tasks: Email delivery — Docket's first mailer, and problems that reach people who are not signed in

**Input**: Design documents from `/specs/044-email-delivery/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Requested explicitly (spec Testing section, FR-048). Every behaviour except the wire transport
is proven against a real Postgres and the recording mailer — no test opens a socket.

**One marked gap carried through every phase**: `src/server/mail/smtp.ts` ships as `NEEDS DEPENDENCY:
nodemailer` / `NEEDS RESEARCH: SMTP` (T006). No task in this file installs the package or writes
`docs/research/smtp.md` — that is one task for the session that can reach the registry, noted at the end
of Phase 2 and not repeated.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US8, mapping to the spec's user stories

---

## Phase 1: Setup

**Purpose**: The environment group and the interface types every later task imports.

- [X] T001 Add the SMTP env group (`SMTP_HOST`, `SMTP_FROM`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_PORT`,
      `SMTP_SECURITY`, `SMTP_FROM_NAME`), `smtpIssues(source)` pushed from `crossFieldIssues()` beside
      `storageIssues()`, and `toSmtp(e)` → `getEnv().smtp: SmtpConfig | null` in `src/server/env.ts`, per
      [contracts/mailer.md](./contracts/mailer.md) §3 (E1, E2, N43, FR-001, FR-002, FR-003)
- [X] T002 [P] Add the `--- Email ---` block to `.env.example` in the house Group/Optional format, pointing
      the two satellites without a value at `docs/research/smtp.md`, per
      [contracts/mailer.md](./contracts/mailer.md) §3 (FR-046)
- [X] T003 [P] Create `src/server/mail/types.ts`: `MailMessage`, `MailFailureReason`, `MailOutcome`,
      `Mailer`, `SMTP_SECURITY_MODES`, `SmtpSecurity`, `SmtpConfig`, per
      [contracts/mailer.md](./contracts/mailer.md) §1 (N42, E4, FR-004)

**Checkpoint**: the env group validates and the interface compiles; nothing calls it yet.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The capability, the schema, the pure modules, and the test seams every user story calls.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T004 [P] Create `src/server/mail/unavailable.ts` — the `Mailer` whose `send()` always resolves
      `{ kind: "unavailable" }` (FR-005, E3)
- [X] T005 [P] Create `src/server/mail/smtp.ts` exporting `createSmtpMailer(config): Mailer | null`, body
      `return null`, with the `NEEDS DEPENDENCY: nodemailer` / `NEEDS RESEARCH: SMTP` comment naming both
      marks verbatim, per [contracts/mailer.md](./contracts/mailer.md) §2 (E5) — **the one task this phase
      does not finish; do not attempt to resolve it**
- [X] T006 Create `src/server/mail/index.ts`: `getMailer(): Mailer | null` memoised per process from
      `getEnv().smtp` (null when unset; `createSmtpMailer()`'s result when set; `unavailableMailer` when
      that returns null) and `setMailerForTests(mailer | null | undefined)`, per
      [contracts/mailer.md](./contracts/mailer.md) §2 (E3) — depends on T003, T004, T005
- [X] T007 Add the two `disabled` lines to `src/server/startup/validate.ts` (email off; email configured but
      unavailable), naming no value, per [contracts/mailer.md](./contracts/mailer.md) §3 "Startup" (FR-005,
      US5 §1, §6) — depends on T006
- [X] T008 [P] Create `src/server/db/schema/email.ts`: `emailSettings`, `emailProjectState`,
      `emailDeliveryAttempts` with every column, check and index in
      [data-model.md](./data-model.md) §1–§3
- [X] T009 Re-export the three new tables from `src/server/db/schema/index.ts` — depends on T008
- [X] T010 [P] Register `email_project_state` in `src/server/db/project-owned.ts` with
      `scopeColumn: "project_id"` (FR-043) — depends on T008
- [X] T011 Generate migration `drizzle/0022_*.sql` with `drizzle-kit`, read it line by line against
      [data-model.md](./data-model.md) §7 (three additive `CREATE TABLE`s, no `ALTER`, no data step), run
      `pnpm db:migrate` and `pnpm db:check` — depends on T008, T009, T010
- [X] T012 [P] Create `tests/helpers/mailer.ts`: `recordingMailer()` with `sent`, `queue()`,
      `throwAfterAccepting()`, `hang()`, `reset()`, per [contracts/mailer.md](./contracts/mailer.md) §4 —
      depends on T003
- [X] T013 [P] Create `tests/helpers/email.ts`: seed `email_settings`, seed a due person, seed a project
      with attention events, for use by every `tests/integration/email/*` file
- [X] T014 [P] Create `src/lib/email/schedule.ts`: `ScheduleSettings`, `resolveZone`, `insideQuietHours`,
      `quietWindowEnd`, `atLocalHour`, `isSameLocalDay`, `nextDue`, `isStaleDigest`, every wall-clock
      conversion through `toZonedDateTime(zone, { disambiguation: "compatible" })`, per
      [contracts/services.md](./contracts/services.md) §1 (E12, E13, E14, N50, FR-019)
- [X] T015 [P] Create `src/lib/email/schedule.test.ts`: both DST directions, two zones with different
      rules, wrapping quiet windows, a digest-hour change mid-day, a zone change, an unrecognised stored
      zone — depends on T014
- [X] T016 [P] Create `src/lib/email/render.ts`: `EmailProblem`, `EmailProjectGroup`, `ProblemEmailModel`,
      `renderProblemEmail`, `InvitationEmailModel`, `renderInvitationEmail`, every instant through
      `formatLocal(instant, timeZone)`, no images/remote content/colour-only meaning, per
      [contracts/services.md](./contracts/services.md) §2 (FR-014, FR-015, N67)
- [X] T017 [P] Create `src/lib/email/render.test.ts`: multi-project grouping, the overflow sentence, no
      remote content, the one date format, empty-input throws — depends on T016
- [X] T018 [P] Create `src/lib/email/unsubscribe.ts`: `UnsubscribeGrant`, `mintUnsubscribeToken`,
      `readUnsubscribeToken`, `unsubscribeUrl`, `oneClickUnsubscribeUrl` over `encryptSecret`/
      `decryptSecret` (`src/server/crypto/secrets.ts`) with AAD `"docket-unsubscribe-v1"`, per
      [contracts/services.md](./contracts/services.md) §3 (E19, E20, FR-026)
- [X] T019 [P] Create `src/lib/email/unsubscribe.test.ts`: round trip, expiry, tamper, truncation,
      re-signing with another key, a rotated `CREDENTIALS_ENCRYPTION_KEY`, and that no substring of the
      user id, project id, address or slug appears in a minted token — depends on T018
- [X] T020 [P] Create `src/lib/email/text.ts`: every sentence and confirmation code in
      [contracts/services.md](./contracts/services.md) §4
- [X] T021 [P] Create `src/lib/email/text.test.ts`: every sentence present, every confirmation code
      parseable, the one-date-format lint passing — depends on T020
- [X] T022 Add `EMAIL_DEFAULTS` (`maxPerTick: 50`, `concurrency: 8`, `minWindowMs: 11000`,
      `backoffBaseMs: 60000`, `backoffMaxMs: 21600000`, `pauseAfterFailures: 5`,
      `unavailableRetryMs: 3600000`, `retentionDays: 30`) and `emailConfig(config)` to
      `src/server/scheduler/config.ts` beside `WEBHOOK_DEFAULTS` (E17) — no new environment variable
- [X] T023 [P] Create `tests/integration/email/email-migration.test.ts`: `0022` applied to an install
      seeded with existing reading floors, sparse marks and preference rows — **0** change to any of them,
      **0** people with email on, `pnpm db:check` green, building and dropping its own database (the
      `marks-migration.test.ts` pattern) — depends on T011
- [X] T024 [P] Extend `tests/integration/security/secret-scan.test.ts` with the four SMTP values (host,
      user, password, from), a rendered problem email and a failing send — depends on T001, T016

**Checkpoint**: the capability, the schema, the pure modules and the test seams all exist and are tested in
isolation. No user story has wired anything to a database yet.

---

## Phase 3: User Story 1 - Hear about a problem without being signed in (Priority: P1) 🎯 MVP

**Goal**: Immediate email sends exactly one message naming the problem, the project and the account, with
an Activity link and an unsubscribe link, on the next tick — and nothing on the one after.

**Independent Test**: Recording mailer, immediate email on, one failed event in a project, run one tick —
exactly one message, addressed, correct content; a second tick sends nothing.

### Implementation for User Story 1

- [X] T025 [US1] Add a marks mode to `listBranch` in `src/server/dal/activity.ts`:
      `marks: { userId; exclude: "snoozed" | "hidden" }`, `"snoozed"` unchanged, `"hidden"` moving the
      `hidden.event_id IS NULL` test inside the inner `WHERE` before `LIMIT`, per
      [data-model.md](./data-model.md) §6.1 (E15)
- [X] T026 [US1] Add `listAttentionForEmail` and `countAttentionForEmail` to
      `src/server/dal/activity.ts`, built from `listBranch` with `exclude: "hidden"`, the plan's
      `memberGroups`/`connectFailed` branches, `minSeq = max(groupThreshold, minSeq)`, the count bounded by
      `EMAIL_SCAN_LIMIT`, per [data-model.md](./data-model.md) §6.2 (E16) — depends on T025
- [X] T027 [US1] Create `src/server/dal/email.ts`: `emailDb`, `readSettings`, `upsertSettings`,
      `claimDuePeople`, `recoverEmailClaims`, `markInFlight`, `recordAttempt` (the full outcome switch in
      [data-model.md](./data-model.md) §5 step 6, including the backoff/pause branches), `lastAttempts`,
      `projectsForEmail`, every cross-project read inside `runCrossProject("scheduler: …")`, per
      [contracts/services.md](./contracts/services.md) §5 and [data-model.md](./data-model.md) §6.3 (FR-043)
      — depends on T008, T011, T014
- [X] T028 [US1] Create `src/server/services/email/assemble.ts`: `assembleForPerson`, per project not
      excluded, `minSeq = max(plan threshold, seen_seq, mailed_seq)`, up to `EMAIL_LIST_LIMIT` items plus
      the exact overflow count, `null` when nothing is eligible, per
      [contracts/services.md](./contracts/services.md) §5 "assemble.ts" (N51, N52, FR-009, FR-011, FR-012,
      FR-013) — depends on T016, T026, T027
- [X] T029 [US1] Create `src/server/services/email/send.ts`: `sendForClaimedPerson`, the three-transaction
      protocol of [data-model.md](./data-model.md) §5 steps 2–6, holding no transaction across
      `mailer.send()`, per [contracts/services.md](./contracts/services.md) §5 "send.ts" (E9, FR-022,
      FR-024) — depends on T027, T028
- [X] T030 [US1] Create `src/server/scheduler/email.ts`: `EmailCounts`, `emptyEmailCounts`,
      `runEmailDeliveries` — the capability check first (E18), then `recoverEmailClaims`, `claimDuePeople`,
      a worker pool of `cfg.concurrency` calling `sendForClaimedPerson` with the `minWindowMs` release
      check, `purgeEmailHistory`, a `writeHeartbeat("email", …)` with counts only, per
      [contracts/services.md](./contracts/services.md) §6 — depends on T022, T029
- [X] T031 [US1] Add `purgeEmailHistory(db, retentionDays)` to `src/server/dal/email.ts` — depends on T027
- [X] T032 [US1] Wire `runEmailDeliveries()` into the `Promise.all` in `src/server/scheduler/index.ts` and
      add `email: SectionResult<EmailCounts>` to `TickSummary` — depends on T030
- [X] T033 [US1] Create `src/server/services/email/index.ts`: `MyEmailSettings`, `myEmailSettings`,
      `saveMyEmailSettings` (the Zod schema and the refusal order of
      [contracts/services.md](./contracts/services.md) §5), `resumeMyEmail`, per
      [contracts/services.md](./contracts/services.md) §5 "index.ts" (FR-002, FR-006, FR-007, FR-010,
      FR-020) — depends on T014, T018, T027
- [X] T034 [US1] Add `saveEmailSettings` and `resumeEmail` server actions to
      `src/app/notifications/actions.ts`, following the file's existing session/redirect/confirmation-code
      shape, per [contracts/http.md](./contracts/http.md) §3 — depends on T033
- [X] T035 [US1] Create `src/components/email/EmailSettingsCard.tsx` — cadence `SegmentedControl`, digest
      hour `Select`, time zone `Select`, quiet-hours `<fieldset>` with two `Select`s, one Save button; the
      **off** and **immediate** states and the always-present sentences of FR-038; per
      [contracts/ui.md](./contracts/ui.md) §1 — depends on T020, T033
- [X] T036 [US1] Create `src/components/email/BrowserTimeZone.tsx` — leaf client component pre-filling the
      zone `Select` from `Intl.DateTimeFormat().resolvedOptions().timeZone` only when no zone is stored
      (N48) — depends on T035
- [X] T037 [US1] Render `EmailSettingsCard` between the problems list and the per-project preference grid
      in `src/app/notifications/page.tsx`, parsing the `?email=` confirmation code — depends on T035, T036
- [X] T038 [P] [US1] Create `tests/integration/email/assembly.test.ts`: read/dismissed/snoozed/
      expired-snooze/kind-off/platform-off/below-floor events excluded; multi-project grouping; a problem
      appearing just after a send; nothing sent when nothing is eligible; a person with no projects or
      every kind off — depends on T028
- [X] T039 [P] [US1] Create `tests/integration/email/cadence.test.ts` with the immediate-cadence scenarios:
      one tick sends exactly one message for one failed event, a second tick sends nothing, two problems
      seconds apart arrive as one message, a person who never turned email on gets nothing ever and an
      unchanged bell — depends on T030, T037

**Checkpoint**: immediate email works end to end and is independently testable. This is the MVP.

---

## Phase 4: User Story 2 - One email a day, at an hour I choose (Priority: P1)

**Goal**: A daily digest at a chosen local hour, sent at most once per local day, late when the worker was
briefly down, skipped (not sent stale) when it was down for days.

**Independent Test**: A 07:00 digest in a named zone, problems seeded through the day, ticks every
simulated minute across the day — exactly one message after 07:00 local, listing every still-eligible
problem once; a day with nothing eligible sends nothing.

### Implementation for User Story 2

- [X] T040 [US2] Add digest-cadence coverage to `src/app/notifications/page.tsx` /
      `EmailSettingsCard.tsx`: the **digest** state showing `text.digestBeatsQuiet` beside the quiet-hours
      fieldset, per [contracts/ui.md](./contracts/ui.md) §1 — depends on T035
- [X] T041 [P] [US2] Extend `tests/integration/email/cadence.test.ts` with digest scenarios: exactly one
      send at or just after 07:00 local; a day with every problem read/snoozed/ineligible before the hour
      sends nothing and changes no state; new problems after the morning's digest wait for tomorrow; a
      worker down 06:00–09:00 sends once, late, same local day; a worker down two days skips the stale
      digest and the next one covers each still-eligible problem once; switching cadence mid-day re-sends
      nothing and loses nothing; a skipped hour and a repeated hour each send exactly once — depends on
      T030, T037, T039

**Checkpoint**: both cadences are independently testable; US1 is unaffected.

---

## Phase 5: User Story 3 - Not at three in the morning (Priority: P2)

**Goal**: Quiet hours defer immediate mail to the window's end as one message; a digest hour inside quiet
hours still sends.

**Independent Test**: Immediate email, quiet hours 22:00–07:00, problems at 23:00/02:00/06:30 local, ticks
every simulated minute — nothing before 07:00, one message at 07:00 with all three.

### Implementation for User Story 3

- [X] T042 [P] [US3] Create `tests/integration/email/quiet-hours.test.ts`: deferral to the window end as
      one message; a window wrapping midnight; two zones with different rules; both DST transitions,
      including a window end in a skipped hour and in a repeated hour; a problem read or snoozed inside the
      window absent from the eventual message; an otherwise-empty message at the window's end not sent; a
      digest hour inside the person's own quiet hours still sending; an empty window (`From = To`)
      behaving as no quiet hours at all — depends on T030, T037, T041

**Checkpoint**: quiet hours independently testable; US1/US2 unaffected.

---

## Phase 6: User Story 4 - Stop the email from the email, without signing in (Priority: P1)

**Goal**: Every problem email carries an unsubscribe link naming nobody; the landing page writes nothing on
a GET and offers four submits; a mail client's one-click POST acts immediately.

**Independent Test**: Pull the link out of a sent message — no identifier in it; fetching it writes
nothing; the submit turns email off and says so; tamper/truncation/expiry give the same neutral page and
write nothing; the one-click POST turns email off directly.

### Implementation for User Story 4

- [X] T043 [US4] Add `setCadence(db, userId, cadence, hour?)` and
      `excludeProject(db, userId, projectId)` to `src/server/dal/email.ts`, resolving the caller's current
      memberships first, per [data-model.md](./data-model.md) §6.3 — depends on T027
- [X] T044 [US4] Add `UnsubscribeAction`, `UnsubscribeView`, `readUnsubscribe`, `applyUnsubscribe` to
      `src/server/services/email/index.ts`, every refusal returning `{ valid: false }` having written
      nothing, per [contracts/services.md](./contracts/services.md) §5 "index.ts" (FR-027, FR-029, FR-030)
      — depends on T018, T033, T043
- [X] T045 [US4] Create `src/app/email/unsubscribe/page.tsx` — session-less, `force-dynamic`, `noindex`,
      inside `AuthShell`; renders the current state, the primary submit and the three finer options, or the
      one neutral page for every refusal, per [contracts/http.md](./contracts/http.md) §1 and
      [contracts/ui.md](./contracts/ui.md) §2 — depends on T044
- [X] T046 [US4] Create `src/app/email/unsubscribe/actions.ts` — the four server actions (`all_off`,
      `project_off`, `digest`, `back_on`), each a plain POST with the token in a hidden input, idempotent,
      per [contracts/http.md](./contracts/http.md) §1 — depends on T044
- [X] T047 [US4] Create `src/app/api/email/unsubscribe/route.ts` — `POST` only (405 on GET), no session, no
      body requirement, `204` for a valid token and `204` for every refusal, per
      [contracts/http.md](./contracts/http.md) §2 — depends on T044
- [X] T048 [P] [US4] Create `tests/integration/email/unsubscribe.test.ts`: the link containing no
      identifier; a GET changing nothing; the primary submit turning email off; the per-project submit; the
      digest-instead submit; the back-on submit; tamper, truncation, re-signing, expiry, a deleted person
      and a left project all giving the same neutral page and writing nothing; reuse being idempotent; the
      one-click POST turning email off with `204` and no session — depends on T045, T046, T047

**Checkpoint**: unsubscribe independently testable from any sent message, with no session.

---

## Phase 7: User Story 5 - An operator turns email on, and an install without it is untouched (Priority: P1)

**Goal**: The all-or-none group is validated by name with no value; an install with nothing set is provably
unchanged; a configured-but-unavailable install logs, records and backs off without lying.

**Independent Test**: Validate the environment with nothing set, the full group, each member missing, a
satellite without the group, a credential half-pair — check acceptance, the named messages, and that
nothing is attempted with nothing set.

### Implementation for User Story 5

- [X] T049 [US5] Add the **unavailable** and **transport unavailable** states to
      `src/components/email/EmailSettingsCard.tsx` — no controls at all for unavailable (not a disabled
      control), the `Alert` warning for transport-unavailable, per
      [contracts/ui.md](./contracts/ui.md) §1 — depends on T035
- [X] T050 [P] [US5] Create `tests/integration/email/env-group.test.ts`: `parseEnv` over nothing set, the
      full group, each group member missing, each satellite without the group, a credential half-pair in
      both directions, neither credential accepted; every message named by variable with no value; nothing
      offered or attempted with nothing set, asserted through the scope harness (zero statements) — depends
      on T001
- [X] T051 [P] [US5] Create `tests/integration/email/unavailable.test.ts`: the group configured with the
      transport absent — one startup line, each would-be send recorded `unavailable`, **no** position
      advance, `next_due_at` pushed by `unavailableRetryMs` and not a tight loop, nobody told they were
      emailed; removing the configuration later keeps stored settings and still says unavailable — depends
      on T007, T030, T049

**Checkpoint**: the capability boundary is independently testable; every other story's tests still pass
unchanged with the group unset.

---

## Phase 8: User Story 6 - Never twice, and nothing lost (Priority: P1)

**Goal**: Concurrent ticks, a kill at any step, a throw-after-accept, and a hang past the budget each
produce at most one message; failures back off and pause; 500 due people are served within 10 ticks without
starving the other sections.

**Independent Test**: Two ticks concurrently against the same due person (one message); a kill between each
pair of send-protocol steps (sent again in zero of them); a throwing and a hanging mailer (recorded outcome,
no second message).

### Implementation for User Story 6

- [X] T052 [P] [US6] Create `tests/integration/email/no-double-send.test.ts`: two concurrent ticks against
      the same due person; a kill after the claim, after the high-water write, and after the send; a
      mailer that resolves then throws; a mailer that hangs past the budget; the forward-only position
      never moving backwards; no held transaction across `mailer.send()` (opening a second connection inside
      the hook would deadlock if one were) — depends on T029, T030
- [X] T053 [P] [US6] Create `tests/integration/email/failure-pause.test.ts`: temporary-failure backoff with
      increasing delay; re-assembly at each retry (eligibility changed between attempts is reflected); the
      consecutive-failure threshold (5) pausing with a visible, resumable reason; a permanent rejection
      pausing at once; a pause never touching `notification_states`, `notification_preferences` or
      `notification_event_marks` — depends on T027, T029
- [X] T054 [P] [US6] Create `tests/integration/email/tick.test.ts`: inside the time budget; concurrent-safe;
      kill-safe; fairness (longest-waiting first) across many due people; no effect on the other five
      sections' counts; in-process mode (`RUN_WORKER_IN_PROCESS`); the 500-due-people case served within 10
      ticks at 50 per tick (SC-009), per [quickstart.md](./quickstart.md) §4 — depends on T030, T032
- [X] T055 [US6] Add a cascade check to `tests/integration/email/authz.test.ts`'s setup data (or a focused
      case in `tick.test.ts`): a member removal and a user deletion take `email_project_state` and the
      pending `sending_seq` with them in the same transaction, and no mail about that project follows
      (FR-025) — depends on T011, T030 — done as two focused cases in `tick.test.ts` (authz.test.ts does
      not exist yet; it is created later, in Phase 10's T062)

**Checkpoint**: crash-safety and fairness independently testable; the tick's other five sections are
provably unaffected.

---

## Phase 9: User Story 7 - Invitations arrive by email, and still work when they cannot (Priority: P2)

**Goal**: An invitation is emailed whenever a mailer exists, in addition to the unchanged in-app invitation;
when mail is unavailable or fails, the inviter still gets today's working link and is told which happened.

**Independent Test**: Invite an address with no account and one with an account, in each of three
conditions (no mail, mail accepting, mail failing) — check the nine outcomes.

### Implementation for User Story 7

- [X] T056 [US7] Add `InvitationEmail` and the `email` field on both `InvitationDeliveryResult` variants in
      `src/server/services/invitations/delivery.ts`; `defaultInvitationDelivery` calls
      `renderInvitationEmail` and `getMailer()`, recording an attempt with `purpose: "invitation"` and
      `user_id: NULL` when the invitee has no account, per
      [contracts/services.md](./contracts/services.md) §7 (E25, N64) — depends on T016, T027
- [X] T057 [US7] Change the `catch` in `deliverAfterCommit()` in
      `src/server/services/invitations/index.ts` to no longer raise `ConflictError` for a delivery problem
      — the mailer never throws, so a failed send is a value, per
      [contracts/services.md](./contracts/services.md) §7 (E26, FR-042) — depends on T056
- [X] T058 [US7] Update the DTO in `src/app/p/[projectSlug]/settings/members/actions.ts` to carry the
      `email` field through to the inviter's response — depends on T056
- [X] T059 [US7] Update `src/components/members/InviteResult` (or equivalent) to show the five wordings of
      [contracts/ui.md](./contracts/ui.md) §3, keeping the copyable link whenever `kind: "manual_link"` and
      naming no address on a failure — depends on T058
- [X] T060 [P] [US7] Create `tests/integration/email/invitations.test.ts`: all nine combinations of
      (invitee has an account / does not) × (no mail / mail accepting / mail failing); the email's
      contents, project, role, inviter and deadline; no unsubscribe link or header on it; the inviter's
      exact wording; the copyable link always present when there is no account; a failed send recording an
      attempt with `user_id = NULL` and not rolling back the invitation; regeneration mailing the new link
      and invalidating the old; revoked/expired/used links unchanged — depends on T056, T057, T058, T059

**Checkpoint**: invitation delivery independently testable in all nine combinations; today's link-only flow
is unchanged when mail is not configured.

---

## Phase 10: User Story 8 - Nothing leaks (Priority: P1)

**Goal**: No configured credential, address, body or token reaches a log line, stored row, error or
snapshot — including when the server's refusal quotes the address.

**Independent Test**: Every failure path with logging captured — bad credentials, a refused recipient, a
TLS failure, a timeout, a 5xx quoting the address — asserting absence everywhere, plus the secret-scan
test.

### Implementation for User Story 8

- [X] T061 [P] [US8] Create `tests/integration/email/no-secrets.test.ts`: every failure path (`refused`,
      `rejected`, `timed_out`, `connect_failed`, `tls_failed`, `internal`, `unavailable`) run through the
      recording mailer with `console.log`/`warn`/`error` captured, asserting zero occurrences of the
      configured password, the recipient address, the message body, the subject, and an unsubscribe token
      in any log line, stored row, returned value or snapshot; a server reply quoting the address stored as
      a classified outcome only; a person's own settings showing their own last outcome and nothing about
      anyone else; an API key refused on every email path — depends on T027, T029, T033, T044

**Checkpoint**: the secrets rule is independently testable across every failure path this entry introduces.

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: Isolation proof, full-state accessibility, docs, and the final human walk-through.

- [X] T062 [P] Create `tests/integration/email/authz.test.ts`: sessions only; API keys refused; another
      person's settings unreachable (no parameter could name one); a foreign project and a non-existent one
      indistinguishable on the per-project unsubscribe; the project-scope harness passing for every new
      statement; the tick's cross-project reads pinned inside `runCrossProject` — depends on T027, T033,
      T044
- [X] T063 Add a `loading.tsx` skeleton block on `/notifications` matching the Email card's height — depends
      on T037
- [X] T064 Create `tests/integration/email/ui.test.ts`: the settings card in all six states (unavailable,
      transport unavailable, off, immediate, digest, paused); the unsubscribe page in its valid and neutral
      renders; keyboard operation and tab order; accessible names; confirmations in words; both pages
      rendering and submitting with no client bundle at all; semantic token classes only; every instant
      through `formatLocal`/`LocalTime` — depends on T037, T040, T045, T049, T053, T063
- [X] T065 [P] Append decisions **N42–N67** to `docs/decisions.md`, each next to the decision it extends or
      departs from (N5, N6, N10, N27, R1, R14 and the webhook-log decisions), stating what changes and what
      does not; append plan decisions **E1–E34** (FR-046, FR-047)
- [X] T066 [P] Update `docs/deployment.md`: configuring a mail server, what happens without one, that
      asynchronous delivery reports are invisible to Docket (N62), and the backup caveat beside the backup
      instructions (FR-046)
- [X] T067 [P] Replace `docs/accounts.md:44`'s "Docket sends no email" with both paths (FR-046)
- [X] T068 [P] Replace `docs/build-prompt.md:85`'s "Invitation delivery, for now, uses no email at all" with
      the kept promise (FR-046)
- [X] T069 [P] Update `docs/activity.md`'s Notifications section: email, cadence, quiet hours, pausing and
      unsubscribe (FR-046)
- [X] T070 [P] Add the no-JavaScript `Select`-over-`Combobox` exception (E28) to `docs/design-system.md` §7's
      control table and to `.claude/skills/docket-ui/SKILL.md`, in the same change — depends on T035
- [X] T071 Run `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build && node
      scripts/check-contrast.mjs` once, at the end of implementation — depends on every task above
- [ ] T072 **Human verification — needs a browser and a judgement call; the final task, after everything
      automated.** With no SMTP configured, confirm `/notifications` offers no email control and nothing
      else differs from `main`; configure the group and confirm every role sees the card naming no variable;
      choose a digest hour, Save, and tab through with the keyboard only; disable JavaScript, change cadence
      and zone, and confirm both took effect; trigger a problem, run a tick, and read the recorded message
      out of the recording mailer for plain-text readability and no remote content; open the unsubscribe
      link in a private window and confirm the GET writes nothing before pressing the submit; screenshot the
      Email card (off, digest, paused) and the unsubscribe page (before/after) at a narrow and wide
      viewport, light and dark. Record the outcome in the PR description rather than leaving it unspoken —
      depends on T071

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Setup — **blocks every user story**
- **User Story 1 (Phase 3)**: depends on Foundational only — the MVP
- **User Story 2 (Phase 4)**: depends on Foundational and US1 (shares the tick section, the card and
  `cadence.test.ts`)
- **User Story 3 (Phase 5)**: depends on Foundational and US1/US2 (shares the tick section and the card)
- **User Story 4 (Phase 6)**: depends on Foundational and US1 (`email.ts` DAL, `services/email/index.ts`);
  independent of US2/US3/US5–US8
- **User Story 5 (Phase 7)**: depends on Foundational and US1 (the card, the tick section); independent of
  US2–US4, US6–US8
- **User Story 6 (Phase 8)**: depends on Foundational and US1 (the send protocol, the tick section);
  independent of US2–US5, US7, US8
- **User Story 7 (Phase 9)**: depends on Foundational only (`render.ts`, `getMailer()`); independent of
  every other user story
- **User Story 8 (Phase 10)**: depends on Foundational and US1/US4 (every failure path, the settings read);
  independent of US2, US3, US5–US7
- **Polish (Phase 11)**: depends on every user story whose state or doc it touches

### Parallel Opportunities

- All `[P]` tasks within Phase 1 and Phase 2 (different files, no shared dependency)
- Once Foundational is complete, **US7** can proceed fully in parallel with US1–US6, US8 (it touches only
  `invitations/` and the mailer, never the settings/tick path)
- Once US1 lands, **US4**, **US5** and **US6** can proceed in parallel (each touches a disjoint set of
  files: unsubscribe route/page, the card's unavailable states, and the tick's crash tests, respectively)
- Test-file tasks marked `[P]` within any phase can run in parallel with each other once their
  implementation dependencies are met

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1: Setup
2. Phase 2: Foundational — **critical**, blocks every story
3. Phase 3: User Story 1
4. **Stop and validate**: `pnpm vitest run tests/integration/email/assembly.test.ts
   tests/integration/email/cadence.test.ts` green, one message per tick, nothing on the second

### Incremental Delivery

1. Setup + Foundational → the capability, the schema, the pure modules
2. US1 → immediate email works end to end (MVP)
3. US2 → the digest, reusing US1's pipeline
4. US3 → quiet hours, reusing US1/US2's clock module
5. US4 → unsubscribe, reusing US1's DAL and service layer
6. US5 → the operator boundary, reusing US1's card and tick section
7. US6 → crash-safety and fairness proofs over US1's send protocol
8. US7 → invitations, independent of the settings/tick path entirely
9. US8 → the secrets proof, over every path above
10. Polish → isolation, full-state accessibility, docs, the human walk-through

### Parked Deliberately

**NEEDS DEPENDENCY: nodemailer** / **NEEDS RESEARCH: SMTP** (T005): no task in this file resolves it. The
session that can reach the npm registry writes `docs/research/smtp.md` first, then replaces
`createSmtpMailer`'s body, adds the header lines to `MailMessage.headers`, and fills in the two
`.env.example` defaults — nothing else in the repository changes (research.md §1, quickstart.md "The one
task that is not finished here").

**T072 is last, deliberately**: a browser/judgement task placed earlier would starve the automated
implement loop waiting on a human (roadmap rule, speckit human-task-deadlock).
