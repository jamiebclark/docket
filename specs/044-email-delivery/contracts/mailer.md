# Contract — The mailer and its configuration

The capability contract: one interface, one all-or-none environment group, four outcomes, and one file
that cannot be finished in this entry.

---

## 1. The interface

`src/server/mail/types.ts`:

```ts
/** What a recipient needs; the only place in Docket an email address exists as a value (E34). */
export interface MailMessage {
  /** The recipient's address. Never logged, never stored, never in an error (FR-034). */
  to: string;
  subject: string;
  /** The authoritative part (FR-014). */
  text: string;
  /** A minimal alternative rendering the same content: no images, no remote content (FR-014). */
  html: string;
  /**
   * Extra headers the message carries, e.g. the one-click unsubscribe headers.
   * NEEDS RESEARCH: SMTP — the header names and their exact semantics come from
   * docs/research/smtp.md, not from memory (FR-026). The map is plumbed and tested;
   * the names are added by the task that writes that file.
   */
  headers?: Record<string, string>;
}

/** Why a temporary failure was temporary (FR-033's classification, minus the permanent cases). */
export type MailFailureReason = "refused" | "timed_out" | "connect_failed" | "tls_failed" | "internal";

export type MailOutcome =
  | { kind: "sent"; code: number | null; durationMs: number }
  | { kind: "rejected"; code: number | null; durationMs: number }   // permanent: pause at once (N61)
  | { kind: "failed"; reason: MailFailureReason; code: number | null; durationMs: number }
  | { kind: "unavailable" };                                         // configured, transport absent (FR-005)

export interface Mailer {
  /**
   * One message, one classified outcome. NEVER THROWS: an exception is the one value that carries a
   * message nobody chose, and a mail server's refusal routinely quotes the recipient address (E4).
   */
  send(message: MailMessage): Promise<MailOutcome>;
}

/** The modes SMTP_SECURITY accepts. Their meaning is NEEDS RESEARCH: SMTP (E2). */
export const SMTP_SECURITY_MODES = ["none", "starttls", "tls"] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY_MODES)[number];

export interface SmtpConfig {
  host: string;
  from: string;
  fromName: string;
  user?: string;
  password?: string;
  /** Unset means the transport's documented default (NEEDS RESEARCH: SMTP). */
  port?: number;
  security?: SmtpSecurity;
}
```

`MailOutcome` maps one-for-one onto `email_delivery_attempts.outcome`:

| Outcome | Stored class | Consequence |
|---|---|---|
| `sent` | `sent` | position advances, failure count resets |
| `rejected` | `rejected` | pause at once, reason `rejected` |
| `failed` / `refused` | `refused` | backoff, counts toward the threshold |
| `failed` / `timed_out` | `timed_out` | backoff, counts toward the threshold |
| `failed` / `connect_failed` | `connect_failed` | backoff, counts toward the threshold |
| `failed` / `tls_failed` | `tls_failed` | backoff, counts toward the threshold |
| `failed` / `internal` | `internal` | backoff, counts toward the threshold |
| `unavailable` | `unavailable` | nothing advances, one hour's backoff |

---

## 2. The capability

`src/server/mail/index.ts` — `src/server/storage/index.ts`'s shape exactly (E3):

```ts
let cached: Mailer | null | undefined;

/** Memoised per process from `getEnv().smtp`; `null` when the SMTP group is unset (FR-002). */
export function getMailer(): Mailer | null;

/** Test seam: replaces (or with `undefined` resets) the memoised mailer. */
export function setMailerForTests(mailer: Mailer | null | undefined): void;
```

Three configurations, two return values:

| `getEnv().smtp` | `createSmtpMailer()` | `getMailer()` | What a caller does |
|---|---|---|---|
| `null` (group unset) | not called | `null` | email is off: offer nothing, attempt nothing (FR-002) |
| set | a mailer | that mailer | send and classify |
| set | `null` (`NEEDS DEPENDENCY`) | `unavailableMailer` | send, get `unavailable`, record it, back off an hour (FR-005) |

`src/server/mail/unavailable.ts` is three lines: a `Mailer` whose `send()` resolves
`{ kind: "unavailable" }`. There is deliberately **no** `requireMailer()` that throws: a missing mailer is
a normal state on most installs, and FR-005 requires a recorded outcome, not an exception (E3).

`src/server/mail/smtp.ts`:

```ts
/**
 * The SMTP transport.
 *
 * NEEDS DEPENDENCY: nodemailer   — nothing in package.json or node_modules speaks SMTP, and a phase
 *                                  cannot reach the registry (decisions #19). Constitution VI forbids
 *                                  hand-rolling a client or shelling out to a mail binary (FR-005).
 * NEEDS RESEARCH: SMTP           — the default port, the default transport-security mode, how each
 *                                  SMTP_SECURITY mode maps onto the client's options, and the one-click
 *                                  unsubscribe header names (FR-026). Write docs/research/smtp.md first.
 *
 * Returning `null` is what makes the configured-but-unavailable state of FR-005 real rather than a
 * crash: `getMailer()` substitutes `unavailableMailer`, startup says so once, and no bookkeeping moves.
 * The task that installs the package replaces this function's body and nothing else in the repository.
 */
export function createSmtpMailer(config: SmtpConfig): Mailer | null {
  return null;
}
```

