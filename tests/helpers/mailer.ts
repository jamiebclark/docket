import type { MailMessage, MailOutcome, Mailer } from "../../src/server/mail/types";

export interface RecordedMessage extends MailMessage {
  at: Date;
}

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

const DEFAULT_OUTCOME: MailOutcome = { kind: "sent", code: 250, durationMs: 1 };

export function recordingMailer(): RecordingMailer {
  let outcomes: MailOutcome[] = [];
  let throwAfter = false;
  let hangMs: number | null = null;
  const sent: RecordedMessage[] = [];

  return {
    sent,
    queue(...next) {
      outcomes.push(...next);
    },
    throwAfterAccepting() {
      throwAfter = true;
    },
    hang(ms) {
      hangMs = ms;
    },
    reset() {
      sent.length = 0;
      outcomes = [];
      throwAfter = false;
      hangMs = null;
    },
    async send(message) {
      if (hangMs !== null) {
        const ms = hangMs;
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
      sent.push({ ...message, at: new Date() });
      const outcome = outcomes.length > 1 ? outcomes.shift()! : outcomes[0] ?? DEFAULT_OUTCOME;
      if (throwAfter) {
        throwAfter = false;
        throw new Error("recordingMailer: throwAfterAccepting");
      }
      return outcome;
    },
  };
}
