# Implementation Plan: Email delivery — Docket's first mailer, and problems that reach people who are not signed in

**Branch**: `060-email-delivery` | **Date**: 2026-10-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/044-email-delivery/spec.md`

## Summary

Give Docket a mailer the way it already has storage: a capability that is either configured or absent.
`src/server/mail/` mirrors `src/server/storage/` exactly — one interface (`Mailer`, one `send()`, four
classified outcomes), one `getMailer(): Mailer | null` memoised from an all-or-none env group modelled
line for line on `storageIssues()` (`src/server/env.ts:72-133`), and one `setMailerForTests()` seam. Every
caller asks one question: *is there a mailer?* (N42, FR-004).

Problem email is **one more section of the existing tick**, built from the pieces the webhook section
already uses: `FOR UPDATE SKIP LOCKED` plus a lease, exponential backoff, a self-pausing rule after
consecutive failures, an append-only attempt log and a retention purge. What it does *not* copy is the
webhook log's redacted response excerpt: a mail server's refusal routinely quotes the recipient address,
so the reply text is classified and discarded, never stored (N60, FR-033) — the one deliberate departure
from that shape, and the reason is the roadmap's secrets rule.

Three sparse tables, no queue, no new infrastructure. `email_settings` is one row per person, created only
when they choose something, so **off-for-everybody is a fact about the database** rather than a rule a
migration has to honour (N45, FR-007). The claim lives on that same row — `next_due_at`, `lease_owner`,
`lease_until` — so a person is one claimable unit, and "due for a deferred quiet-hours batch and a digest
at the same instant" can only ever produce one message. `email_project_state` is one row per person per
project carrying the forward-only mailed-through position, the per-project exclusion and the in-flight
high-water, under the same composite FK to `member ON DELETE CASCADE` that R1/M1/Q1 already use, so
FR-025's "deleted with the membership" is the database's job. `email_delivery_attempts` is the log.

Never twice is three transactions and one column. A tick **claims** the person (lease), **assembles**
outside any transaction, **writes the high-water it is about to mail** (`sending_seq`) under the lease,
**sends**, then **records** — advancing `mailed_seq` to `sending_seq` on a known send and clearing it on a
known temporary failure. An expired lease is recovered as *sent*: `mailed_seq = GREATEST(mailed_seq,
sending_seq)`, which is N54's "an unknowable outcome is recorded as sent and never retried" implemented
rather than hoped for. A crash before the high-water is written loses nothing, because nothing went out.

Cadence and the clock are one pure module. `nextDue(settings, lastSentAt, now)` answers every timing
question in the spec — immediate means *now*, immediate inside quiet hours means *the window end*, a
digest means *the chosen hour in the person's zone*, a digest already sent today means *tomorrow*, and a
digest missed on an earlier local day is skipped rather than sent stale (N47–N53). It resolves wall times
through `toZonedDateTime(zone, { disambiguation: "compatible" })` and advances by one `PlainDate`, never
by 24 hours, which is the rule `src/lib/notifications/snooze.ts` already ships: a skipped hour moves just
past the gap, a repeated hour takes the earlier offset, so exactly one digest lands per local day.

Assembly is the existing eligibility rule and nothing new. `compileEligibility()` is imported unchanged
(N40, FR-009) and the only new thing the activity reader learns is a `minSeq` that is the maximum of the
reading floor, the switch threshold and `mailed_seq`, plus a marks mode that excludes anything hidden
*now* rather than flagging it. Nothing is queued per event; the filter runs at send time (N51).

Unsubscribe is a token that names nobody because it is **ciphertext, not a signed payload**: the existing
AES-256-GCM helper (`encryptSecret`, `src/server/crypto/secrets.ts`) with its own AAD, which gives tamper
rejection, expiry inside the plaintext, a single neutral refusal for every bad case, and no stored row at
all. The GET renders a form and writes nothing; a separate POST route is the mail client's own one-click
path (FR-027).

**One task cannot be finished here and is marked rather than faked.** `NEEDS DEPENDENCY: nodemailer`,
`NEEDS RESEARCH: SMTP` — `src/server/mail/smtp.ts` ships as a single function that returns `null`, so a
configured install gets the *unavailable* mailer, startup says so once, each would-be send is logged as
`unavailable` with an hour's backoff, no bookkeeping advances and nobody is told a lie (N44, FR-005).
Everything else in this entry — the group, cadence, assembly, quiet hours, DST, the no-double-send
bookkeeping, unsubscribe, the log, pausing, the invitation retrofit and both screens — is built and tested
against the interface with a recording mailer and no network.

**What this entry does not do**, and who owns it: real-time transport, with the 60-second poll staying
exactly as it is — `realtime-updates` (entry 4). Owned by nothing in this roadmap: push and chat delivery
(webhooks remain the automation path, `docs/n8n.md`), notifications about successes (N1 stands), per-event
actions inside an email beyond unsubscribe, inbound mail of any kind including delivery reports (N62), any
other transactional email, hosted-provider HTTP APIs, SPF/DKIM/DMARC, and open or click tracking.

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node 24 LTS, React 19.2, Next.js 16.3 (App Router,
standalone output)

**Primary Dependencies**: `drizzle-orm` 0.45 (`drizzle-orm/node-postgres`), `zod` 4, Better Auth 1.7,
`@js-temporal/polyfill` 0.5 (every wall-clock rule here), Tailwind 4, `node:crypto` (the unsubscribe
token, through the existing `encryptSecret`/`decryptSecret`). **One addition, deferred**:
`NEEDS DEPENDENCY: nodemailer` — nothing in `package.json` or `node_modules` speaks SMTP (verified), and
headless phases cannot reach the registry (decision #19). It is confined to one file and one task (E5).

**Storage**: Postgres. Three new tables — `email_settings` (one row per person, keyed `user_id`),
`email_project_state` (project-owned, keyed `(project_id, user_id)`) and `email_delivery_attempts`
(append-only, person-scoped). One migration, `0022`. **No change at all** to `activity_events`,
`notification_states`, `notification_preferences` or `notification_event_marks` — not a column, not an
index, not a row (FR-045).

**Testing**: Vitest against a real Postgres (`tests/integration/email/`), a recording mailer
(`tests/helpers/mailer.ts`) so no test ever opens a socket, the project-scope harness
(`tests/helpers/scope-check.ts`), the one-date-format lint (`tests/lint/date-format.test.ts`), a
self-contained migration test that builds and drops its own database (the `marks-migration.test.ts`
pattern), `tests/integration/security/secret-scan.test.ts` extended with the SMTP group, and pure unit
tests for the schedule, render, token and text modules. Per constitution II, the SMTP transport itself is
reported as **not verified** rather than "verified with mocks only": it does not exist yet.

**Target Platform**: self-hosted Docker Compose (web + worker + postgres) and Neon with only the
connection string changed. No session-level Postgres features; claims are `FOR UPDATE SKIP LOCKED` plus a
lease column, and no send happens inside a held transaction.

**Project Type**: web application (one Next.js app; server services + DAL + React server components), plus
one new section of `runTick()`.

**Performance Goals**: SC-009 — with 500 people due at once the email section stays inside
`SCHEDULER_TICK_BUDGET_SECONDS` (default 20) and serves every due person within **10 ticks**
(`maxPerTick = 50`, E17), leaving publishing, token refresh, generation, webhooks and housekeeping
unaffected because the six sections run concurrently under one deadline and each catches its own failure.
Per person, assembly is two indexed reads per project over the partial attention indexes 022 already
ships.

**Constraints**: the recipient address exists in exactly one shape, `MailMessage.to`, and crosses no other
boundary — the log takes a `user_id`, every outcome is a value rather than a thrown error, and no stored
row, log line, response or snapshot holds an address, a credential, a message body, a subject or a token
(FR-031, FR-034). Hour granularity only. All instants stored UTC; every wall-clock conversion goes through
Temporal with `disambiguation: "compatible"`. Every instant a person reads goes through
`formatLocal`/`LocalTime` (the one date format lint). The eligibility rule and the read/snooze state are
consumed exactly as entries 1 and 2 shipped them; changing either would be a defect in this design.

**Scale/Scope**: at most 1 settings row and about 20 project-state rows per person; at most 20 problems
listed per message with an exact overflow count bounded at 1000 scanned (E16). Touches 1 new
`src/server/mail/` folder (4 files), 1 new `src/lib/email/` folder (4 modules), 1 schema file, 1
migration, 1 registry line, 2 DAL modules (1 new), 1 new scheduler section plus `config.ts` and
`index.ts`, the invitation delivery module and its 2 callers, `env.ts`, `startup/validate.ts`,
`housekeeping`, 2 pages (1 new), 1 new route handler, 3 components (2 new), about 18 test files and
7 docs.

## Constitution Check

*GATE: checked before Phase 0 and re-checked after Phase 1 design.*

| Principle | Verdict | How this plan satisfies it |
|---|---|---|
| I. Verified facts over memory | **Pass, with one marked gap** | There is no `docs/research/smtp.md`, so every SMTP protocol fact is `NEEDS RESEARCH` and **none is asserted anywhere in this plan**: the default port, the default transport-security mode, the mapping of `SMTP_SECURITY` onto the client's options, and the one-click unsubscribe header names and semantics (FR-026) are all deferred to the single task that installs the package and writes that research file (E2, E5, E21). The env layer validates range and membership only; `.env.example` points at the research file for the defaults. Everything else is read from code in this repository or from `node_modules`: the Drizzle builders and the `GREATEST`-in-upsert form from `src/server/dal/notifications.ts`, the claim/lease/backoff/self-disable shape from `src/server/dal/webhooks.ts`, the AES-256-GCM helper from `src/server/crypto/secrets.ts`, the DST rule from `src/lib/notifications/snooze.ts`, and Next 16 App Router usage from `node_modules/next/dist/docs/01-app/`, which the implement phase reads before touching the page or the route handler. |
| II. Nothing is "working" unless it ran | **Pass** | Every requirement except the wire transport has a Vitest check against real Postgres and a recording mailer ([quickstart.md](./quickstart.md) §3); no test opens a socket, so nothing is "verified with mocks only" in the credential sense. The transport is reported honestly as **not built**: its task is `NEEDS DEPENDENCY`, and the configured-but-unavailable state is itself specified and tested (US5 §6). The browser and visual-judgement walk-through is the last task in `tasks.md`, after everything automated (roadmap rule). |
| III. Project isolation in one place | **Pass** | `email_project_state` is registered in `projectOwnedTables` with `scopeColumn: "project_id"`, so the harness fails any statement that touches it unpinned. Assembly is the scheduler's own cross-project work and goes through the named `crossProject()` escape hatch, exactly as webhook delivery and housekeeping already do; inside it every statement is pinned to one project id resolved from that person's `member` rows, and every read joins `member` in the same statement so a removal mid-tick hides the project. `email_settings` and `email_delivery_attempts` are not project-owned and carry no project column. No route, action or component imports the database client. A setting is always the session's own `user_id`; the unsubscribe path takes its user id from decrypted ciphertext, never from input (FR-044). |
| IV. One service layer, many callers | **Pass** | One `Mailer` interface, one `getMailer()`, one assembly function, one `nextDue()`, one renderer, one token module. The tick section, the settings page, the unsubscribe page, the one-click route and the invitation delivery all call the same service functions in `src/server/services/email/`; none of them re-implements a filter, a clock rule or a message body. Which problems may be mailed is `src/lib/notifications/eligibility.ts`, imported unchanged (FR-009). |
| V. Providers are plug-ins | **Pass** | Nothing here touches `src/providers/`, the publish path, the composer or the schema a provider sees. A message names platforms through the existing `recordPlatforms()` helper and the registry's display names, so a platform added later appears in mail with no change here. N54's "unknown outcome is recorded as sent and never retried" is deliberately the same choice constitution V makes for publishing, for the same reason. |
| VI. Boring, few dependencies | **Pass, with one justified addition** | No queue, no Redis, no second process, no new infrastructure, no `docker-compose.yml` change, no new UI primitive (`Card`, `Field`, `Select`, `SegmentedControl`, `Button`, `Alert`, `Badge`, `EmptyState`, `Table`, `LocalTime` all exist). One runtime dependency, `nodemailer`, justified here and recorded in `docs/decisions.md` (E5, E32) as the principle requires: hand-rolling an SMTP client or shelling out to `sendmail` is forbidden by FR-005, and the principle's own instruction for an uninstallable package — mark `NEEDS DEPENDENCY` and continue with other tasks — is exactly what this plan does. Email tunables are constants in `scheduler/config.ts` beside `WEBHOOK_DEFAULTS`, not new environment variables (E17). |
| VII. Secrets never leak | **Pass** | The SMTP password is read once into `getEnv().smtp` and passed only to the transport factory; `redact()`'s `SENSITIVE_KEY` already drops a `password` key from any summary. The recipient address lives only in `MailMessage.to`. The attempt row has **no excerpt column at all** — there is nothing to redact because there is nothing to store (N60). Every mailer outcome is a returned value, so no address or config can ride out on an exception. The unsubscribe token is ciphertext, never logged, never stored, never in a response other than the message it was minted for. `.env.example` documents every new variable; no validation message, log line or screen carries a value (FR-003). The secret-scan test gains the four SMTP values, a rendered problem email and a failing send. |
| Engineering: UTC and Temporal | **Pass** | Every stored instant is UTC `timestamptz`. The three wall-clock rules — the digest hour and both ends of the quiet window — are resolved in one pure module through `toZonedDateTime(zone, { disambiguation: "compatible" })`, the same call and the same explicit disambiguation `snooze.ts` and the posting slots already use, and a resolved instant is stored absolute and never recomputed (N50, M8). Advancing a digest adds one `PlainDate`, never 24 hours. |
| Engineering: bounded, concurrent-safe, kill-safe tick | **Pass** | A sixth section of `runTick()`, bounded by the same deadline, releasing its claim and stopping cleanly when less than `minWindowMs` remains. Claims are `FOR UPDATE SKIP LOCKED` plus `lease_owner`/`lease_until`, recovered by the same section on the next tick. No send happens inside a held transaction (E9, FR-024). Each section catches its own failure, so an email failure cannot touch publishing. |
| Engineering: accessibility, server components | **Pass** | The settings section and the unsubscribe page are server components; the only client code is one leaf enhancement that pre-fills the zone from the browser (N48) over a control that already works without it. Every control is a real form control with a visible label, state as text as well as colour, visible focus and keyboard operation, and every change saves and confirms in words with client JavaScript unavailable. One deliberate extension to `docs/design-system.md` §7 (a native `Select` where a requirement demands the control be *changeable* with no JavaScript, E28) is argued in research.md and written into that document and the `docket-ui` skill in the same change, which is what §"Code follows this file" asks for rather than a silent exception. |
| Workflow: migration ships committed, `db:check` green | **Pass** | One migration, `0022`: three `CREATE TABLE`s with their FKs, checks and indexes. Pure additive DDL — no `UPDATE`, no `ALTER` of an existing table, no data step at all — so it is safe on a live install with existing rows, needs no operator step, turns nobody's email on, and cannot alter a reading floor, a sparse mark or a preference row (FR-045, SC-011). |
| Workflow: docs | **Pass** | FR-046/FR-047: `docs/decisions.md` gains **N42–N67** next to the decisions they extend or depart from (N5, N6, N8, N10, N27, R1, R14 and the webhook-log decisions), each stating what changes and what does not, plus the plan decisions **E1–E34**; the N45-next-to-N27 entry states plainly that it is *not* a reversal. `.env.example` documents the seven new variables in the house Group/Optional format; `docs/build-prompt.md:85` and `docs/accounts.md:44` are corrected to describe both paths; `docs/deployment.md` covers configuring a mail server, what happens without one, that asynchronous delivery reports are invisible to Docket (N62), and that restoring a backup is the one case the no-double-send rule cannot cover; `docs/activity.md` §Notifications describes email, cadence, quiet hours and unsubscribe; `docs/n8n.md` stays the answer for automation; `docs/design-system.md` §7 and the `docket-ui` skill gain E28. Each says what this entry does not do and which later entry owns it. |

No violations. The `NEEDS DEPENDENCY` and `NEEDS RESEARCH` marks are not violations — they are what
constitution I and VI instruct a phase that cannot reach the web or the registry to write down instead of
guessing. The Complexity Tracking table below is therefore empty.

## Project Structure

### Documentation (this feature)

```text
specs/044-email-delivery/
├── spec.md              # Input
├── plan.md              # This file
├── research.md          # Phase 0: the two marked gaps, and plan decisions E1-E34
├── data-model.md        # Phase 1: the three tables, the invariants, the send protocol, the statements
├── quickstart.md        # Phase 1: how to run it and the checks that prove each story
├── contracts/
│   ├── mailer.md        # The Mailer interface, the env group, the outcomes, the transport seam
│   ├── services.md      # Pure modules, DAL and service signatures, the token, errors, wording
│   ├── http.md          # The unsubscribe page, the one-click route, the two pages, no public API
│   └── ui.md            # The settings section, the unsubscribe page, wording, accessibility
├── checklists/          # Existing
└── tasks.md             # Phase 2 (/speckit-tasks) - NOT created here
```

### Source code (repository root)

```text
src/
├── lib/
│   ├── email/
│   │   ├── schedule.ts         # NEW  pure: nextDue, the quiet window, DST, same-local-day (E12-E14)
│   │   ├── schedule.test.ts    # NEW  both DST directions, two zones, wrapping windows, hour/zone changes
│   │   ├── render.ts           # NEW  pure: the text part and its minimal HTML alternative (E30)
│   │   ├── render.test.ts      # NEW  grouping, the overflow sentence, no remote content, one date format
│   │   ├── unsubscribe.ts      # NEW  pure over the crypto helper: mint and read the token (E19, E20)
│   │   ├── unsubscribe.test.ts # NEW  round trip, expiry, tamper, truncation, foreign key, no identifier
│   │   ├── text.ts             # NEW  every sentence the screens and confirmations use
│   │   └── text.test.ts        # NEW  wording, including the one-date-format lint
│   └── notifications/eligibility.ts   # unchanged, imported (N40, FR-009)
├── server/
│   ├── mail/
│   │   ├── types.ts            # NEW  Mailer, MailMessage, MailOutcome (E4)
│   │   ├── index.ts            # NEW  getMailer(): Mailer | null, setMailerForTests (E3)
│   │   ├── unavailable.ts      # NEW  the Mailer that always answers "unavailable" (E3, FR-005)
│   │   └── smtp.ts             # NEW  createSmtpMailer(config): Mailer | null - the one NEEDS DEPENDENCY file (E5)
│   ├── env.ts                  # + SMTP_* fields, smtpIssues(), toSmtp() -> getEnv().smtp (E1, E2)
│   ├── startup/validate.ts     # + the two `disabled` lines: off, and configured-but-unavailable (FR-005)
│   ├── db/
│   │   ├── schema/email.ts     # NEW  emailSettings, emailProjectState, emailDeliveryAttempts
│   │   ├── schema/index.ts     # + the re-exports
│   │   └── project-owned.ts    # + one registry line (email_project_state)
│   ├── dal/
│   │   ├── email.ts            # NEW  claim/recover/record, the position upsert, the log, the purge
│   │   └── activity.ts         # + a marks mode that excludes anything hidden now, and the email reads (E15)
│   ├── scheduler/
│   │   ├── email.ts            # NEW  the sixth tick section (E17, E18)
│   │   ├── config.ts           # + EMAIL_DEFAULTS and emailConfig() beside WEBHOOK_DEFAULTS
│   │   └── index.ts            # + the section in the Promise.all and in TickSummary
│   └── services/
│       ├── email/
│       │   ├── index.ts        # NEW  mySettings, saveSettings, resume, the unsubscribe operations
│       │   ├── assemble.ts     # NEW  one person -> one message or nothing (N47, N51, FR-011)
│       │   └── send.ts         # NEW  the three-transaction send, shared by the tick and the tests (E9)
│       └── invitations/
│           ├── delivery.ts     # the result gains `email`; defaultInvitationDelivery mails (E25, E26)
│           └── index.ts        # the catch returns the fallback instead of throwing (E26)
├── app/
│   ├── notifications/
│   │   ├── page.tsx            # + the "Email" card: cadence, hour, zone, quiet hours, pause, last outcome
│   │   └── actions.ts          # + saveEmailSettings, resumeEmail
│   ├── email/unsubscribe/
│   │   ├── page.tsx            # NEW  session-less; GET renders and writes nothing (N57)
│   │   └── actions.ts          # NEW  the four submits: all off, this project, digest instead, back on
│   ├── api/email/unsubscribe/
│   │   └── route.ts            # NEW  POST only: the mail client's own one-click path (E21)
│   └── p/[projectSlug]/settings/members/
│       └── actions.ts          # the DTO carries which delivery happened (E25)
├── components/
│   ├── email/
│   │   ├── EmailSettingsCard.tsx   # NEW  one form, one Save, plus its own pause/resume form (E29)
│   │   └── BrowserTimeZone.tsx     # NEW  leaf client enhancement: pre-fill the zone (N48)
│   └── members/InviteResult        # tells the inviter which delivery happened (FR-041)
drizzle/
└── 0022_*.sql                  # NEW  three additive CREATE TABLEs (+ meta/)

