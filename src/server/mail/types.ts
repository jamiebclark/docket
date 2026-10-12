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
  | { kind: "rejected"; code: number | null; durationMs: number } // permanent: pause at once (N61)
  | { kind: "failed"; reason: MailFailureReason; code: number | null; durationMs: number }
  | { kind: "unavailable" }; // configured, transport absent (FR-005)

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
