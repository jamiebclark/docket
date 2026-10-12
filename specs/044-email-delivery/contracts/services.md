# Contract — Pure modules, services and wording

Everything between the mailer ([mailer.md](./mailer.md)) and the screens ([ui.md](./ui.md)).

---

## 1. `src/lib/email/schedule.ts` — pure, the whole of the clock

No database, no server, no `Date.now()`. Every wall-clock conversion goes through
`toZonedDateTime(zone, { disambiguation: "compatible" })`, the same call and the same explicit
disambiguation `src/lib/notifications/snooze.ts` already uses (N50, FR-019).

```ts
export const CADENCES = ["off", "immediate", "digest"] as const;
export type Cadence = (typeof CADENCES)[number];

export interface ScheduleSettings {
  cadence: Cadence;
  digestHour: number;            // 0-23
  timeZone: string;              // already resolved: a stored zone, a derived one, or "UTC"
  quietStartHour: number | null; // both null, or both set
  quietEndHour: number | null;
}

/** The person's zone, or the deterministic default (N48, FR-008). An unrecognised stored zone -> "UTC". */
export function resolveZone(stored: string | null, projectZones: readonly string[]): string;

/** True when `instant` falls inside the window in the person's zone. A window that wraps midnight is
 *  one comparison, not two branches. Always false when there is no window (E14). */
export function insideQuietHours(s: ScheduleSettings, instant: Date): boolean;

/** The absolute instant the current quiet window ends, resolved on that local day (N49, N50). */
export function quietWindowEnd(s: ScheduleSettings, instant: Date): Date;

/** The resolved instant of `hour` on `date` in `zone`: a skipped hour moves to the next instant that
 *  exists, a repeated hour takes the earlier offset — exactly one send per local day (N50, FR-019). */
export function atLocalHour(date: Temporal.PlainDate, hour: number, zone: string): Date;

export function isSameLocalDay(a: Date, b: Date, zone: string): boolean;

/**
 * The one answer to "when next?" (E12, FR-016 to FR-020). Never returns a past instant for a digest
 * that has already been sent today, and never skips a local day's problems.
 *
 *  off       -> throws; callers must not ask
 *  immediate -> `now`, or quietWindowEnd(s, now) when inside the window
 *  digest    -> today's resolved hour if still ahead;
 *               else `now` when nothing was sent on today's local date (a late digest, N53);
 *               else tomorrow's resolved hour
 */
export function nextDue(s: ScheduleSettings, lastSentAt: Date | null, now: Date): Date;

/** A digest claimed after its own local day has passed is skipped, not sent stale (N53, FR-017). */
export function isStaleDigest(s: ScheduleSettings, dueAt: Date, now: Date): boolean;
```

`atLocalHour` is the only place a wall hour becomes an instant, so the spring-forward and fall-back rules
are stated once and tested once for the digest hour and both ends of the quiet window.

---

## 2. `src/lib/email/render.ts` — pure, the message

```ts
export interface EmailProblem {
  outcomeLabel: string;        // OUTCOME_LABEL, as the panel uses
  occurredAt: Date;
  platforms: { key: string; name: string }[];
  accountName: string | null;
  message: string;             // the stored, already-scrubbed message
  href: string | null;         // absolute, into Activity
}

export interface EmailProjectGroup {
  name: string;                // as known at assembly (the edge case: a rename mid-flight)
  problems: EmailProblem[];
  /** How many more than `problems` there are, exactly, within EMAIL_SCAN_LIMIT (FR-011, E16). */
  overflow: number;
  overflowHref: string;        // the project's problems view
}

export interface ProblemEmailModel {
  cadence: "immediate" | "digest";
  timeZone: string;            // the person's, not a project's — this is their inbox
  groups: EmailProjectGroup[];
  unsubscribeUrl: string;
}

/** Text is authoritative; HTML renders the same content with no images and no remote content (FR-014). */
export function renderProblemEmail(m: ProblemEmailModel): { subject: string; text: string; html: string };

export interface InvitationEmailModel {
  projectName: string;
  roleLabel: string;
  inviterName: string;
  expiresAt: Date;
  timeZone: string;
  acceptUrl: string;
}

/** No unsubscribe link and no unsubscribe header: there is nothing recurring to leave (N64, FR-040). */
export function renderInvitationEmail(m: InvitationEmailModel): { subject: string; text: string; html: string };
```

Rules both renderers obey, each asserted by `render.test.ts`:

- every instant goes through `formatLocal(instant, timeZone)` — the one date format, in the **person's**
  zone; `tests/lint/date-format.test.ts` fails the build on anything else;
