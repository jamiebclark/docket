# Quickstart — how to run this feature and prove it works

Validation guide only: what to run, and the check that proves each user story. Implementation detail lives
in [data-model.md](./data-model.md) and [contracts/](./contracts/); task order is `tasks.md`.

## 0. Prerequisites

```bash
pnpm install                 # already installed in pipeline phases; the registry is unreachable there
docker compose up -d postgres
pnpm db:migrate              # applies 0022 (three additive tables, no data step)
pnpm dev                     # http://localhost:3000
```

Tests need a real Postgres (`DATABASE_URL`, and `DATABASE_URL_DIRECT` for the migration test, which
creates and drops its own database). **No test needs a mail server, a credential or network access**: every
behaviour goes through the recording mailer (`tests/helpers/mailer.ts`, [contracts/mailer.md](./contracts/mailer.md) §4)
and no test opens a socket.

### Running it with email off (the default, and most installs)

Set nothing. `pnpm dev` prints `Docket: email is off (SMTP_HOST and SMTP_FROM not set)` once, the
`/notifications` page says email is unavailable instead of offering a choice, and the tick's email section
returns before its first query.

### Running it with email configured

```bash
# in .env
SMTP_HOST=localhost
SMTP_FROM=docket@example.test
# SMTP_USER / SMTP_PASSWORD omitted on purpose: an unauthenticated relay is a supported deployment (N43)
```

Until `NEEDS DEPENDENCY: nodemailer` is resolved, startup prints
`Docket: email is configured but unavailable (no SMTP client installed); nothing will be sent`, the
settings card shows its warning, and every due send is recorded as `unavailable` with an hour's backoff —
nothing is lost but time (FR-005).

### The one task that is not finished here

`src/server/mail/smtp.ts` is `NEEDS DEPENDENCY: nodemailer` and `NEEDS RESEARCH: SMTP`. The session that
can install the package: writes `docs/research/smtp.md` first (the submission port and transport-security
defaults, how each `SMTP_SECURITY` mode maps onto the client's options, and the one-click unsubscribe
header names and semantics), then replaces that function's body, adds the header lines to
`MailMessage.headers`, and fills in the two `.env.example` defaults. Nothing else in the repository
changes. Per constitution II, until then the transport is reported as **not built** — not as "verified
with mocks only".

## 1. Per task

```bash
pnpm vitest run tests/integration/email/<file>.test.ts
pnpm vitest run src/lib/email/schedule.test.ts src/lib/email/render.test.ts src/lib/email/unsubscribe.test.ts
pnpm typecheck                      # when types changed
pnpm lint <changed files>
```

