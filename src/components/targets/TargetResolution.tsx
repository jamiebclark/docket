"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { controlStyles, hintStyles, labelStyles } from "@/components/ui/controls";
import { useAnnounce } from "@/components/ui/Announce";
import { LiveRegion } from "@/components/ui/LiveRegion";
import type { ActionResult } from "@/lib/action-result";
import type { FailureActions, RequeuePreview } from "@/server/services/failures";
import type { ResolveResult } from "@/server/services/posts";
import { RetryDialog } from "./RetryDialog";
import { cancelTargetAction, previewRequeueAction, resolveTargetAction } from "@/app/p/[projectSlug]/posts/actions";

type Kind = "cancel" | "published" | "not-published" | "retry" | null;

function announce(result: ResolveResult): string {
  if (result.status === "published") return "Marked published.";
  if (result.status === "scheduled") {
    return result.changedFromPreview
      ? `Scheduled for ${result.localTime} (the previewed slot was taken).`
      : `Scheduled for ${result.localTime}.`;
  }
  return result.reason === "no_free_slot"
    ? "No free slot was left, so it's marked failed. Retry or schedule it."
    : "Marked not published. Retry or schedule it.";
}

/** Retry, cancel and the ambiguous-resolution dialogs for one target, shared by the failures view and the post page. */
export function TargetResolution({
  slug,
  targetId,
  accountId,
  accountName,
  timeZone,
  status,
  actions,
  canSchedule,
  variant,
}: {
  slug: string;
  targetId: string;
  accountId: string;
  accountName: string;
  timeZone: string;
  status: string;
  actions: FailureActions;
  canSchedule: boolean;
  variant: "row" | "detail";
}) {
  const [open, setOpen] = useState<Kind>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [error, setError] = useState("");
  const [urlError, setUrlError] = useState("");
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<RequeuePreview | "loading" | null>(null);
  const [localMessage, setLocalMessage] = useState("");
  const ctx = useAnnounce();
  const setMessage = (text: string) => (ctx ? ctx.announce(text) : setLocalMessage(text));
  const [pending, start] = useTransition();

  if (!canSchedule) return variant === "row" ? <span className="text-sm">View only</span> : null;

  function run<T>(fn: () => Promise<ActionResult<T>>, onOk?: (data: T) => void) {
    setError("");
    setUrlError("");
    start(async () => {
      const res = await fn();
      if (res.ok) {
        setOpen(null);
        onOk?.(res.data);
      } else {
        const field = "fieldErrors" in res ? (res.fieldErrors as Record<string, string> | undefined)?.url : undefined;
        if (field) {
          setUrlError(field);
          document.getElementById(`url-${targetId}`)?.focus();
        } else setError(res.message);
      }
    });
  }
  const close = () => {
    setOpen(null);
    setError("");
    setUrlError("");
  };
  const errorLine = (
    <p role="alert" className="min-h-4 text-xs text-danger">
      {error}
    </p>
  );

  function openNotPublished() {
    setOpen("not-published");
    setPreview("loading");
    start(async () => {
      const res = await previewRequeueAction(slug, { targetId });
      setPreview(res.ok ? res.data : { ok: false, code: "account_unavailable", message: res.message });
    });
  }

  const resolveNotPublished = (requeue: boolean) =>
    run(
      () =>
        resolveTargetAction(slug, {
          targetId,
          outcome: "not_published",
          requeue,
          ...(requeue && preview && preview !== "loading" && preview.ok ? { expected: preview.scheduledAt } : {}),
        }),
      (data) => setMessage(announce(data)),
    );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {ctx ? null : <LiveRegion message={localMessage} />}
      {status === "failed" && actions.canRetry ? (
        <Button onClick={() => {
            setRetryKey((k) => k + 1);
            setOpen("retry");
          }}>Retry…</Button>
      ) : null}
      {status === "failed" && actions.retryBlockedReason ? (
        <span className="text-sm">
          {actions.retryBlockedReason}{" "}
          <Link href={`/p/${slug}/accounts`} className="underline">
            Reconnect {accountName}
          </Link>
        </span>
      ) : null}
      {variant === "detail" && (status === "scheduled" || status === "draft") ? (
        <Button variant="secondary" onClick={() => setOpen("cancel")}>
          Cancel
        </Button>
      ) : null}
      {actions.canMarkPublished ? <Button onClick={() => setOpen("published")}>Mark published</Button> : null}
      {actions.canMarkNotPublished ? (
        <Button variant="secondary" onClick={openNotPublished}>
          Mark not published…
        </Button>
      ) : null}
      {error && !open ? errorLine : null}

      <RetryDialog
        key={retryKey}
        open={open === "retry"}
        onClose={close}
        onDone={() => undefined}
        slug={slug}
        targetId={targetId}
        accountId={accountId}
        accountName={accountName}
        timeZone={timeZone}
      />

      <Dialog open={open === "cancel"} onClose={close} title={`Cancel the post to ${accountName}?`}>
        <p className="text-sm">It won&apos;t be published to this account. Other accounts are not affected.</p>
        {errorLine}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Keep scheduled
          </Button>
          <Button variant="danger" pending={pending} pendingLabel="Cancelling…" onClick={() => run(() => cancelTargetAction(slug, { targetId }))}>
            Cancel post
          </Button>
        </div>
      </Dialog>

      <Dialog open={open === "published"} onClose={close} title={`Mark as published to ${accountName}?`}>
        <p className="text-sm">Confirm you saw this post on the account. It will be recorded as published.</p>
        <label className={`mt-3 block ${labelStyles}`} htmlFor={`url-${targetId}`}>
          Link to the post (optional)
          <input
            id={`url-${targetId}`}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
            aria-describedby={`url-help-${targetId}`}
            aria-invalid={urlError ? true : undefined}
            className={`${controlStyles} mt-1.5`}
          />
        </label>
        <p id={`url-help-${targetId}`} className={`mt-1 ${hintStyles}`}>
          An http or https address.
        </p>
        {urlError ? (
          <p role="alert" className="text-xs text-danger">
            {urlError}
          </p>
        ) : null}
        {errorLine}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Back
          </Button>
          <Button
            pending={pending}
            pendingLabel="Saving…"
            onClick={() => run(() => resolveTargetAction(slug, { targetId, outcome: "published", url }), (d) => setMessage(announce(d)))}
          >
            Mark as published
          </Button>
        </div>
      </Dialog>

      <Dialog open={open === "not-published"} onClose={close} title={`Mark as not published to ${accountName}?`}>
        <div aria-busy={preview === "loading"}>
          {preview === "loading" || preview === null ? (
            <p className="text-sm">Finding the next free slot…</p>
          ) : preview.ok ? (
            <p className="text-sm">
              It will go out in the next free slot for {accountName}: {preview.localTime}.
            </p>
          ) : (
            <p className="text-sm">{preview.message}</p>
          )}
        </div>
        {errorLine}
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Back
          </Button>
          {preview && preview !== "loading" && preview.ok ? (
            <>
              <Button variant="secondary" pending={pending} pendingLabel="Saving…" onClick={() => resolveNotPublished(false)}>
                Don&apos;t requeue
              </Button>
              <Button pending={pending} pendingLabel="Saving…" onClick={() => resolveNotPublished(true)}>
                Mark not published and requeue
              </Button>
            </>
          ) : preview && preview !== "loading" ? (
            <Button pending={pending} pendingLabel="Saving…" onClick={() => resolveNotPublished(false)}>
              Mark not published, don&apos;t requeue
            </Button>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}