tests/
├── helpers/
│   ├── mailer.ts               # NEW  the recording mailer: a queue of outcomes, the captured messages
│   └── email.ts                # NEW  seed settings, a due person, a project with problems
├── integration/email/
│   ├── env-group.test.ts            # NEW  all-or-none, satellites, the credential pair, off-when-unset
│   ├── cadence.test.ts              # NEW  off/immediate/digest, mid-day switches, no projects, all off
│   ├── quiet-hours.test.ts          # NEW  deferral as one message, wrapping, two zones, both DST ends
│   ├── dst.test.ts                  # NEW  skipped hour, repeated hour, zone change, unknown zone
│   ├── assembly.test.ts             # NEW  read/dismissed/snoozed/expired/kind-off/platform-off/below-floor
│   ├── no-double-send.test.ts       # NEW  concurrent ticks, kill at each stage, throw-after-accept, hang
│   ├── failure-pause.test.ts        # NEW  backoff, the threshold, permanent rejection, resume
│   ├── tick.test.ts                 # NEW  budget, concurrency, kill-safety, fairness, other sections, in-process
│   ├── unavailable.test.ts          # NEW  configured-but-unavailable: logged, no advance, no tight loop
│   ├── unsubscribe.test.ts          # NEW  every token case, the GET, the four submits, the one-click POST
│   ├── invitations.test.ts          # NEW  the nine combinations, contents, no unsubscribe, the inviter's message
│   ├── no-secrets.test.ts           # NEW  every failure path with logs captured
│   ├── authz.test.ts                # NEW  own only, API keys refused, foreign/unknown project, deletion
│   ├── email-migration.test.ts      # NEW  0022 on a seeded install (own database)
│   └── ui.test.ts                   # NEW  each state, keyboard, accessible names, no client JavaScript
├── integration/security/secret-scan.test.ts   # + the SMTP group, a rendered email, a failing send
└── lint/date-format.test.ts                   # unchanged; the new wording must pass it

