# Phase 1 — Data model: Email delivery

Three new tables, one migration (`0022`), **no change to any existing table**. Everything here is in
`src/server/db/schema/email.ts` unless stated otherwise.

---

## 1. `email_settings` — one sparse row per person

One row per person, created only by their first save or by a one-click unsubscribe (E6). **Absence means
email is off** (N45, FR-007), which is why no migration writes a row.

| Column | Type | Notes |
|---|---|---|
| `user_id` | `uuid` PK | FK `user.id ON DELETE CASCADE` |
| `cadence` | `text NOT NULL DEFAULT 'off'` | `off` \| `immediate` \| `digest` (N47) |
| `digest_hour` | `smallint NOT NULL DEFAULT 7` | 0–23; kept across cadence changes so switching back restores the hour |
| `time_zone` | `text NULL` | NULL = not chosen; the derived default applies (N48, E27) |
| `quiet_start_hour` | `smallint NULL` | 0–23 |
| `quiet_end_hour` | `smallint NULL` | 0–23; `start > end` wraps midnight (E14) |
| `next_due_at` | `timestamptz NULL` | the absolute resolved due instant; NULL iff `cadence = 'off'` (N50, E11) |
| `lease_owner` | `uuid NULL` | the claiming tick's token |
| `lease_until` | `timestamptz NULL` | |
| `consecutive_failures` | `integer NOT NULL DEFAULT 0` | reset to 0 by a send and by a resume |
| `paused_at` | `timestamptz NULL` | |
| `paused_reason` | `text NULL` | `rejected` \| `failing` (N61) |
| `last_attempt_at` | `timestamptz NULL` | what FR-035 shows the person |
| `last_outcome` | `text NULL` | the outcome class of the last attempt |
| `last_sent_at` | `timestamptz NULL` | the last **successful** send; `nextDue()`'s third argument (E12) |
| `created_at`, `updated_at` | `timestamptz NOT NULL` | house defaults |

**Checks**

```
email_settings_cadence         cadence IN ('off','immediate','digest')
email_settings_digest_hour     digest_hour BETWEEN 0 AND 23
email_settings_quiet_pair      (quiet_start_hour IS NULL) = (quiet_end_hour IS NULL)
email_settings_quiet_start     quiet_start_hour IS NULL OR quiet_start_hour BETWEEN 0 AND 23
email_settings_quiet_end       quiet_end_hour   IS NULL OR quiet_end_hour   BETWEEN 0 AND 23
email_settings_lease_pair      (lease_owner IS NULL) = (lease_until IS NULL)
email_settings_pause_pair      (paused_at IS NULL) = (paused_reason IS NULL)
email_settings_pause_reason    paused_reason IS NULL OR paused_reason IN ('rejected','failing')
email_settings_due_when_on     (cadence = 'off') = (next_due_at IS NULL)
email_settings_failures_nonneg consecutive_failures >= 0
email_settings_outcome         last_outcome IS NULL OR last_outcome IN
                                 ('sent','unavailable','refused','rejected','timed_out',
                                  'connect_failed','tls_failed','internal')
```

**Index** — the claim index, the webhook claim index's shape (E11):

```sql
CREATE INDEX email_settings_due_idx ON email_settings (next_due_at)
  WHERE cadence <> 'off' AND paused_at IS NULL AND lease_owner IS NULL;
```

`quiet_start_hour = quiet_end_hour` never reaches the table: the Zod boundary normalises it to
`(NULL, NULL)` (E14), so the resolver has one representation of "no window".

**Not project-owned.** It carries no project column, by design (N46): what may be mailed is the
per-project rule; *whether and when* mail leaves the building is account-wide.

---

## 2. `email_project_state` — one row per person per project

The forward-only mailed-through position, the per-project exclusion and the in-flight high-water, in one
row (E8). **Absence means (nothing mailed, not excluded)** — the neutral default for both.