## 2. Once, at the end of the implement phase

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm db:check                       # the schema changed: migrations and schema must agree (FR-045)
pnpm build                          # a new route, a new page and a new server/client boundary
node scripts/check-contrast.mjs     # the settings card and the unsubscribe page are new markup
```

Never run the full suite or `pnpm build` after every task — CI runs them on every push, and the
constitution's "checks in proportion to the change" rule applies.

## 3. The checks that prove each story

| Story | Run | Passes when |
|---|---|---|
| **US1** — hear about a problem without being signed in | `assembly.test.ts`, `cadence.test.ts` | With a recording mailer, immediate email on and one failed event in a project of theirs, one tick hands over **exactly one** message addressed to them, naming the project, the account and the problem, with an Activity link and an unsubscribe link — and a second tick hands over nothing. Two problems seconds apart arrive as one message, not two. A kind-off, platform-off or all-kinds-off project contributes nothing and suppresses nothing else. A person who never turned email on is sent nothing, ever, and their bell is byte-identical. A problem read, dismissed or snoozed before the tick is not mailed; an expired snooze is. A person in several projects gets only their own, grouped by project. |
| **US2** — one email a day, at an hour I choose | `cadence.test.ts` | On a 07:00 digest in a named zone, with problems seeded through the day and ticks run every simulated minute across the whole day: **exactly one** message, at or just after 07:00 local, listing every still-eligible problem once. A day with nothing eligible sends nothing and changes no state. New problems after the morning's digest wait for tomorrow. A worker down 06:00–09:00 sends once, late, on the same local day; a worker down two days sends no stale digest and the next one contains each still-eligible problem exactly once. Switching cadence mid-day re-sends nothing and loses nothing. |
| **US3** — not at three in the morning | `quiet-hours.test.ts` | With immediate email and quiet hours 22:00–07:00 and problems at 23:00, 02:00 and 06:30 local, ticks every simulated minute hand over **nothing** before 07:00 and exactly **one** message at 07:00 containing all three. A problem read or snoozed inside the window is absent, and an otherwise-empty message is not sent. A window wrapping midnight across an offset change ends at the correct local hour, once. A digest hour inside the person's own quiet hours still sends, and the screen says so. An empty window (From = To) behaves as if none were set. |
| **US4** — stop the email from the email | `unsubscribe.test.ts`, `src/lib/email/unsubscribe.test.ts` | The link in a sent message contains no user id, no address, no project slug and no event id — asserted by substring, not by eye. Fetching it writes nothing and renders one clearly labelled submit. The submit stops every problem email, says exactly that, says the bell is untouched, and offers the digest and a way back. The per-project submit stops one named project and leaves the others. Tampered, truncated, re-signed with another key, expired, unknown, a rotated `CREDENTIALS_ENCRYPTION_KEY`, a deleted person and a left project all give the **same** page, the same status and **zero** writes. Using a valid token twice succeeds. `POST /api/email/unsubscribe` turns email off with no page and no session, and answers `204` for a bad token too. |
| **US5** — an operator turns email on; an install without it is untouched | `env-group.test.ts`, `unavailable.test.ts` | `parseEnv` over: nothing set (accepted, email off); the full group (accepted); each group member missing (reported by name); each satellite without the group (reported, pointing at the group, in the storage group's words); `SMTP_USER` without `SMTP_PASSWORD` and the reverse (reported); neither credential (accepted, unauthenticated relay). **No message contains a value.** With nothing set: no setting is offered as available, no tick work runs (asserted through the scope harness — zero statements), and every existing notification test passes unchanged. With the group set and the transport absent: one startup line, each would-be send recorded `unavailable`, **no** position advanced, `next_due_at` pushed an hour (not a tight loop), and nobody told they were emailed. Removing the configuration later keeps the stored settings and says "unavailable". |
| **US6** — never twice, and nothing lost | `no-double-send.test.ts`, `tick.test.ts` | Two ticks run concurrently against the same due person: **one** message; the other process does other work. The process is killed between each pair of steps in [data-model.md](./data-model.md) §5 — after the claim, after the high-water write, after the send — and the next tick sends that window again in **zero** of them. A mailer that resolves and then throws, and one that hangs past the budget, each produce the recorded outcome and **no** second message. A temporary failure retries with increasing delay, records each attempt and **re-assembles** the content (asserted by changing what is eligible between attempts). The threshold pauses with a visible reason; a permanent rejection pauses at once; neither touches a floor, a mark or a preference row. With the budget nearly spent the section releases its claim, leaves the rest due and the other five sections' counts are unchanged. 500 due people are all served within **10 ticks**. A member removal and a user deletion take the pending work and the position with them, in the same transaction. |
| **US7** — invitations arrive by email, and still work when they cannot | `invitations.test.ts` | All nine combinations of (invitee has an account / does not) × (no mail / mail accepting / mail failing): what was handed to the mailer, what the inviter is told, that the copyable link is still there whenever there is no account, and that the invitation record, token, hashing, single use and expiry are unchanged. The invitation email names the project, the role, the inviter and the deadline, carries **no** unsubscribe link and **no** unsubscribe header, and is sent whatever the invitee's email settings say. A failed send records an attempt with `user_id` NULL for an address with no account and does **not** roll back the invitation. Regeneration mails the new link and the old one stops working as today. Revoked, expired and used links behave exactly as today. |
| **US8** — nothing leaks | `no-secrets.test.ts`, `tests/integration/security/secret-scan.test.ts` | Every failure path — bad credentials, a refused recipient, a transport-security failure, a timeout, and a 5xx whose reply text quotes the address — run with `console.log`/`warn`/`error` captured: **zero** log lines, stored rows, returned errors or snapshots contain the configured password, the recipient address, the message body, the subject or an unsubscribe token. The attempt row holds only a classified outcome and a numeric code; the reply text is nowhere. The delivery log refers to the person by reference only. A person sees their own last outcome and nothing about anyone else. An API key is refused on every email path. The secret-scan test, extended with the four SMTP values, a rendered problem email and a failing send, is green. |

Also, as its own files:

| Area | Run | Passes when |
|---|---|---|
| DST and zones | `dst.test.ts`, `src/lib/email/schedule.test.ts` | In at least two zones with different rules, across both transitions in both directions: a digest hour that does not exist sends once at the next instant that does; an hour that happens twice sends **exactly once**, at the first occurrence; a quiet-window end in a skipped hour and in a repeated hour each resolve once. A person changing zone has `next_due_at` recomputed from the new zone with no already-sent window re-sent. An unrecognised stored zone falls back to UTC, says so on screen, and nothing throws. |
| Authorization and isolation | `authz.test.ts` | Sessions only; API keys refused; another person's settings unreachable (there is no parameter that could name one); a foreign project and a non-existent one are indistinguishable; the project-scope harness passes for every new statement, with the tick's cross-project reads inside the named section and each pinned to one project id; membership removal, project deletion and user deletion each take the right rows and no others. |
| Migration | `email-migration.test.ts` | `0022` applied to an install seeded with existing reading floors, sparse marks and preference rows: **0** people have email on, **0** floors, marks or preference rows change, no operator step, and `pnpm db:check` green. |
| The screens | `ui.test.ts` | The settings card in each of its six states (unavailable, transport unavailable, off, immediate, digest, paused); keyboard operation and tab order; accessible names that say what each control governs; the confirmation after each change; and **both** the card and the unsubscribe page rendering and submitting with no client bundle at all. |

## 4. Performance (SC-009)

```bash
pnpm vitest run tests/integration/email/tick.test.ts -t "500 due people"
```

Seeds 500 people with `cadence = 'immediate'` and a due instant in the past, each with one eligible
problem, and runs ticks with a recording mailer. Asserts: every tick finishes inside
`SCHEDULER_TICK_BUDGET_SECONDS`; the other five sections' counts are identical to a run with no email work;
**50** people are served per tick; and all 500 are served within **10 ticks** (the bound fixed in
[research.md](./research.md) E17). Also runs with `RUN_WORKER_IN_PROCESS` to prove the in-process loop
behaves identically.

## 5. By hand, last

Needs a browser and a judgement call, so it is the **final** task in `tasks.md`, after everything
automated (roadmap rule — an early human-gated task starves the implement loop).

1. With no SMTP configured: open `/notifications` and confirm the Email card says email is unavailable and
   offers no control; confirm nothing else on the page or in the shell looks different from `main`.
2. Configure the group, restart, reload: the card appears for a member, an editor and an owner alike, and
   names no variable and prints no command to anyone.
3. Choose a daily digest at the next hour, Save, and read the confirmation; tab through every control with
   the keyboard only and check the focus ring and the reading order.
4. Disable JavaScript in the browser, change the cadence and the zone, Save, and confirm both took effect
   and were confirmed in words.
5. Trigger a problem, run a tick, and read the recorded message out of the recording mailer: check it reads
   well as plain text, that the HTML part shows nothing the text does not, and that no image or remote
   resource is requested.
6. Open the unsubscribe link in a fresh private window, confirm the page writes nothing on load, press the
   primary submit, and read what it says was turned off and what was not.
7. Screenshot the Email card in the off, digest and paused states and the unsubscribe page before and
   after, at a narrow and a wide viewport, in light and dark.