docs/
├── decisions.md        # N42-N67 next to N5/N6/N8/N10/N27/R1/R14; plan decisions E1-E34
├── deployment.md       # configuring a mail server; no mail server; delivery reports; the backup caveat
├── accounts.md         # "Docket sends no email" -> both paths
├── build-prompt.md     # the line 85 promise, now kept
├── activity.md         # Notifications: email, cadence, quiet hours, unsubscribe
├── design-system.md    # §7: the no-JavaScript control exception (E28)
└── n8n.md              # unchanged; still the answer for automation
.claude/skills/docket-ui/SKILL.md   # the same exception, for later UI work
.env.example            # the SMTP group, the credential pair, the three satellites
```

**Structure Decision**: the existing single Next.js app, with two new folders that mirror two that already
exist. `src/server/mail/` is `src/server/storage/` with a different verb — types, a memoised
`get*(): T | null`, a concrete implementation and a test seam — because "a capability that is either
configured or absent" is a shape this repository has already settled and tested. `src/lib/email/` sits
beside `src/lib/notifications/` for the same reason the eligibility rule lives there: it is pure, so the
mailer, the screens and the tests share it without a database. The store goes in
`src/server/db/schema/email.ts`, the statements in `src/server/dal/email.ts`, the callers in
`src/server/services/email/`, the recurring work in `src/server/scheduler/email.ts` beside `webhooks.ts`,
and the screens reuse the existing `/notifications` page — exactly where 022, 042 and 043 put the same
concerns.

## Phase 0 — Research

[research.md](./research.md) records two marked gaps and thirty-four plan decisions.

**The two gaps**, both already named in the spec and neither resolvable by a headless phase:

- **`NEEDS DEPENDENCY: nodemailer`.** Verified absent: no mail package in `package.json`, nothing matching
  `mail` or `smtp` in `node_modules`. Confined to `src/server/mail/smtp.ts` and one task.
- **`NEEDS RESEARCH: SMTP`.** There is no `docs/research/smtp.md`. Two kinds of fact depend on it and
  **neither is guessed anywhere in this plan**: the submission port and transport-security defaults and
  how `SMTP_SECURITY` maps onto the client's options (E2), and the one-click unsubscribe header names and
  their exact semantics, which FR-026 requires come from research rather than memory (E21). The design
  routes around both: the env layer validates range and membership only and `.env.example` points at the
  research file, while the token, the page and the POST route are built and tested in full — the headers
  are one line added to an already-tested message by the same task that writes the research.

The remaining decisions **E1–E34** are design choices about this repository's own code. The ones worth
reading before implementation starts:

- **E9/E10** — the three-transaction send and the `sending_seq` column, which is the whole of "never
  twice, even at the cost of never". Both the reason a two-transaction design is wrong (a known temporary
  failure must *not* advance the position, FR-023) and the reason a position advanced before sending is
  wrong (it would make every temporary failure lose a message) are written out.
- **E12** — why `nextDue()` takes `lastSentAt`: without it, a person who moves their digest from 07:00 to
  06:00 at 06:30 either gets two digests or silently loses a day, both forbidden by FR-020.
- **E19** — why the unsubscribe token is AES-256-GCM ciphertext rather than N56's literal "signed", and
  why that is a strengthening rather than a departure: FR-026 forbids the URL from containing a user
  identifier at all, which a signed-but-readable payload cannot satisfy.
- **E28** — the one extension to `docs/design-system.md`, and why `Combobox` cannot be the zone control on
  a screen that must work with client JavaScript unavailable.

## Phase 1 — Design

- [data-model.md](./data-model.md): the three tables with their keys, checks, indexes and lifecycles; the
  fourteen invariants; the send protocol as a numbered sequence with the crash point marked at each step;
  the exact shape of every new and changed statement; the migration; and the entity summary mapped to the
  spec's Key Entities.
- [contracts/mailer.md](./contracts/mailer.md): the `Mailer` interface, `MailMessage`, the four outcomes
  and how each failure classifies; the env group, the credential pair, the satellites and every validation
  message; `getMailer()`'s three states; and the transport seam with its two marks.
- [contracts/services.md](./contracts/services.md): the pure modules' signatures, the DAL and service
  signatures, the token's plaintext and its refusal rules, the Zod boundary, the order in which a bad
  request is refused, and every new sentence of wording.
- [contracts/http.md](./contracts/http.md): the unsubscribe page and its four submits, the one-click POST
  route, the changed `/notifications` page, and the deliberate absence of any public-API operation or
  webhook event for email.
- [contracts/ui.md](./contracts/ui.md): the settings card in each of its six states, the unsubscribe page,
  the invite confirmation, the required wording, the accessibility checklist, and the docs this entry owes.
- [quickstart.md](./quickstart.md): how to run it with and without a mail server, the check that proves
  each of the eight user stories, the 500-person performance case, and the by-hand walk-through that goes
  last.

**Post-design Constitution re-check**: still passing, with nothing new to justify. The design adds three
additive tables, two pure folders, one tick section, one page, one route handler and one dependency that
is marked rather than installed; it changes no existing table, no existing index and no notification rule.
Isolation is enforced by the project-owned registry plus the scheduler's named escape hatch; one module
owns each question; no address, credential, body, subject or token enters any stored row, log line,
response or snapshot; no queue, no infrastructure and no environment variable beyond the SMTP group
appears. The single extension to `docs/design-system.md` is argued in E28 and written into that document
in the same change.

## Complexity Tracking

No constitution violation to justify. The one new runtime dependency is argued under principle VI above
and recorded in `docs/decisions.md` as E5/E32; it is marked `NEEDS DEPENDENCY` rather than hand-rolled,
which is what the principle instructs.
