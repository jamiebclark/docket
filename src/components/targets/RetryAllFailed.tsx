"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import type { RetryAllResult } from "@/server/services/posts";
import { RetryAllDialog } from "./RetryAllDialog";
import { retryAllLabel, summaryAccounts } from "./retry-all-ui";

/** "Retry all failed" button and the summary of the last run; keyed by the page's filter so a filter change clears it. */
export function RetryAllFailed({
  slug,
  accountId,
  accountName,
  failedCount,
}: {
  slug: string;
  accountId: string | null;
  accountName: string | null;
  failedCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [dialogKey, setDialogKey] = useState(0);
  const [result, setResult] = useState<RetryAllResult | null>(null);
  const perAccount = result ? summaryAccounts(result) : [];

  return (
    <>
      {failedCount > 0 ? (
        <div className="ml-auto">
          <Button
            variant="secondary"
            onClick={() => {
              setDialogKey((k) => k + 1);
              setOpen(true);
            }}
          >
            {retryAllLabel(failedCount, accountName)}
          </Button>
          <RetryAllDialog
            key={dialogKey}
            open={open}
            onClose={() => setOpen(false)}
            onDone={setResult}
            slug={slug}
            accountId={accountId}
            accountName={accountName}
          />
        </div>
      ) : null}
      {result ? (
        <div className="basis-full">
          <Alert tone={result.changed ? "success" : "info"} role="none">
            <p>{result.message}</p>
            {perAccount.length > 0 ? (
              <ul className="mt-1 list-disc pl-5">
                {perAccount.map((a) => (
                  <li key={a.name}>{a.line}</li>
                ))}
              </ul>
            ) : null}
          </Alert>
        </div>
      ) : null}
    </>
  );
}
