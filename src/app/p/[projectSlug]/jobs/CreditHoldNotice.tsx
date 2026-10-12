import { LocalTime } from "@/components/ui/LocalTime";
import {
  CREDIT_HOLD_ACCOUNT_PROJECT,
  CREDIT_HOLD_ACTION,
  CREDIT_HOLD_CAUSE,
  CREDIT_HOLD_RESUME,
  CREDIT_HOLD_SINCE_LABEL,
  CREDIT_HOLD_WAITING,
} from "@/lib/jobs/credit-hold";
import { JobNotice } from "./JobNotice";

/** The billing pause, named honestly, with when it started and whose account needs credit (FR-022, FR-024). */
export function CreditHoldNotice({
  since,
  timeZone,
  scope,
}: {
  since: Date;
  timeZone: string;
  scope: "project" | "install";
}) {
  const action = scope === "project" ? CREDIT_HOLD_ACCOUNT_PROJECT : CREDIT_HOLD_ACTION;
  return (
    <JobNotice>
      {CREDIT_HOLD_CAUSE} {CREDIT_HOLD_SINCE_LABEL} <LocalTime value={since} timeZone={timeZone} />. {CREDIT_HOLD_WAITING}{" "}
      {CREDIT_HOLD_RESUME} {action}
    </JobNotice>
  );
}
