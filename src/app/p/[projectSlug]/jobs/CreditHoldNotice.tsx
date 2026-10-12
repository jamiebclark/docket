import { LocalTime } from "@/components/ui/LocalTime";
import {
  CREDIT_HOLD_ACTION,
  CREDIT_HOLD_CAUSE,
  CREDIT_HOLD_RESUME,
  CREDIT_HOLD_SINCE_LABEL,
  CREDIT_HOLD_WAITING,
} from "@/lib/jobs/credit-hold";
import { JobNotice } from "./JobNotice";

/** The billing pause, named honestly, with when it started in the project's zone (FR-022). */
export function CreditHoldNotice({ since, timeZone }: { since: Date; timeZone: string }) {
  return (
    <JobNotice>
      {CREDIT_HOLD_CAUSE} {CREDIT_HOLD_SINCE_LABEL} <LocalTime value={since} timeZone={timeZone} />. {CREDIT_HOLD_WAITING}{" "}
      {CREDIT_HOLD_RESUME} {CREDIT_HOLD_ACTION}
    </JobNotice>
  );
}