---

## 3. The environment group

Seven variables, one group (E1, N43, FR-001).

| Variable | Role | Validated here |
|---|---|---|
| `SMTP_HOST` | **Group** | non-empty, no whitespace |
| `SMTP_FROM` | **Group** | an email address (`emailSchema`) |
| `SMTP_USER` | credential pair | non-empty |
| `SMTP_PASSWORD` | credential pair | non-empty |
| `SMTP_PORT` | satellite | integer 1–65535; **no default here** (E2) |
| `SMTP_SECURITY` | satellite | one of `SMTP_SECURITY_MODES`; **no default here** (E2) |
| `SMTP_FROM_NAME` | satellite | 1–100 characters; defaults to `Docket` |

`smtpIssues(source)` in `src/server/env.ts`, pushed from `crossFieldIssues()` beside `storageIssues()`,
with the same three branches and the same phrasing:

```
no group member set:
  any satellite set            -> { name: <satellite>, reason: "set SMTP_HOST and SMTP_FROM to enable email" }
  SMTP_USER or SMTP_PASSWORD   -> { name: <that one>,  reason: "set SMTP_HOST and SMTP_FROM to enable email" }
  otherwise                    -> no issues; email is off

any group member set:
  each missing group member    -> { name: <member>, reason: "required when email is configured" }
  SMTP_USER without PASSWORD   -> { name: "SMTP_PASSWORD", reason: "required when SMTP_USER is set" }
  SMTP_PASSWORD without USER   -> { name: "SMTP_USER",     reason: "required when SMTP_PASSWORD is set" }
  neither credential           -> accepted; the relay is used unauthenticated (N43, US5 §4)
  SMTP_FROM not an address     -> { name: "SMTP_FROM", reason: "must be an email address" }
  SMTP_PORT out of range       -> { name: "SMTP_PORT", reason: "must be an integer from 1 to 65535" }
  SMTP_SECURITY unknown        -> { name: "SMTP_SECURITY", reason: "must be one of: none, starttls, tls" }
```

**No message carries a value** (FR-003) — the same rule and the same test the storage group already has.

`getEnv().smtp: SmtpConfig | null` comes from a `toSmtp(e)` transform beside `toStorage(e)`: `null` unless
both group members are present. `ENV_VARIABLES` picks up the seven names automatically from
`Object.keys(base.shape)`, so the env-coverage test needs no change.

### `.env.example`

One block in the house format, after the media-storage block:

```
# --- Email ---
# Problem notifications and invitations can be emailed through an SMTP relay. Leave the two Group
# variables empty to disable email entirely: nothing is sent, no setting is offered, and every screen
# says email is unavailable. Setting either Group variable requires both, and setting SMTP_USER,
# SMTP_PASSWORD or any optional SMTP_* variable without them is an error. Docket receives no mail, so a
# delivery report that arrives later at the sending address is invisible to it (see docs/deployment.md).

# Group. Mail server hostname.
# No default.
# SMTP_HOST=smtp.example.com

# Group. The address mail is sent from.
# No default.
# SMTP_FROM=docket@example.com

# Optional, both or neither. Relay credentials; leave both empty for an unauthenticated relay on a
# private network. Never logged or shown.
# No default.
# SMTP_USER=
# SMTP_PASSWORD=

# Optional. Port, 1-65535.
# Default: see docs/research/smtp.md.
# SMTP_PORT=

# Optional. Transport security: none, starttls or tls.
# Default: see docs/research/smtp.md.
# SMTP_SECURITY=

# Optional. Display name on the From header.
# Default: Docket.
# SMTP_FROM_NAME=Docket
```

### Startup

`src/server/startup/validate.ts` adds to `disabled` — one line, printed once (FR-005, US5 §1 and §6):

```ts
if (parsed.ok && !parsed.env.smtp) disabled.push("email is off (SMTP_HOST and SMTP_FROM not set)");
else if (parsed.ok && !createSmtpMailer(parsed.env.smtp)) {
  disabled.push("email is configured but unavailable (no SMTP client installed); nothing will be sent");
}
```

Neither line names a password, a host or an address — only variable names (FR-003).

---

## 4. The recording test mailer

`tests/helpers/mailer.ts`. Every behaviour in the spec except the wire transport is tested through this
(FR-004), and **no test opens a socket**.

```ts
export interface RecordedMessage extends MailMessage { at: Date }

export interface RecordingMailer extends Mailer {
  readonly sent: RecordedMessage[];
  /** Outcomes are consumed in order; the last one repeats once the queue is empty. */
  queue(...outcomes: MailOutcome[]): void;
  /** Resolve the outcome, then throw — "the mail server accepted it and then we died" (US6 §3). */
  throwAfterAccepting(): void;
  /** Never resolve before the tick's deadline (US6, "a mailer that hangs past the budget"). */
  hang(ms: number): void;
  reset(): void;
}

export function recordingMailer(): RecordingMailer;
```

Installed with `setMailerForTests(recordingMailer())` and reset in `afterEach`.