- no `<img>`, no `url(`, no `<link`, no `<script`, no external host other than `BETTER_AUTH_URL`;
- no colour-only meaning: every state is words;
- the HTML part is derivable from the text part's model, never hand-written separately;
- `renderProblemEmail` is empty-proof: it is never called with zero problems (FR-013 is enforced upstream,
  and the function throws if asked, so a regression fails a test rather than mailing an empty page);
- nothing in either output contains a credential, a token other than its own, or another person's data
  (FR-015, N67).

---

## 3. `src/lib/email/unsubscribe.ts` — pure over the crypto helper

```ts
export const UNSUBSCRIBE_TTL_DAYS = 60;                  // N56
const AAD = "docket-unsubscribe-v1";                     // so a token cannot be swapped for a credential

export interface UnsubscribeGrant {
  userId: string;
  /** The project a single-project message was about; null for a digest spanning several (E20). */
  projectId: string | null;
}

/** AES-256-GCM ciphertext (E19). Contains no readable identifier of any kind (FR-026). */
export function mintUnsubscribeToken(g: UnsubscribeGrant, now: Date): string;

/** `null` for every bad case: tampered, truncated, re-signed, expired, wrong AAD, rotated key (FR-029). */
export function readUnsubscribeToken(token: unknown, now: Date): UnsubscribeGrant | null;

export function unsubscribeUrl(token: string): string;        // `${BETTER_AUTH_URL}/email/unsubscribe?t=…`
export function oneClickUnsubscribeUrl(token: string): string; // `${BETTER_AUTH_URL}/api/email/unsubscribe?t=…`
```

Plaintext: `{ v: 1, u, p, x }` where `x` is the expiry in epoch seconds (E20). `readUnsubscribeToken`
returns `null` — never throws, never distinguishes — when `decryptSecret` fails for any reason, when `v`
is not 1, when the shape is wrong, or when `x <= now`. One return value for every refusal is what makes
FR-029's "reveals nothing about whether any person, project or token exists" structural.

`unsubscribe.test.ts` asserts, among the rest, that a minted token contains **no** substring of the user
id, the project id, the email address or the project slug (FR-026) — the test that would catch a future
"simplification" back to a signed payload.

---

## 4. `src/lib/email/text.ts` — every sentence

Pure, tested, and subject to the date-format lint. The sentences FR-038 requires in words:

| Key | Sentence |
|---|---|
| `onlyProblems` | "Email carries problems only — failed posts, uncertain results and accounts that need reconnecting. Successes are never emailed." |
| `followsSwitches` | "Which problems are emailed follows the notification switches you have already set for each project." |
| `offKeepsBell` | "Turning email off leaves your in-app notifications exactly as they are." |
| `digestBeatsQuiet` | "A digest is sent at the hour you choose, even if that hour is inside your quiet hours — you asked for it." |
| `immediateMeans` | "Immediate means on the next scheduler run, about every {n} seconds on this install." |
| `unavailable` | "This install has no mail server configured, so email is unavailable. Ask an owner to set one up — see the deployment guide." |
| `noProjects` | "You are not in any project yet, so there is nothing to email you about." |
| `allSwitchesOff` | "Every notification switch is off in all of your projects, so email would have nothing to send." |
| `pausedRejected` | "Email is paused because your address was rejected. Check the address on your account, then resume." |
| `pausedFailing` | "Email is paused after repeated delivery failures. Resume when you think it is fixed." |
| `zoneDerived` | "Using {zone}, the time zone your projects use. Choose your own below." |
| `zoneDerivedUtc` | "Using UTC, because your projects do not all use the same time zone. Choose your own below." |
| `zoneUnknown` | "The time zone saved on your settings is not one this server recognises, so UTC is being used. Choose another below." |

Confirmations, in the `parseSwitchChange` shape 043 established (one redirect parameter, parsed by a pure
function, an unparseable code rendering a generic confirmation rather than erroring):

| Code | Confirmation |
|---|---|
| `saved` | "Email settings saved." |
| `resumed` | "Email resumed. You will get the next due message." |
| `off` | "Email is off. You will not be emailed about problems." |
| `digest` | "Switched to one email a day at {hour} {zone}." |
| `immediate` | "Switched to immediate email." |
| `project_off` | "{Project} problems will not be emailed. Your other projects still will." |

The unsubscribe page's own wording is in [ui.md](./ui.md) §2, because every one of its sentences is a
requirement about what the page must *say* (FR-027, FR-028).

---

## 5. `src/server/services/email/` — the callers

### `index.ts` — what the screens and the unsubscribe path call

