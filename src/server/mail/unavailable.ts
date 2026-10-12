import type { Mailer } from "./types";

/** The mailer used when email is not configured, or configured but unavailable (FR-005, E3). */
export const unavailableMailer: Mailer = {
  async send() {
    return { kind: "unavailable" };
  },
};