| Column | Type | Notes |
|---|---|---|
| `project_id` | `uuid NOT NULL` | part of the PK |
| `user_id` | `uuid NOT NULL` | part of the PK |
| `mailed_seq` | `bigint NOT NULL DEFAULT 0` | forward-only; at or below it is never mailed again (N55, FR-021) |
| `excluded` | `boolean NOT NULL DEFAULT false` | the per-project unsubscribe (N59, FR-028) |
| `sending_seq` | `bigint NULL` | the high-water of the message in flight, written under the lease (E9) |
| `created_at`, `updated_at` | `timestamptz NOT NULL` | house defaults |

**Keys and checks**

```
PK                                 (project_id, user_id)
email_project_state_member_fk      (project_id, user_id) -> member(organization_id, user_id) ON DELETE CASCADE
email_project_state_mailed_nonneg  mailed_seq >= 0
email_project_state_sending_fwd    sending_seq IS NULL OR sending_seq >= mailed_seq
```

The composite FK to `member` is R1/M1/Q1's shape: FR-025's "deleted with the membership, in the same
transaction, and with the project or the user" is the database's job. Removing a member, leaving, deleting
the project and deleting the user each cascade the row away, taking the pending `sending_seq` with it.

**Registered as project-owned** — one line in `src/server/db/project-owned.ts`:

```ts
{ table: "email_project_state", scopeColumn: "project_id" },
```

so the harness fails any statement that touches it without a project pin.

No index beyond the PK: every read is `(project_id, user_id)` or a scan of one person's rows, which the PK
serves in either order via its own index plus the `user_id` filter — the same access pattern
`notification_states` has today.

---

## 3. `email_delivery_attempts` — the append-only log

One row per attempt (N60, FR-032). No body, no subject, no address, **no excerpt column at all**, no
project column (E24).

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK `DEFAULT gen_random_uuid()` | |
| `user_id` | `uuid NULL` | FK `user.id ON DELETE CASCADE`; NULL for an invitation to an address with no account |
| `at` | `timestamptz NOT NULL DEFAULT now()` | |
| `purpose` | `text NOT NULL` | `problems` \| `invitation` |
| `cadence` | `text NULL` | `immediate` \| `digest`; NULL for an invitation |
| `problem_count` | `integer NOT NULL DEFAULT 0` | how many problems the message covered |
| `outcome` | `text NOT NULL` | the eight classes below |
| `smtp_code` | `smallint NULL` | the numeric code when the conversation produced one |
| `duration_ms` | `integer NOT NULL` | |

**Checks**

```
email_delivery_attempts_purpose   purpose IN ('problems','invitation')
email_delivery_attempts_cadence   cadence IS NULL OR cadence IN ('immediate','digest')
email_delivery_attempts_outcome   outcome IN ('sent','unavailable','refused','rejected','timed_out',
                                              'connect_failed','tls_failed','internal')
email_delivery_attempts_cadence_purpose
                                  (purpose = 'problems') = (cadence IS NOT NULL)
email_delivery_attempts_count_nonneg  problem_count >= 0
email_delivery_attempts_duration_nonneg duration_ms >= 0
```

**Index**

```sql
CREATE INDEX email_delivery_attempts_user_idx ON email_delivery_attempts (user_id, at DESC);
CREATE INDEX email_delivery_attempts_purge_idx ON email_delivery_attempts (at);
```

