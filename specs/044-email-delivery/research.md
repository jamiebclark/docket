# Phase 0 — Research: Email delivery

Two gaps a headless phase cannot close, and thirty-four plan decisions (**E1–E34**) about this
repository's own code. Each decision gives what was chosen, why, and what was rejected.

---

## 1. The two marked gaps

### `NEEDS DEPENDENCY: nodemailer`

**Verified, not assumed.** `package.json` lists seventeen runtime dependencies and none of them speaks
SMTP; `ls node_modules | grep -iE 'mail|smtp'` returns nothing. Pipeline phases cannot reach the npm
registry (`docs/decisions.md` #19), and constitution VI forbids hand-rolling a substitute or guessing a
package's API.

**Consequence, bounded**: one file (`src/server/mail/smtp.ts`) and one task. Everything else is built
against the `Mailer` interface. See **E5**.

### `NEEDS RESEARCH: SMTP`

There is no `docs/research/smtp.md`, and constitution I says a fact that is not there is marked, not
guessed. Two kinds of fact depend on it, and **this plan asserts neither**:

1. **The submission port and transport-security defaults**, and how a `SMTP_SECURITY` mode maps onto the
   client's connection options. Routed around by **E2**: the env layer validates a port *range* and
   membership of a mode *list* and applies **no default**; the default is the transport's to choose and to
   document, in the same task that writes the research file.
2. **The one-click unsubscribe header names and their exact semantics** (FR-026 says so in as many
   words: "Those header names and their exact semantics MUST come from research, not memory"). Routed
   around by **E21**: the token, the landing page, the four submits and a POST route that acts without a
   page and without a session are all built and tested now; the headers are a `headers` map on an
   already-tested `MailMessage`, added by the task that has the research, with the test asserting the
   names that research produced rather than names chosen here.

**What this costs**: an install that configures the SMTP group before that task lands gets the
*unavailable* capability — a startup line, a logged attempt per person per hour, no bookkeeping movement
and no false "we emailed you". That is FR-005 implemented, not a gap left open.

---

## 2. Configuration and the capability

### E1 — The group is `SMTP_HOST` and `SMTP_FROM`; the credentials are an all-or-none pair that requires it

**Decision**: group members `SMTP_HOST`, `SMTP_FROM`. Credential pair `SMTP_USER`, `SMTP_PASSWORD` — both
or neither, and either without the group is an issue. Optional satellites `SMTP_PORT`, `SMTP_SECURITY`,
`SMTP_FROM_NAME`; any satellite without the group is an issue. `smtpIssues(source)` is written against
`storageIssues()` (`src/server/env.ts:78-128`) with the same three branches and the same phrasing, and is
pushed from `crossFieldIssues()` exactly as `storageIssues()` is.

**Rationale**: a host with nowhere to send from, or a from-address with no host, is meaningless — those
two are the group. N43 is explicit that credentials must *not* be in the group, because an unauthenticated
relay on a private network is a real deployment and the group must not force dummy credentials on it.

**Rejected**: putting `SMTP_USER`/`SMTP_PASSWORD` in the group (breaks the private-relay case N43 names);
a single `SMTP_URL` connection string (it would carry the password in one variable that every log-scrubber
and screenshot has to know about, and it cannot produce per-variable validation messages FR-003 requires);
a `MAIL_ENABLED` boolean (the storage group proves the capability can be derived — a second switch can
disagree with the configuration, which is N26's lesson).

### E2 — The satellites have no default in the env layer; the default is the transport's and is `NEEDS RESEARCH`

**Decision**: `SMTP_PORT` validates an integer 1–65535 and is `undefined` when unset; `SMTP_SECURITY`
validates membership of `SMTP_SECURITY_MODES` (exported from `src/server/mail/types.ts`) and is
`undefined` when unset. `getEnv().smtp` carries them as `port?: number` and `security?: string`.
`createSmtpMailer()` chooses the default and `.env.example` documents it by pointing at
`docs/research/smtp.md`, both written by the task that installs the package.

**Rationale**: FR-001 requires satellites with *documented defaults*, and a submission port and a
STARTTLS-versus-implicit-TLS default are precisely the protocol facts constitution I forbids writing from
memory. Deferring the value to the one task that can know it keeps FR-001 satisfied when it lands and
keeps this plan honest in the meantime. Nothing else depends on the value: no test asserts a number, only
that an out-of-range port and an unknown mode are refused by name with no value in the message.

**Rejected**: writing `587` and `starttls` into the schema now and "fixing it later" — that is the guess
constitution I exists to prevent, and a wrong default would silently fail to connect on every install;
making both group members (FR-001 says satellites).

### E3 — `src/server/mail/` is `src/server/storage/` with a different verb

**Decision**: `getMailer(): Mailer | null`, memoised per process from `getEnv().smtp`, with
`setMailerForTests(mailer | null | undefined)` as the only seam — the exact shape, names and comments of
`src/server/storage/index.ts`. Three states collapse into two for the caller:

| `getEnv().smtp` | transport | `getMailer()` |
|---|---|---|
| unset | — | `null` — email is off (FR-002) |
| set | `createSmtpMailer()` returned a mailer | that mailer |
| set | `createSmtpMailer()` returned `null` | `unavailableMailer` (FR-005) |

**Rationale**: N42 says every caller asks one question. A third return value would make every call site
branch three ways and would leak the `NEEDS DEPENDENCY` state into the screens, the tick and the
invitation path. Instead the unavailable state is a `Mailer` that answers `{ kind: "unavailable" }` to
every send, so the capability check (`null` or not) and the outcome handling are each one thing.

**Rejected**: `requireMailer()` throwing (`StorageUnavailableError`'s shape) — no caller here wants an
exception: a missing mailer is a normal state on most installs, and FR-005 requires a *recorded* outcome
rather than a thrown error. The symbol is deliberately not added.

### E4 — The `Mailer` interface and its four outcomes

**Decision**: one `send(message: MailMessage): Promise<MailOutcome>` that **never throws**.
`MailMessage = { to, subject, text, html, headers? }`; `MailOutcome` is a discriminated union of
`sent` | `rejected` (permanent) | `failed` (temporary, with a classified `reason`) | `unavailable`, each
carrying `durationMs` and, where the conversation produced one, a numeric `code`. Mirrors
`InvitationDelivery`'s shape: one method, a result union, injectable.

**Rationale**: FR-004 names the four outcomes. "Never throws" is what keeps FR-034 structural rather than
a discipline — an exception is the one value in JavaScript that carries a message nobody chose, and a mail
server's error message routinely quotes the address.

**Rejected**: throwing typed errors (`sendDelivery` in the webhook service already demonstrates the
return-a-value style for exactly this reason); returning a boolean plus an out-parameter; one `failed`
outcome covering both permanent and temporary (FR-023 treats them completely differently — one pauses at
once, the other backs off).

### E5 — The wire transport is one file whose body is the only thing the deferred task rewrites

**Decision**: `src/server/mail/smtp.ts` ships now, exporting
`createSmtpMailer(config: SmtpConfig): Mailer | null`. Its body today is a single `return null` with the
comment that names both marks. The task that installs the package replaces that body and nothing else.

**Rationale**: the alternative shapes all have traps. A `try { await import("nodemailer") } catch {}`
makes a bundled standalone Next build depend on a module resolution failure at runtime — fragile, and
hard to test. A missing file makes `src/server/mail/index.ts` fail to compile. A file that exists and
returns `null` compiles, typechecks, is importable from the test suite, and makes the
configured-but-unavailable path a first-class state with a test of its own
(`tests/integration/email/unavailable.test.ts`).

**Rejected**: hand-rolling SMTP over `node:net` (FR-005 and constitution VI forbid it, and a hand-rolled
client is exactly where the protocol facts this phase does not have would have to be invented); shelling
out to `sendmail` (FR-005 forbids it by name, and it would not work in the container); a hosted
provider's HTTP API (out of scope, spec Assumptions).

---

## 3. What a person chooses

### E6 — One sparse settings row per person; absence is "off"

**Decision**: `email_settings` keyed on `user_id`, created only by the first save (or by a one-click
unsubscribe writing `off`, which is a no-op when no row exists). No migration inserts a row.

**Rationale**: N45/FR-007 require email off for everybody, with nothing in the migration opting anybody
in. Making absence mean off turns that from a rule a future migration has to remember into a fact about
the database — the same move Q2 made for `notification_preferences`, and the reason that migration was a
no-op for every unmuted row.

**Rejected**: a row per person created on signup with `cadence = 'off'` (a backfill over every existing
user, and a migration that touches person data for no behavioural gain); a column on `user` (Better Auth
owns that table's schema).

### E7 — The claim lives on the settings row, not in a second table

**Decision**: `email_settings` also carries `next_due_at`, `lease_owner`, `lease_until`,
`consecutive_failures`, `paused_at`, `paused_reason`, `last_attempt_at`, `last_outcome`, `last_sent_at`.
The spec's "Email send claim" Key Entity is these columns, not a separate table.

**Rationale**: there is exactly one row per person and exactly one claim per person, with the same
lifecycle (deleted with the user) — a second table keyed the same way could only ever disagree. It also
makes an edge case structural rather than defended: *"the same person is due for both a deferred
quiet-hours batch and a digest at the same instant: one message, not two"* is true because there is one
`next_due_at` and one lease, so a person is one claimable unit.

**Rejected**: a separate `email_send_claims` table (two rows to keep in step, and a claim that can be
orphaned); putting the lease on `email_project_state` (a person's message spans projects; a per-project
lease would let two ticks each send "their" project's problems to the same inbox).

### E8 — One per-project row carries the position, the exclusion and the in-flight high-water

**Decision**: `email_project_state(project_id, user_id, mailed_seq, excluded, sending_seq)`, PK
`(project_id, user_id)`, composite FK to `member ON DELETE CASCADE`. Absence means (nothing mailed, not
excluded) — the neutral default for both.

**Rationale**: the spec's "Email exclusion" and "Mailed-through position" entities have the same key, the
same lifecycle and the same "absence is neutral" rule, so one table is one row to write, one FK to
cascade and one index to maintain. The composite FK to `member` is R1/M1/Q1's shape, which makes FR-025's
"deleted with the membership, in the same transaction" the database's job rather than a service's.

**Rejected**: two tables (two inserts, two cascades, two chances to leave one behind — and the
per-project unsubscribe would have to upsert into one while reading the other); `excluded` as a nullable
timestamp (nothing needs *when*; FR-030 says the state is the setting, not a history).

---

## 4. Never twice

### E9 — Three transactions and a `sending_seq` column

**Decision**, per claimed person:

| Step | Transaction | What it does | Crash here means |
|---|---|---|---|
| 1 | yes | claim: `FOR UPDATE SKIP LOCKED` over due rows, set `lease_owner`/`lease_until` | the lease expires; recovery finds `sending_seq` NULL everywhere, releases it, nothing was sent |
| 2 | **no** | assemble: reads only, over the person's projects | as above |
| 3 | yes | under the lease, write `sending_seq = <the max seq this message covers>` per project | recovery treats it as **sent** (E10) — the message may never have gone out, and N54 accepts that |
| 4 | **no** | `mailer.send()` | as step 3 |
| 5 | yes | record: the attempt row; on a known send `mailed_seq = GREATEST(mailed_seq, sending_seq)` and `sending_seq = NULL`; on a known temporary failure `sending_seq = NULL` and back off; on a permanent rejection pause | — |

**Rationale**: the two obvious simpler designs are each wrong for a requirement the other satisfies.

- *Advance the position before sending* (two transactions): a **known** temporary failure would then have
  already consumed the problems, so the retry FR-023 mandates would re-assemble nothing and the message
  would be lost on the first 4xx. Forbidden.
- *Advance the position after sending only* (two transactions): a crash between step 4 and step 5 leaves
  the position where it was, so the next tick sends the same problems again. That is the duplicate N54
  calls the failure that loses the channel for good. Forbidden.

`sending_seq` is the smallest thing that distinguishes "we had not started" from "we may have finished",
and it is written under the lease so only the owner can set it. Three transactions per person is one more
than webhook delivery takes and buys exactly the property US6 is about.

### E10 — Recovery of an expired lease is "sent"

**Decision**: the email section's first act each tick is `recoverEmailClaims()`: for every row with
`lease_until <= now`, in one transaction, set `mailed_seq = GREATEST(mailed_seq, sending_seq)` and
`sending_seq = NULL` for that person's project rows where `sending_seq IS NOT NULL`, write one attempt row
with outcome `internal`, clear the lease, and roll `next_due_at` forward through `nextDue()`.

**Rationale**: N54 and FR-022 in as many words. The attempt row with `internal` is how a person sees that
something happened (FR-035) without Docket claiming a send it cannot vouch for.

**Rejected**: retrying a recovered claim (the duplicate N54 forbids); leaving the lease to expire with no
record (FR-032 requires every attempt recorded, and a silent gap is what makes "is email working?"
unanswerable).

### E11 — One `next_due_at` drives both cadences, and ordering by it is the fairness rule

**Decision**: `next_due_at` is an absolute instant for every active cadence. Immediate: `now` (always
due) unless inside quiet hours, when it is the window's end. Digest: the resolved chosen hour. The claim
is `WHERE cadence <> 'off' AND paused_at IS NULL AND next_due_at <= now AND lease_owner IS NULL ORDER BY
next_due_at ASC LIMIT maxPerTick FOR UPDATE SKIP LOCKED`, which serves the longest-overdue first.

**Rationale**: FR-016, FR-017, FR-018 and FR-024's "longest-waiting first" all reduce to one indexed
column and one `ORDER BY`. One partial index, `(next_due_at) WHERE cadence <> 'off' AND paused_at IS NULL
AND lease_owner IS NULL`, is the webhook claim index's shape.

**Rejected**: a `due` boolean recomputed by a scan; selecting all immediate-cadence people every tick and
filtering in TypeScript (unbounded, and loses the fairness ordering); two queries, one per cadence (two
claims means a person can be claimed twice — the edge case E7 makes impossible).

### E12 — `nextDue()` takes `lastSentAt`, because otherwise FR-020 cannot hold

**Decision**: one pure function,
`nextDue(settings: ScheduleSettings, lastSentAt: Date | null, now: Date): Date`.

- `off` → never called.
- `immediate` → `now`, or the end of the quiet window when `now` is inside it.
- `digest` → today's resolved hour if it is still in the future; else, if it has passed **and** no send
  has happened on today's local date, `now` (a late digest, N53); else tomorrow's resolved hour.

**Rationale**: the spec's hardest edge case is *"A person changes their digest hour from 07:00 to 06:00 at
06:30, with today's 07:00 digest not yet sent: exactly one digest is sent today, and changing the hour
never produces two in one day or silently skips a day's problems."* A function of `(settings, now)` alone
has to pick between tomorrow (skips a day — FR-020 forbids) and today-at-06:00-already-past (sends, but
with no way to know a digest already went out this morning, so a 06:00→07:00 change would send twice —
FR-020 also forbids). Comparing the local date of `lastSentAt` with the local date of `now` resolves both,
and it is the same comparison N53's late-digest rule needs. One function, four rules, no hidden state.

**Rejected**: a `last_sent_local_date date` column (derivable from `last_sent_at` and the zone, and it
would be wrong the moment the person changed zone); recomputing from the previous `next_due_at` (N50
forbids recomputing a resolved instant, and a zone change would corrupt the chain).

### E13 — "Same local day", and why a missed digest is skipped rather than sent stale

**Decision**: `isSameLocalDay(a, b, zone)` compares
`Instant.toZonedDateTimeISO(zone).toPlainDate()`. A digest whose due instant is on an earlier local day
than `now` is skipped: no send, no attempt row, no position movement, `next_due_at` rolls to the next
occurrence.

**Rationale**: N53/FR-017. The position only advances on an actual send, so the skipped digest's problems
are all still eligible for the next one — nothing is lost, and nobody gets a two-day-old digest at a
random hour.

### E14 — Quiet hours are two nullable hour columns; equal ends normalise to none

**Decision**: `quiet_start_hour`, `quiet_end_hour`, both `smallint` 0–23, `CHECK` both-or-neither. The Zod
boundary normalises `start === end` to `(null, null)`. A window where `start > end` wraps midnight.
`insideQuietHours(settings, instant)` is a wall-hour comparison in the person's zone, so a window's end is
resolved per local day with the same disambiguation as the digest hour.

**Rationale**: FR-006 ("may wrap midnight") and the edge case *"quiet hours set to an empty window:
immediate email behaves as if none were set"*. Normalising at the boundary means one representation of
"none" reaches the clock module, so the resolver has no equal-ends special case and the screen has one
state to render. Hour granularity is all FR-006 and the spec's Assumptions ask for.

**Rejected**: storing minutes (no requirement, and it doubles the DST surface); a separate
`quiet_hours_enabled` boolean (a third state that can disagree — N26's lesson again); storing resolved
instants (the window recurs daily; N50's "store absolute" applies to a *due* instant, which is what
`next_due_at` is).

---

## 5. Assembly

### E15 — Assembly reuses the existing attention branch builder, with one new marks mode and one `minSeq`

**Decision**: `listBranch()` in `src/server/dal/activity.ts` gains a marks mode. Today `marks: {userId}`
excludes live finite snoozes and *flags* read-for-ever marks as `hidden_by_mark`, because the panel shows
read rows greyed. Email needs them gone, so the parameter becomes
`marks: { userId, exclude: "snoozed" | "hidden" }` — `"snoozed"` is today's behaviour, unchanged for every
existing caller; `"hidden"` moves the `hidden.event_id IS NULL` test into the inner `WHERE`, before
`LIMIT`, so the bound still holds after exclusion (the M16 rule the existing anti-join already follows).

The per-project `minSeq` passed into each branch becomes
`max(groupThreshold, floor, mailed_seq)` — the switch threshold the compiled plan already supplies, the
reading floor from `notification_states.seen_seq`, and the mailed-through position. Three reasons an event
is not mailed, one comparison.

**Rationale**: FR-009 says import the rule unchanged, and FR-012 says exclude read, dismissed and snoozed
as at the moment of sending. Both are satisfied by one new mode on a builder that is already tested for
the branch, platform, cardinality and `LIMIT` behaviour. Writing a second attention query would be the
"second notion of what someone cares about" FR-009 forbids and would be able to drift.

**Rejected**: a new standalone email query (drift, and it would have to re-derive the platform clause);
filtering in TypeScript after the read (breaks the `LIMIT` bound — a person with 20 marked events and a
limit of 20 would get an empty message while problems waited).

### E16 — The bounds: 20 listed, 1000 scanned, the overflow counted exactly within that

**Decision**: `EMAIL_LIST_LIMIT = 20`, `EMAIL_SCAN_LIMIT = 1000`. Per project, two reads over the same
predicate: the newest `EMAIL_LIST_LIMIT` rows for display, and `SELECT count(*), max(seq) FROM (… LIMIT
EMAIL_SCAN_LIMIT)` for the overflow count and the high-water. The message lists up to 20 and says how many
more, with a link. `sending_seq` is the `max(seq)` of the scanned set, so the position advances over the
counted overflow as well as the listed problems.

**Rationale**: FR-011 requires a bound and an honest count; the edge case requires that a very bad day
produce one message, not a run of them, which only holds if the position covers the overflow. 20 is a
message a person reads; 1000 bounds the count query so a project with a hundred thousand events cannot
turn one tick into a sequential scan. A day that produces more than 1000 eligible problems for one person
produces at most a handful of messages instead of hundreds — stated, not hidden.

**Rejected**: an unbounded count (an unbounded scan inside a 20-second budget); reusing `UNREAD_CAP` (100)
and displaying "99+" (FR-021 needs the position to cover what was counted, and "99+" cannot tell the
position how far to move); listing everything (an unreadable message, and FR-011 forbids it).

---

## 6. The tick

### E17 — A sixth section, with constants beside `WEBHOOK_DEFAULTS` and no new environment variable

**Decision**: `runEmailDeliveries()` joins the `Promise.all` in `runTick()` and `TickSummary` gains an
`email: SectionResult<EmailCounts>`. `EMAIL_DEFAULTS` in `scheduler/config.ts`:

| Constant | Value | Why |
|---|---|---|
| `maxPerTick` | 50 | SC-009's 500 due people are served in **10 ticks**; the asserted bound |
| `concurrency` | 8 | the webhook section's shape; 50 sends at 8 abreast fit the budget with room |
| `minWindowMs` | 11 000 | webhooks' value: enough for one send plus the recording transaction |
| `backoffBaseMs` | 60 000 | webhooks' value |
| `backoffMaxMs` | 21 600 000 (6 h) | webhooks' value |
| `pauseAfterFailures` | 5 | FR-023's stated threshold (see below) |
| `unavailableRetryMs` | 3 600 000 (1 h) | FR-005's "nothing retried in a tight loop" |
| `retentionDays` | 30 | the webhook log's retention; FR-032's log is the same shape |

**Rationale**: the webhook tunables are constants rather than environment variables, and every one of
these is the same kind of knob. Constitution VII and the roadmap both want the new-variable surface as
small as possible; the SMTP group is seven variables already.

`pauseAfterFailures = 5` rather than the webhook endpoint's 20: a webhook endpoint's 20 consecutive
failures are 20 deliveries of possibly unrelated events, whereas five consecutive failures to reach one
person's inbox, with 60 s doubling to a 6 h cap, already span most of a day. Pausing sooner is kinder to
the mail server and to the person, and FR-023 makes the pause theirs to lift.

**Rejected**: `EMAIL_*` environment variables (no requirement asks for them, and each is a validation
branch, a `.env.example` block and a test); putting email inside the webhook section (two unrelated
budgets fighting); a separate process or cron (constitution VI: the tick is the only recurring execution
Docket has).

### E18 — The section's first line is the capability check

**Decision**: `if (!getMailer()) return emptyEmailCounts();` before any query, any clock read and any
heartbeat.

**Rationale**: SC-006 asks for **0** behaviour changes on an install with no mail configuration. Making
that one `if` the first statement makes it structural: there is no query to be slow, no table to lock, no
heartbeat row to appear, and `tests/integration/email/cadence.test.ts` can assert zero statements through
the scope harness.

---

## 7. Getting out of it

### E19 — The unsubscribe token is AES-256-GCM ciphertext, not a signed payload

**Decision**: `encryptSecret(JSON.stringify(payload), { aad: "docket-unsubscribe-v1" })` from
`src/server/crypto/secrets.ts`, carried in a query parameter. Reading it is `decryptSecret` with the same
AAD, then a shape and expiry check. Nothing is stored.

**Rationale**: FR-026 forbids the URL from containing "no user identifier, address, project slug or event
identifier". A signed-but-readable payload — N56's literal word is "signed" — necessarily contains the
user id in the clear, so it cannot satisfy FR-026 as written. AEAD satisfies both halves at once:
authentication gives the tamper rejection N56 wants, and encryption gives FR-026's "names nobody". Every
bad case collapses onto one `SecretDecryptionError`: tampering and truncation fail the auth tag,
re-signing with another key fails the key-id check the helper already performs, and a rotated
`CREDENTIALS_ENCRYPTION_KEY` fails the same check — which is exactly what the spec's edge case asks for
("refused as tampered, with the same neutral page"). This is recorded in `docs/decisions.md` next to N56
as a **strengthening**, with the reason, not as a silent substitution.

**Rejected**: HMAC over a base64url JSON payload with `BETTER_AUTH_SECRET` (readable user id — fails
FR-026); a random token stored hashed, invitation-style (FR-031 forbids a stored row, N56 forbids
single-use, and a 60-day non-single-use row per message is unbounded growth); a Better Auth verification
token (that table is Better Auth's, and these are not sign-in grants).

### E20 — The token's plaintext, and its 60 days

**Decision**: `{ v: 1, u: <userId>, p: <projectId> | null, x: <expiry epoch seconds> }`, expiry
`now + 60 days` (N56). `p` is the project a single-project message was about, so FR-029's "a token whose
per-project scope names a project the person has left" is a real case with a real test; a digest spanning
several projects mints `p: null`. The page lists the person's **current** projects either way, so the
per-project option works from any token.

**Rationale**: N56 wants a token that "states who it is for and what it may change". 60 days outlives the
mail by a wide margin and is not single-use, because a person who finds the mail a month later must still
be able to act (N56).

**Rejected**: a project id required (a digest has several); a scope enum per action (the page offers four
submits; narrowing the token per button would mean four tokens in one message); no expiry (N56 requires
one).

### E21 — A page for the human, a POST route for the mail client

**Decision**: `GET /email/unsubscribe?t=<token>` renders and **writes nothing** (N57, FR-027); its four
submits are server actions. `POST /api/email/unsubscribe?t=<token>` is a Route Handler with no page, no
session and no body requirement — the mail client's own one-click path, which *does* act immediately
(FR-027). Both are session-less and `force-dynamic`; the page is `noindex`.

**Rationale**: in the App Router a page cannot handle a POST, so the one-click target has to be a Route
Handler; the split also makes "a scanner's GET changes nothing" structural rather than a guard that can be
forgotten. **The headers that point a mail client at that route, and the exact body it sends, are
`NEEDS RESEARCH`** — the route is written to act on the token in the query string and to ignore the body
entirely, so whatever the research says the client posts, the route already handles it. The task that
writes `docs/research/smtp.md` adds the header lines to `MailMessage.headers` and asserts the names.

**Rejected**: one route handling GET and POST (a GET that renders HTML from a route handler loses the
layout, the shell and the accessibility primitives); acting on the GET (N57 names the three fetchers that
would unsubscribe people silently).

### E22 — One click is `cadence = 'off'`, and nothing else

**Decision**: the one-click path and the page's first submit both write `cadence = 'off'`, clear the lease
and `next_due_at`, and leave every `notification_preferences` row, `notification_states` floor and
`notification_event_marks` row untouched. The per-project submit writes
`email_project_state.excluded = true`. The digest-instead submit writes `cadence = 'digest'` with the
stored (or default) hour. The back-on submit writes `cadence = 'immediate'`.

**Rationale**: N58, N59 and FR-030. There is no "suppressed" flag that can disagree with the settings
screen, which is N26's lesson applied to channels; and turning email off cannot change the bell, which is
N5's "hides, does not delete" applied to channels.

**Rejected**: a `suppressed_at` column; deleting the settings row (it would lose the hour and zone the
person chose, and the spec's US5 §7 wants stored settings kept untouched for the day the install comes
back).

### E23 — One neutral page, one status code, for every refusal

**Decision**: a bad token, an expired token, a token for a deleted person, and a per-project submit naming
a project the person has left all render **the same page with the same sentence and HTTP 200**. Nothing is
written on any of them. Using a valid token twice succeeds and says what the state is.

**Rationale**: FR-029 requires the response to reveal nothing about whether a person, project or token
exists. A different status code, a different sentence or a different render time is a probe; 200 with one
sentence is not. Idempotence is FR-029's last clause and the spec's US4 §7.

---

## 8. Written down

### E24 — The log is person-scoped, has no excerpt column, and allows a null person

**Decision**: `email_delivery_attempts(id, user_id, at, purpose, cadence, problem_count, outcome,
smtp_code, duration_ms)`. `user_id` is nullable and `purpose` is `problems` or `invitation`: an invitation
to an address with no Docket account has no person to reference, and FR-033 forbids storing the address,
so that row carries `user_id = NULL`. There is **no** `response_excerpt` column, no project column and no
subject or body column. Outcomes: `sent`, `unavailable`, `refused` (temporary), `rejected` (permanent),
`timed_out`, `connect_failed`, `tls_failed`, `internal`. Pruned at 30 days by the email section, the way
the webhook section prunes its own.

**Rationale**: N60 in full. Omitting the excerpt column is the one deliberate departure from the webhook
log's shape, and the reason is that a refusal routinely quotes the recipient address — classify and
discard beats excerpt and redact, because there is then nothing to get wrong. Not making the table
project-owned is deliberate: a person's message spans projects, and a project column would either be
wrong or force one row per project per attempt.

**Rejected**: a redacted excerpt (FR-033 forbids free text from the server's replies); making it
project-owned (see above); a separate invitation log (two tables recording the same kind of fact under the
same rules — FR-042 says "under the same rules").

### E25 — The invitation result gains one field, and `manual_link` is returned whenever there is no account

**Decision**:

```ts
export type InvitationEmail = "sent" | "failed" | "unavailable";
export type InvitationDeliveryResult =
  | { kind: "in_app"; email: InvitationEmail }
  | { kind: "manual_link"; url: string; expiresAt: Date; email: InvitationEmail };
```

`in_app` still means "they have a login and see it in the app" and is now *also* mailed (FR-040).
`manual_link` is returned for every invitee without an account, whether or not the mail went out, so the
copyable link is always there (FR-041).

**Rationale**: FR-041 says the inviter must always be told which happened **and** keep the link. One field
with three values says it; `kind` keeps its existing meaning so `shownStatus`, the members page and the
existing tests do not shift under them.

**Rejected**: a fourth `kind: "emailed"` (it would make `manual_link` mutually exclusive with the link
FR-041 requires to remain); a boolean `emailed` (cannot distinguish "no mail server" from "the send
failed", which FR-041 requires the inviter be told).

### E26 — Invitation mail is a value, not a throw, and never rolls back the invitation

**Decision**: `deliverAfterCommit()` keeps its name and position (after commit, outside any transaction).
Its `catch` no longer turns a delivery problem into `ConflictError`: a failed send is
`{ kind: …, email: "failed" }` plus one attempt row. The `catch` stays only for programmer errors.

**Rationale**: FR-042 says a failed invitation email must not roll back the invitation, and today's code
throws `ConflictError("created but could not be delivered")`, which would make a mail-server hiccup look
like a failed invite. The mailer never throws (E4), so the normal path cannot reach the `catch` at all.

### E27 — The person's zone default is derived, and the browser only pre-fills

**Decision**: `time_zone text NULL`. When NULL, `derivedZone(projectZones)` returns the single zone every
project of theirs agrees on, else `"UTC"`. A stored zone the runtime does not recognise falls back to UTC
and the screen says so. The browser's zone is applied by `BrowserTimeZone`, a leaf client component that
sets the select's value on mount **only when no zone is stored**.

**Rationale**: N48 and FR-008 — a deterministic default, stated on screen, never inferred silently from a
request. Pre-filling only when nothing is stored means a person who chose a zone never has it changed by
opening the page on holiday.

**Rejected**: reading a zone from an `Accept-Language` or IP header (FR-008 forbids inferring from a
request); defaulting to the first project's zone (not deterministic when projects disagree).

### E28 — One extension to `docs/design-system.md` §7: a no-JavaScript exception for long lists

**Decision**: where a requirement demands the control be **changeable** with client JavaScript
unavailable, a long list uses the `Select` primitive (a native `<select>`), not `Combobox`/`TimeZoneField`.
Applies here to the digest hour (24 options) and the time zone. Cadence (three options) stays a
`SegmentedControl`, which is built on native radios and already works with no JavaScript. The exception
is written into `docs/design-system.md` §7's control table and into the `docket-ui` skill in the same
change.

**Rationale**: `Combobox` is a client component that submits through a hidden input
(`src/components/ui/Combobox.tsx:217`). With no JavaScript the hidden input still renders — carrying the
server-rendered **default** — and the visible text box is not the submitted value, so the control reads as
working while being impossible to change. FR-037, FR-039 and SC-012 require every control to work with
client JavaScript unavailable, so `Combobox` cannot be the zone control on this screen. The design
document's own table already keeps `Select` "for callers outside the design system"; this names the
condition under which it is the right answer inside it. Following the Q18/Q19 precedent, the document is
amended in the same change rather than quietly excepted.

**Rejected**: `Combobox` with a `<noscript>` native select beside it (two controls with the same `name`
submit two values); teaching `Combobox` to server-render a real `<select>` and replace it on hydration
(a worthwhile change to a primitive used on six screens, and far too large to land inside this entry —
noted for a later hardening entry); only three preset hours (FR-006 says a chosen hour).

### E29 — The email settings are one form with one Save; pause/resume is its own one-button form

**Decision**: cadence, hour, zone and quiet hours are one `<form>` ending in one Save (plus the standard
confirmation redirect). Resume-after-pause is a separate one-button form in the Q18 switch shape.

**Rationale**: the preference grid's one-form-per-switch shape exists because many-of-many checkboxes
cannot save themselves (design-system §7, Q18). These four fields are one coherent schedule: saving the
hour without the zone, or the cadence without the quiet window, would leave a schedule nobody chose, and
`nextDue()` has to be recomputed from all four at once. Resume is a different question with a different
answer, so it is a different form.

**Rejected**: a saving submit per field (four partial schedules, four recomputations, four
confirmations); auto-save on change (needs client JavaScript).

### E30 — One pure renderer: text first, HTML derived, no remote anything

**Decision**: `renderProblemEmail(model): { subject, text, html }` in `src/lib/email/render.ts`, pure. The
text part is authoritative and the HTML renders the same content with no images, no remote stylesheet, no
tracking pixel and no click wrapping. Every instant goes through `formatLocal(instant, zone)` — the one
date format, in the **person's** zone (this is their inbox, not a project screen). Colour conveys nothing.

**Rationale**: FR-014, FR-015, the spec's Assumptions ("no tracking of any kind") and the date-format
lint. Pure means the whole of US1, US2, US3 and US8's content assertions are unit tests with no database.

**Rejected**: a template library (constitution VI); an HTML-first body with a generated text fallback
(FR-014 makes the text part authoritative).

---

## 9. Boundaries

### E31 — No public API, no webhook event, no new settings route

**Decision**: the settings live on the existing `/notifications` page and its existing `actions.ts`. No
operation is added to the public API, no webhook event type is added, and no `/api/me/email` route exists.
API keys are refused because the page and both actions resolve a session and nothing else.

**Rationale**: FR-035 ("no public-API operation for email"), FR-044 and US8 §7. Adding nothing is the
cheapest way to satisfy "there is no public-API operation": there is no handler to protect.

### E32 — Nothing else is added to the stack

**Decision**: no queue, no Redis, no second process, no infrastructure, no `docker-compose.yml` change, no
new UI primitive, no new index on `activity_events`, and seven new environment variables all in one group.
The single runtime dependency is `nodemailer`, marked and recorded.

### E33 — Retention is pruned by the email section itself

**Decision**: `purgeEmailHistory(30)` runs at the end of `runEmailDeliveries()` and its count goes in the
heartbeat, which is where and how `runWebhookDeliveries()` prunes its own log.

**Rationale**: the spec's Assumptions say the log is "pruned by the existing housekeeping section, in the
shape the webhook log already uses" — and the shape the webhook log actually uses is a purge inside its
own section, not inside `runHousekeeping()`. Following the shape rather than the folder keeps the two logs
identical in behaviour and keeps the housekeeping section's budget unchanged. The departure from the
Assumption's wording is deliberate and recorded.

### E34 — The address has exactly one shape and one home

**Decision**: a recipient address exists only as `MailMessage.to`, constructed inside
`src/server/services/email/send.ts` and `invitations/delivery.ts` and passed straight to
`mailer.send()`. It is never a parameter of the DAL, never in an outcome, never in a heartbeat summary,
never in a thrown error, and never in a `console` call. `tests/integration/email/no-secrets.test.ts`
captures `console.log`/`warn`/`error` across every failure path and asserts the address, the password, the
body, the subject and the token are absent; `secret-scan.test.ts` gains the four SMTP values, one rendered
problem email and one failing send.

**Rationale**: FR-034, SC-007 and the roadmap's secrets rule. Confining the address to one field of one
object makes the assertion checkable by reading the call sites, not by trusting discipline.
