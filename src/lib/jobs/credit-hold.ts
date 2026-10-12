/** The fixed wording for the credit-hold notice on the Batch jobs screens (contracts/ui.md §2). */

export const CREDIT_HOLD_CAUSE =
  "Generation is paused: the model provider refused the last request because the account has no credit or quota left.";
export const CREDIT_HOLD_WAITING =
  "Queued items are waiting — none of them has failed, and nobody needs to retry them.";
export const CREDIT_HOLD_RESUME =
  "They resume by themselves within a few minutes of credit being restored.";
export const CREDIT_HOLD_ACTION = "Add credit to the provider account.";
/** The label before the instant; the instant itself goes through LocalTime (one date format). */
export const CREDIT_HOLD_SINCE_LABEL = "Paused since";