```ts
export interface MyEmailSettings {
  available: boolean;                     // getMailer() !== null (FR-002)
  transportAvailable: boolean;            // false in the NEEDS DEPENDENCY state (FR-005)
  cadence: Cadence;
  digestHour: number;
  timeZone: string;                       // resolved
  zoneSource: "chosen" | "projects" | "utc" | "unknown";
  quiet: { startHour: number; endHour: number } | null;
  paused: { at: Date; reason: "rejected" | "failing" } | null;
  last: { at: Date; outcome: string; sent: boolean } | null;
  lastSentAt: Date | null;
  projects: { slug: string; name: string; excluded: boolean }[];
  immediateIntervalSeconds: number;       // WORKER_INTERVAL_SECONDS, for `immediateMeans`
  anySwitchOn: boolean;                   // false -> `allSwitchesOff`
}

/** The caller's own, always. Never takes a user id (FR-010, FR-044). */
export function myEmailSettings(session: SessionLike): Promise<MyEmailSettings>;

/** Zod-validated; recomputes next_due_at in the same transaction (FR-020). */
export function saveMyEmailSettings(session: SessionLike, input: unknown): Promise<MyEmailSettings>;

/** Clears the pause and the failure count, rolls next_due_at forward (FR-023, N61). */
export function resumeMyEmail(session: SessionLike): Promise<MyEmailSettings>;

/** The unsubscribe operations. Each takes a token, never a user id (FR-029, FR-044). */
export type UnsubscribeAction =
  | { kind: "all_off" }
  | { kind: "project_off"; projectSlug: string }
  | { kind: "digest" }
  | { kind: "back_on" };

export interface UnsubscribeView {
  /** False for every refusal: tampered, truncated, expired, re-signed, rotated key, deleted person. */
  valid: boolean;
  cadence: Cadence;
  digestHour: number;
  timeZone: string;
  projects: { slug: string; name: string; excluded: boolean }[];
  /** The project the token named, when it named one and the person is still a member (E20). */
  focusSlug: string | null;
}

/** Reads only. A GET must never write (N57, FR-027). */
export function readUnsubscribe(token: unknown, now: Date): Promise<UnsubscribeView>;

/** Idempotent. Every refusal returns `{ valid: false }` having written nothing (FR-029). */
export function applyUnsubscribe(token: unknown, action: UnsubscribeAction, now: Date): Promise<UnsubscribeView>;
```

The Zod schema for `saveMyEmailSettings`:

```ts
const emailSettingsSchema = z.object({
  cadence: z.enum(CADENCES),
  digestHour: z.coerce.number().int().min(0).max(23),
  timeZone: timeZoneSchema,                       // src/lib/validation/timezone.ts, unchanged
  quietStartHour: z.coerce.number().int().min(0).max(23).nullable(),
  quietEndHour: z.coerce.number().int().min(0).max(23).nullable(),
}).transform((v) => {
  // Both or neither, and an empty window is no window (E14, the spec's edge case).
  const pair = v.quietStartHour !== null && v.quietEndHour !== null && v.quietStartHour !== v.quietEndHour;
  return { ...v, quietStartHour: pair ? v.quietStartHour : null, quietEndHour: pair ? v.quietEndHour : null };
});
```

