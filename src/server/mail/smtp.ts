import nodemailer from "nodemailer";
import type { Mailer, MailFailureReason, MailMessage, MailOutcome, SmtpConfig } from "./types";

/**
 * The SMTP transport, the one place in Docket that speaks to a mail server.
 *
 * Every option mapping, error code and port default below comes from `docs/research/smtp.md`, which
 * cites the Nodemailer documentation and RFC 8058. Nothing here is from memory.
 */

/** Timeouts: a tick section cannot afford to wait on a silent server (FR-024). */
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

/**
 * `SMTP_SECURITY` → transport options (research: "How SMTP_SECURITY maps onto those options").
 * Unset means nodemailer's own behaviour: plaintext connect with an opportunistic STARTTLS upgrade.
 */
function securityOptions(security: SmtpConfig["security"]) {
  switch (security) {
    case "tls":
      return { secure: true };
    case "starttls":
      return { secure: false, requireTLS: true };
    case "none":
      return { secure: false, ignoreTLS: true };
    default:
      return {};
  }
}

/** nodemailer `code` → why it was temporary (research: "Outcome classification"). */
const REASON_OF_CODE: Record<string, MailFailureReason> = {
  EAUTH: "refused",
  ETIMEDOUT: "timed_out",
  ECONNECTION: "connect_failed",
  EDNS: "connect_failed",
  ESOCKET: "connect_failed",
  ETLS: "tls_failed",
};

function fieldsOf(error: unknown): { code: string | null; responseCode: number | null } {
  if (typeof error !== "object" || error === null) return { code: null, responseCode: null };
  const e = error as { code?: unknown; responseCode?: unknown };
  return {
    code: typeof e.code === "string" ? e.code : null,
    responseCode: typeof e.responseCode === "number" ? e.responseCode : null,
  };
}

export function createSmtpMailer(config: SmtpConfig): Mailer | null {
  // `port` is left unset when the operator left it unset: nodemailer's documented default is 587, or
  // 465 when `secure` is true, and inventing a different one here would contradict the research.
  const transport = nodemailer.createTransport({
    host: config.host,
    ...(config.port === undefined ? {} : { port: config.port }),
    ...securityOptions(config.security),
    ...(config.user && config.password ? { auth: { user: config.user, pass: config.password } } : {}),
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });

  return {
    async send(message: MailMessage): Promise<MailOutcome> {
      const started = Date.now();
      try {
        const info = await transport.sendMail({
          from: { name: config.fromName, address: config.from },
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(message.headers ? { headers: message.headers } : {}),
        });
        const durationMs = Date.now() - started;
        const code = typeof info.responseCode === "number" ? info.responseCode : null;

        // A resolved promise is not yet a success: the recipient may sit in `rejected` (research).
        if (Array.isArray(info.accepted) && info.accepted.length > 0) {
          return { kind: "sent", code, durationMs };
        }
        return { kind: "rejected", code, durationMs };
      } catch (error) {
        const durationMs = Date.now() - started;
        const { code, responseCode } = fieldsOf(error);

        // 5xx will not succeed unchanged: pause at once rather than retry for ever (N61).
        if (responseCode !== null && responseCode >= 500 && responseCode < 600) {
          return { kind: "rejected", code: responseCode, durationMs };
        }
        const reason = (code === null ? undefined : REASON_OF_CODE[code]) ?? "internal";
        return { kind: "failed", reason, code: responseCode, durationMs };
      }
      // No `finally` closing the transport: it is created once per mailer and reused across sends.
    },
  };
}