**The outcome classes** (FR-033's list, plus `sent`):

| Class | Means | Consequence |
|---|---|---|
| `sent` | the server accepted the message | `mailed_seq` advances; failures reset to 0 |
| `unavailable` | the group is configured, the transport is not (FR-005) | nothing advances; `next_due_at += 1 h` |
| `refused` | a temporary refusal during the conversation | backoff; counts toward the pause threshold |
| `rejected` | a permanent rejection of the address | **pause at once**, reason `rejected` (N61) |
| `timed_out` | no answer inside the timeout | backoff; counts toward the threshold |
| `connect_failed` | could not reach the server | backoff; counts toward the threshold |
| `tls_failed` | transport security failed | backoff; counts toward the threshold |
| `internal` | Docket's own fault, including a recovered lease | nothing advances except via E10 |

The server's reply text is **classified and discarded** — there is no column for it, because a refusal
routinely quotes the recipient address (N60, the one deliberate departure from the webhook log).

---

## 4. Invariants

1. **Absence is off.** No `email_settings` row ⇒ `cadence = 'off'` ⇒ nothing is ever assembled, claimed or
   sent for that person (N45, FR-007).
2. **`next_due_at` is NULL exactly when the cadence is off**, enforced by `email_settings_due_when_on`.
3. **`mailed_seq` only grows.** Every write is `GREATEST(mailed_seq, …)`; no code path assigns it a
   smaller value (N55, FR-021).
4. **A `sending_seq` is never below its `mailed_seq`**, enforced by check; it is written only by the lease
   owner and is always either consumed (E9 step 5) or recovered (E10).
5. **At most one in-flight message per person**, because the lease is on the single settings row (E7). The
   edge case "due for a deferred batch and a digest at the same instant" cannot produce two messages.
6. **An unknown outcome is sent.** Any path that loses the lease with `sending_seq` set advances the
   position; no path retries it (N54, FR-022).
7. **A digest sends at most once per local day**, because `nextDue()` compares the local date of
   `last_sent_at` with the local date of `now` (E12, FR-017).
8. **A resolved instant is never recomputed.** `next_due_at` is written once per cycle and read as an
   absolute value; it is recomputed only when the settings themselves change (N50, FR-019).
9. **No empty message.** Assembly returning zero problems writes no attempt row, moves no position and
   only rolls `next_due_at` forward (N52, FR-013).
10. **Pausing never touches in-app state.** No write in this feature touches `notification_states`,
    `notification_preferences` or `notification_event_marks` (N61, FR-023, FR-030).
11. **Email adds no notion of eligibility.** The only predicate is `compileEligibility()`'s plus
    `mailed_seq` and the hidden-mark exclusion (N46, FR-009).
12. **The per-project state dies with the membership**, by FK cascade, in whatever transaction removed it
    (FR-025).
13. **No send inside a transaction.** Steps 2 and 4 of the send protocol hold no transaction (FR-024).
14. **No stored row holds an address, a credential, a body, a subject, a reply text or a token.** By
    construction: there is no column for any of them (FR-031, FR-033, FR-034).

---

## 5. The send protocol

For one claimed person. The crash column is what the *next* tick does if the process dies at that point.

```
1  CLAIM            (transaction)
     UPDATE email_settings SET lease_owner = $tok, lease_until = $now + leaseMs
      WHERE user_id IN (
        SELECT user_id FROM email_settings
         WHERE cadence <> 'off' AND paused_at IS NULL
           AND lease_owner IS NULL AND next_due_at <= $now
         ORDER BY next_due_at ASC
         LIMIT $maxPerTick
         FOR UPDATE SKIP LOCKED)
      RETURNING *
                                        crash -> lease expires; sending_seq is NULL; released, nothing sent

2  SAME-LOCAL-DAY GATE                  (no transaction, pure)
     digest whose due instant is on an earlier local day -> skip:
       no send, no attempt row, no position move; roll next_due_at forward (N53)

3  ASSEMBLE         (no transaction, reads only, inside crossProject())
     for each project the person is a member of, not excluded:
       plan   = compileEligibility(preferences)
       minSeq = max(plan threshold, notification_states.seen_seq, mailed_seq)
       items  = newest EMAIL_LIST_LIMIT eligible, marks exclude = "hidden"
       total, maxSeq = count and max over the same predicate, LIMIT EMAIL_SCAN_LIMIT
     nothing eligible anywhere -> release the lease, roll next_due_at, return (N52)
                                        crash -> as step 1

4  MARK IN FLIGHT   (transaction, lease verified)
     for each project with items:
       INSERT INTO email_project_state (project_id, user_id, sending_seq)
       VALUES (...) ON CONFLICT (project_id, user_id)
         DO UPDATE SET sending_seq = GREATEST(COALESCE(sending_seq,0), EXCLUDED.sending_seq),
                       updated_at  = now()
     lease not ours any more -> abandon, write nothing
                                        crash -> RECOVERED AS SENT (E10): mailed_seq := GREATEST(mailed_seq, sending_seq)

5  SEND             (no transaction)
     mailer.send(renderProblemEmail(model))     -- never throws (E4)
                                        crash -> as step 4

6  RECORD           (transaction, lease verified)
     INSERT INTO email_delivery_attempts (...)            -- always, whatever the outcome
     sent:        mailed_seq := GREATEST(mailed_seq, sending_seq); sending_seq := NULL
                  last_sent_at := now; last_outcome := 'sent'; consecutive_failures := 0
     rejected:    sending_seq := NULL; paused_at := now; paused_reason := 'rejected'
     unavailable: sending_seq := NULL; next_due_at := now + unavailableRetryMs
     temporary:   sending_seq := NULL; consecutive_failures += 1;
                  if >= pauseAfterFailures  -> paused_at := now; paused_reason := 'failing'
                  else next_due_at := now + min(base * 2^(n-1), max)
     always:      lease_owner := NULL; lease_until := NULL; last_attempt_at := now
     sent/skipped -> next_due_at := nextDue(settings, last_sent_at, now)
```

**Recovery**, run first each tick (E10):

```
RECOVER            (transaction)
  for each email_settings row with lease_until <= now:
    UPDATE email_project_state
       SET mailed_seq = GREATEST(mailed_seq, sending_seq), sending_seq = NULL
     WHERE user_id = $u AND sending_seq IS NOT NULL
    INSERT INTO email_delivery_attempts (user_id, purpose, cadence, outcome, ...) -- 'internal'
    UPDATE email_settings SET lease_owner = NULL, lease_until = NULL,
                              last_attempt_at = now, last_outcome = 'internal',
                              next_due_at = <rolled forward>
```

The attempt row is written only when something was in flight or the lease simply expired; either way the
person can see that an attempt happened (FR-035) without Docket claiming a send it cannot vouch for.

---

## 6. Statements that change

### 6.1 `listBranch` gains a marks mode (E15)

`src/server/dal/activity.ts`. Today:

```ts
marks: { userId: string } | null
```

becomes

```ts
marks: { userId: string; exclude: "snoozed" | "hidden" } | null
```

- `"snoozed"` — today's behaviour exactly: the finite-future anti-join filters, the
  `counts_again_at > now()` join flags `hidden_by_mark`. Every existing caller passes this and nothing
  about the panel changes.
- `"hidden"` — the filter becomes `AND hidden.event_id IS NULL`, inside the inner subquery **before**
  `LIMIT`, so the bound still holds after the exclusion (the M16 rule the existing anti-join follows).
  `hidden_by_mark` is then always false and is not selected.

### 6.2 Two new reads on the activity reader

```ts
/** One project, one person: the newest `limit` eligible attention events above `minSeq`, nothing hidden now. */
listAttentionForEmail(q: {
  projectId: string; userId: string; limit: number;
  plan: EligibilityPlan; minSeq: bigint;
}): Promise<AttentionRecord[]>;

/** The same predicate, bounded: how many there are and the highest seq among them. */
countAttentionForEmail(q: {
  projectId: string; userId: string; scanLimit: number;
  plan: EligibilityPlan; minSeq: bigint;
}): Promise<{ total: number; maxSeq: bigint | null }>;
```

Both build their branches from `listBranch` with `marks: { userId, exclude: "hidden" }`, the plan's
`memberGroups` and `connectFailed` branches, the existing `platformClauseSql`, and
`minSeq: max(groupThreshold, minSeq)` per branch. The count wraps the union in

```sql
SELECT count(*)::int AS total, max(seq::bigint) AS max_seq
  FROM (SELECT seq FROM (<branches>) AS u LIMIT $scanLimit) AS bounded
```

so the scan is bounded (E16). Every statement pins `projects.id = $projectId` and joins `member` for the
person, exactly as the existing branches do.

### 6.3 `src/server/dal/email.ts` — the new DAL

All cross-project operations run inside `runCrossProject("scheduler: …")`, the named escape hatch webhook
delivery and housekeeping already use (FR-043).

```ts
export const emailDb = (): Database => getDb();                   // the pool the section runs on

// Settings, read and written by the person's own session (one user id, no project).
readSettings(db, userId): Promise<EmailSettingsRow | null>
upsertSettings(db, userId, patch): Promise<EmailSettingsRow>       // recomputes next_due_at in the same tx
resumeEmail(db, userId): Promise<EmailSettingsRow | null>          // clears pause + failures, rolls next_due_at
lastAttempts(db, userId, limit): Promise<EmailAttemptRow[]>        // the person's own, FR-035

// The unsubscribe writes, by user id out of the decrypted token (never from input).
setCadence(db, userId, cadence, hour?): Promise<"changed" | "unchanged" | "no_person">
excludeProject(db, userId, projectId): Promise<"changed" | "unchanged" | "not_member">

// The tick.
recoverEmailClaims(db, cfg): Promise<number>
claimDuePeople(db, { limit, leaseSeconds, now }): Promise<ClaimedPerson[]>
releaseClaim(db, userId, token, nextDueAt): Promise<void>
markInFlight(db, claim, perProject: { projectId; maxSeq: bigint }[]): Promise<"ok" | "stale">
recordAttempt(db, claim, attempt, outcome, cfg): Promise<"stale" | EmailRecordResult>
purgeEmailHistory(db, retentionDays): Promise<number>

// Assembly's reads, all pinned per project inside the cross-project section.
projectsForEmail(db, userId): Promise<{ projectId, slug, name, timeZone, mailedSeq, excluded, seenSeq }[]>
```

`projectsForEmail` is one statement joining `member`, `projects`, `notification_states` and
`email_project_state` for one user id — the shape `forMyProjects` uses, without the session, because the
tick has none.

### 6.4 Nothing else changes

`notification_states`, `notification_preferences`, `notification_event_marks`, `activity_events` and
every statement in `src/server/dal/notifications.ts` are untouched. `createNotificationsSetReader` is not
used by the tick: it is built around a resolved session's project set, and the tick resolves its set from
`member` rows instead, inside the named escape hatch.

---

## 7. Migration `0022`

Three `CREATE TABLE`s with their FKs, checks and indexes. **No `UPDATE`, no `ALTER` of an existing table,
no data step at all.** Generated with `drizzle-kit`, then read line by line.

Consequences, each asserted by `tests/integration/email/email-migration.test.ts` on a database it builds
and drops itself (the `marks-migration.test.ts` pattern):

- applied to an install with existing notification rows, **0** people have email on (SC-011) — there is
  nothing to insert into, because absence is off;
- **0** reading floors, sparse marks or preference rows change — no statement names those tables;
- no operator step, and safe on a live install: three new empty tables take no lock any reader notices;
- `pnpm db:check` stays green (the snapshot and the journal agree, as Q24 established).

---

## 8. Entities, mapped to the spec's Key Entities

| Spec entity | Where it lives |
|---|---|
| **Mailer** (not stored) | `src/server/mail/types.ts` + `getMailer()` (E3, E4) |
| **Email settings** | `email_settings`, §1. Default off by absence (FR-007); deleted with the user |
| **Email exclusion** | `email_project_state.excluded`, §2. Absent means included; deleted with the membership |
| **Mailed-through position** | `email_project_state.mailed_seq`, §2. Forward-only; deleted with the membership |
| **Email send claim** | `email_settings.next_due_at` + `lease_owner` + `lease_until`, §1 (E7) |
| **Email delivery record** | `email_delivery_attempts`, §3 |
| **Unsubscribe token** (not stored) | ciphertext minted and read by `src/lib/email/unsubscribe.ts` (E19, E20) |
| In-flight high-water (new, implied by FR-022) | `email_project_state.sending_seq`, §2 (E9) |
| Activity event, notification state, event mark, notification preference, project, member, user, session, invitation, social account, platform | **unchanged in meaning and in schema** |