**The order a bad request is refused in** (Q21's rule, extended):

1. no session → `redirect("/login?next=/notifications")` — before any validation, so an unauthenticated
   request never learns whether email is even configured;
2. an API key instead of a session → the same, because these paths resolve a session and nothing else, and
   there is no public-API operation to reach (FR-035, FR-044, US8 §7);
3. `getMailer() === null` → `saveMyEmailSettings` refuses with `unavailable` rather than storing a cadence
   that cannot run (FR-002);
4. Zod → field errors next to the fields;
5. the per-project unsubscribe resolves the caller's **own** project set first, so a foreign project and a
   non-existent one give the same answer (FR-044, N41's shape).

### `assemble.ts`

```ts
export interface AssembledMessage {
  model: ProblemEmailModel;
  problemCount: number;
  /** One per project with anything in it: what `markInFlight` writes (data-model.md §5 step 4). */
  highWater: { projectId: string; maxSeq: bigint }[];
}

/**
 * One person, at this instant, through the one eligibility rule (FR-009, FR-011, FR-012).
 * `null` when nothing is eligible — the caller then sends nothing and moves no position (N52, FR-013).
 * Reads only; runs inside the scheduler's named cross-project section (FR-043).
 */
export function assembleForPerson(input: {
  userId: string;
  cadence: "immediate" | "digest";
  zone: string;
  now: Date;
  token: string;          // the lease, for the url-minting grant's project scope
}): Promise<AssembledMessage | null>;
```

Per project of the person's, skipping excluded ones:
`minSeq = max(plan threshold, seen_seq, mailed_seq)`, `exclude: "hidden"`, `listAttentionForEmail` for up
to `EMAIL_LIST_LIMIT` rows and `countAttentionForEmail` for the exact overflow and the high-water
(data-model.md §6.2). Projects are ordered by name, problems newest first. The unsubscribe token is
minted with `projectId` set only when exactly one project contributed (E20).

### `send.ts`

```ts
export interface SendResult {
  outcome: EmailAttemptOutcome;
  problemCount: number;
  /** What the tick counts; `skipped` covers a stale digest, an empty assembly and a lost lease. */
  disposition: "sent" | "retry" | "paused" | "skipped" | "unavailable";
}

/** data-model.md §5, steps 2 to 6. Shared by the tick and by every integration test (E9). */
export function sendForClaimedPerson(input: {
  claim: ClaimedPerson;
  mailer: Mailer;
  cfg: EmailConfig;
  now: Date;
}): Promise<SendResult>;
```

Holding no transaction across the `mailer.send()` call is a property of this function, and
`tests/integration/email/no-double-send.test.ts` asserts it by failing the mailer with a hook that opens a
second connection and writes — which would deadlock if a transaction were held (FR-024).

---

## 6. `src/server/scheduler/email.ts`

```ts
export interface EmailCounts {
  recovered: number;   // leases reclaimed, each treated as sent (E10)
  claimed: number;
  sent: number;
  retried: number;
  paused: number;
  skipped: number;     // stale digests, empty assemblies, deadline-released claims
  unavailable: number;
  purged: number;
}

export const emptyEmailCounts = (): EmailCounts => ({ /* all zero */ });

export function runEmailDeliveries(opts: {
  config: SchedulerConfig; tickId: string; startedAt: Date;
}): Promise<EmailCounts>;
```

Shape, following `runWebhookDeliveries()` line for line:

1. `const mailer = getMailer(); if (!mailer) return emptyEmailCounts();` — **the first statement** (E18,
   SC-006);
2. `recoverEmailClaims()`;
3. `claimDuePeople({ limit: cfg.maxPerTick, leaseSeconds, now })`;
4. a worker pool of `cfg.concurrency` over the claimed queue; each worker, per person: if
   `deadline - now < cfg.minWindowMs`, `releaseClaim()` and count `skipped`; otherwise
   `sendForClaimedPerson()` inside a `try/catch` that logs only a message, never an address;
5. `purgeEmailHistory(cfg.retentionDays)`;
6. `writeHeartbeat("email", now, { ...counts })` — counts only, no identifiers, no addresses (FR-034).

`runTick()` adds it to the existing `Promise.all` and `TickSummary` gains
`email: SectionResult<EmailCounts>`. Each section already catches its own failure, so an email failure
cannot delay or fail publishing, token refresh, generation, webhooks or housekeeping (FR-024).

`EMAIL_DEFAULTS` and `emailConfig(config)` go in `scheduler/config.ts` beside `WEBHOOK_DEFAULTS` and
`webhookConfig()`, with the values fixed in research E17. No new environment variable.

---

## 7. Invitations

`src/server/services/invitations/delivery.ts`:

```ts
export type InvitationEmail = "sent" | "failed" | "unavailable";

export type InvitationDeliveryResult =
  | { kind: "in_app"; email: InvitationEmail }
  | { kind: "manual_link"; url: string; expiresAt: Date; email: InvitationEmail };

/**
 * In-app for people who already have an account, otherwise a link the inviter copies — unchanged (N65).
 * Additionally emailed whenever a mailer exists (N64, FR-040): transactional, so no cadence, no quiet
 * hours, no preferences, no unsubscribe link and no unsubscribe header.
 */
export const defaultInvitationDelivery: InvitationDelivery;
```

| Mail | Invitee has an account | Result | Attempt row |
|---|---|---|---|
| not configured | yes | `in_app`, `email: "unavailable"` | none |
| not configured | no | `manual_link`, `email: "unavailable"` | none |
| configured, accepted | yes | `in_app`, `email: "sent"` | `purpose: "invitation"`, `sent` |
| configured, accepted | no | `manual_link`, `email: "sent"` | `purpose: "invitation"`, `sent` |
| configured, failed or unavailable | yes | `in_app`, `email: "failed"` | the classified outcome |
| configured, failed or unavailable | no | `manual_link`, `email: "failed"` | the classified outcome |

Nine combinations with "accepted / temporary failure / permanent rejection" × "has account / does not",
all in `tests/integration/email/invitations.test.ts` (US7's Independent Test).

`deliverAfterCommit()` in `invitations/index.ts` keeps its name and its position — after commit, outside
any transaction. Its `catch` no longer turns a delivery problem into `ConflictError`: the mailer never
throws, a failed send is a value, and FR-042 forbids rolling the invitation back. The `catch` remains only
for programmer errors (E26).

The attempt row for an invitee with no Docket account carries `user_id = NULL` (E24) — there is no person
to reference and FR-033 forbids storing the address.

Regeneration mails the new link when mail is configured, and the old link stops working exactly as today
(FR-041, US7 §7). Tokens, hashing, single use and `INVITATION_TTL_DAYS` are untouched.
