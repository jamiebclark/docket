"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { RequirementsSummary } from "@/components/compose/RequirementsSummary";
import { MediaPicker } from "@/components/media/MediaPicker";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { LiveRegion } from "@/components/ui/LiveRegion";
import type { MediaView } from "@/server/services/media";
import { saveDraftAction } from "./actions";
import {
  counterText,
  emptyAccountsAudience,
  fetchCheck,
  groupIssues,
  isOverLimit,
  scheduleBlockedReason,
  SEVERITY_LABEL,
  type CheckResult,
} from "./composer-logic";
import { AddToQueueDialog, PublishNowDialog, ScheduleAtDialog } from "./ScheduleDialogs";
import { alertStyles } from "@/components/ui/Alert";
import { cardStyles } from "@/components/ui/Card";
import { controlStyles, labelStyles } from "@/components/ui/controls";
import { PageHeader } from "@/components/ui/PageHeader";
import { ActionBar } from "@/components/ui/ActionBar";
import { AccountPicker } from "@/components/accounts/AccountPicker";
import { ProviderIcon } from "@/components/ui/Icon";

// Each fieldset is a card. A floated legend is not drawn on the border, so it sits inside as the card title.
const section = `${cardStyles} flex min-w-0 flex-col gap-3 p-5`;
const legend = "float-left mb-1 w-full font-heading text-base font-semibold text-heading";

export interface AccountOption {
  id: string;
  displayName: string;
  providerKey: string;
  providerName: string;
  status: string;
  providerAvailable: boolean;
}

export interface ComposerInitial {
  postId: string;
  baseText: string;
  mediaIds: string[];
  targets: { accountId: string; overrideText: string | null }[];
  editable: boolean;
  reviewBlocked: boolean;
}

const DEBOUNCE_MS = 200;

/** Why an account can't be picked, or `null` when it can. */
function unavailableReason(a: AccountOption): string | null {
  if (!a.providerAvailable) return "This platform is not available.";
  if (a.status === "needs_reauth") return "Needs reconnecting.";
  return null;
}

/**
 * The compose screen. Counts, limits and issues come only from the compose-check route (the same
 * validation path scheduling uses); this component never counts text itself.
 */
export function Composer({
  slug,
  timeZone,
  accounts,
  canManageAccounts,
  canEdit,
  canSchedule,
  mediaEnabled,
  initialMedia = [],
  initial,
  initialCheck = null,
}: {
  slug: string;
  timeZone: string;
  accounts: AccountOption[];
  canManageAccounts: boolean;
  canEdit: boolean;
  canSchedule: boolean;
  mediaEnabled: boolean;
  /** Views of the images already on the post, in order. */
  initialMedia?: MediaView[];
  initial?: ComposerInitial;
  /** A check result to start from (server rendering and tests); the first edit replaces it. */
  initialCheck?: CheckResult | null;
}) {
  const router = useRouter();
  const ids = useId();
  const [postId, setPostId] = useState(initial?.postId);
  const [baseText, setBaseText] = useState(initial?.baseText ?? "");
  const [media, setMedia] = useState<MediaView[]>(initialMedia);
  const mediaIds = useMemo(() => media.map((m) => m.id), [media]);
  const [selected, setSelected] = useState<string[]>(
    initial?.targets.map((t) => t.accountId).filter((id) => accounts.some((a) => a.id === id)) ?? [],
  );
  const removedCount = initial ? initial.targets.filter((t) => !accounts.some((a) => a.id === t.accountId)).length : 0;
  const [overrides, setOverrides] = useState<Record<string, string>>(
    Object.fromEntries((initial?.targets ?? []).filter((t) => t.overrideText).map((t) => [t.accountId, t.overrideText!])),
  );
  const [lastCheck, setCheck] = useState<CheckResult | null>(initialCheck);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [nowOpen, setNowOpen] = useState(false);
  const first = useRef(true);

  // With nothing selected there is nothing to check; the last result no longer applies.
  const check = selected.length === 0 ? null : lastCheck;
  const editable = check?.editable ?? initial?.editable ?? true;
  const reviewBlocked = check?.reviewBlocked ?? initial?.reviewBlocked ?? false;
  const targets = useMemo(
    () => selected.map((accountId) => ({ accountId, overrideText: overrides[accountId] || null })),
    [selected, overrides],
  );

  useEffect(() => {
    if (first.current && initialCheck) {
      first.current = false;
      return;
    }
    first.current = false;
    if (targets.length === 0) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const result = await fetchCheck(slug, { ...(postId ? { postId } : {}), baseText, mediaIds, targets }, controller.signal);
      if (result && !controller.signal.aborted) setCheck(result);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [slug, postId, baseText, mediaIds, targets, initialCheck]);

  if (accounts.length === 0) {
    return (
      <section className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Compose</h1>
        {emptyAccountsAudience(canManageAccounts) === "manage" ? (
          <EmptyState
            message="No accounts are connected yet. Connect an account to start composing posts."
            action={
              <Link href={`/p/${slug}/accounts`} className="text-sm font-medium underline">
                Go to Accounts
              </Link>
            }
          />
        ) : (
          <EmptyState message="No accounts are connected yet. Ask an owner or admin to connect one in Accounts." />
        )}
      </section>
    );
  }

  const canSave = canEdit && editable;
  const blocked = canSchedule
    ? scheduleBlockedReason({ selected: selected.length, check, editable, reviewBlocked })
    : "You don't have permission to schedule posts.";
  const names = Object.fromEntries(accounts.map((a) => [a.id, a.displayName]));
  const byAccount = new Map(check?.targets.map((t) => [t.accountId, t]) ?? []);

  async function save(): Promise<string | null> {
    setSaving(true);
    const res = await saveDraftAction(slug, { ...(postId ? { postId } : {}), baseText, mediaIds, targets });
    setSaving(false);
    if (!res.ok) {
      setMessage(res.message);
      return null;
    }
    setMessage("Draft saved.");
    if (!postId) {
      setPostId(res.data.postId);
      router.replace(`/p/${slug}/compose/${res.data.postId}`);
    }
    return res.data.postId;
  }

  async function openQueue() {
    const id = await save();
    if (id) setQueueOpen(true);
  }

  async function openScheduleAt() {
    const id = await save();
    if (id) setScheduleOpen(true);
  }

  async function openPublishNow() {
    const id = await save();
    if (id) setNowOpen(true);
  }

  const blockedId = `${ids}-blocked`;
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <PageHeader
        title={initial ? "Edit post" : "Compose"}
        description="Write once, tailor per account, then queue, schedule or publish."
      />

      {!editable ? <p role="status" className={alertStyles("info")}>Publishing has started, so this post can no longer be edited.</p> : null}
      {removedCount > 0 ? (
        <p role="status" className={alertStyles("warning")}>
          {removedCount === 1 ? "An account this post was for has been removed" : `${removedCount} accounts this post was for have been removed`}; it will not be
          published there.
        </p>
      ) : null}
      {reviewBlocked ? <p role="status" className={alertStyles("warning")}>This post is waiting for review.</p> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          <div className={section}>
            <AccountPicker
              legend="Accounts"
              legendClassName={legend}
              idPrefix={ids}
              disabled={!canSave}
              value={selected}
              onChange={setSelected}
              accounts={accounts.map((a) => ({ ...a, unavailableReason: unavailableReason(a) }))}
            />
          </div>

          <fieldset className={section}>
            <legend className={legend}>Text</legend>
            <label htmlFor={`${ids}-text`} className={labelStyles}>
              Post text
            </label>
            <textarea
              id={`${ids}-text`}
              rows={6}
              value={baseText}
              readOnly={!canSave}
              onChange={(e) => setBaseText(e.target.value)}
              className={`${controlStyles} min-h-40 text-base leading-relaxed`}
            />
          </fieldset>

          <fieldset className={section}>
            <legend className={legend}>Media</legend>
            <MediaPicker slug={slug} enabled={mediaEnabled} canEdit={canSave} value={media} accountIds={selected} onChange={setMedia} />
          </fieldset>

          {selected.length > 0 ? (
            <fieldset className={section}>
              <legend className={legend}>Per-account text</legend>
              {selected.map((accountId) => {
                const t = byAccount.get(accountId);
                const over = t ? isOverLimit(t) : false;
                return (
                  <details key={accountId} className="rounded-lg border border-border bg-surface p-3" open={!!overrides[accountId]}>
                    <summary className="cursor-pointer text-sm font-medium">{names[accountId]}</summary>
                    <div className="mt-2 flex flex-col gap-2">
                      <label htmlFor={`${ids}-ov-${accountId}`} className="text-sm">
                        Text for {names[accountId]}
                      </label>
                      <textarea
                        id={`${ids}-ov-${accountId}`}
                        rows={4}
                        value={overrides[accountId] ?? ""}
                        readOnly={!canSave}
                        aria-invalid={over || undefined}
                        onChange={(e) => setOverrides((cur) => ({ ...cur, [accountId]: e.target.value }))}
                        className={controlStyles}
                      />
                      <div>
                        <Button
                          variant="secondary"
                          disabled={!canSave || !overrides[accountId]}
                          onClick={() => setOverrides((cur) => ({ ...cur, [accountId]: "" }))}
                        >
                          Use base text
                        </Button>
                      </div>
                    </div>
                  </details>
                );
              })}
            </fieldset>
          ) : null}
        </div>

        <fieldset className={`${section} lg:sticky lg:top-[calc(var(--sticky-top)+1.5rem)]`}>
          <legend className={legend}>Preview</legend>
          {selected.length === 0 ? <p className="text-sm text-muted-foreground">Choose an account to see what it will receive.</p> : null}
          <div aria-live="polite" className="flex flex-col gap-3">
            {selected.map((accountId) => {
              const t = byAccount.get(accountId);
              if (!t) {
                return (
                  <article key={accountId} className="rounded-lg border border-border bg-surface p-3 text-sm">
                    <h3 className="font-medium">{names[accountId]}</h3>
                    <p>Checking…</p>
                  </article>
                );
              }
              const over = isOverLimit(t);
              return (
                <article key={accountId} className="rounded-lg border border-border bg-surface p-3 text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="font-medium">
                      <span className="inline-flex items-center gap-2">
                        <ProviderIcon providerKey={accounts.find((x) => x.id === accountId)?.providerKey ?? ""} size={22} />
                        <span>
                          {t.displayName} <span className="font-normal text-muted-foreground">· {t.providerName}</span>
                        </span>
                      </span>
                    </h3>
                    <span
                      data-testid={`counter-${accountId}`}
                      className={over ? "font-semibold text-danger" : "text-muted-foreground"}
                    >
                      {counterText(t)}
                      {over ? " · over the limit" : ""}
                    </span>
                  </div>
                  <RequirementsSummary providerName={t.providerName} requirements={t.requirements} openInitially={selected.length === 1} />
                  <p className="mt-2 whitespace-pre-wrap">{t.effectiveText || <em>No text</em>}</p>
                  {media.length > 0 ? (
                    <ol className="mt-2 flex flex-col gap-1 text-xs" aria-label="Images, in order">
                      {media.map((m, n) => (
                        <li key={m.id}>
                          Image {n + 1}: {m.altText ? "has alt text" : <span className="font-medium">no alt text</span>}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {groupIssues(t.issues).map((g) => (
                    <div key={g.severity} className="mt-2">
                      <p className="text-xs font-semibold">{SEVERITY_LABEL[g.severity]}</p>
                      <ul className="list-disc pl-5">
                        {g.items.map((i, n) => (
                          <li key={`${i.code}-${n}`}>{i.message}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </article>
              );
            })}
          </div>
        </fieldset>
      </div>

      <ActionBar stickyFrom="md" message={blocked ? <span id={blockedId}>{blocked}</span> : undefined}>
        <Button type="submit" variant="secondary" pending={saving} pendingLabel="Saving…" disabled={!canSave}>
          Save draft
        </Button>
        <Button variant="secondary" disabled={!!blocked || saving} aria-describedby={blocked ? blockedId : undefined} onClick={openPublishNow}>
          Publish now…
        </Button>
        <Button variant="secondary" disabled={!!blocked || saving} aria-describedby={blocked ? blockedId : undefined} onClick={openScheduleAt}>
          Schedule…
        </Button>
        <Button variant="cta" disabled={!!blocked || saving} aria-describedby={blocked ? blockedId : undefined} onClick={openQueue}>
          Add to queue…
        </Button>
      </ActionBar>
      <LiveRegion message={message} />

      {postId ? (
        <AddToQueueDialog
          open={queueOpen}
          onClose={() => setQueueOpen(false)}
          slug={slug}
          postId={postId}
          timeZone={timeZone}
          names={names}
          onQueued={() => router.refresh()}
        />
      ) : null}
      {postId ? (
        <ScheduleAtDialog
          open={scheduleOpen}
          onClose={() => setScheduleOpen(false)}
          slug={slug}
          postId={postId}
          timeZone={timeZone}
          names={names}
          accountIds={selected}
          onScheduled={() => router.refresh()}
        />
      ) : null}
      {postId ? (
        <PublishNowDialog
          open={nowOpen}
          onClose={() => setNowOpen(false)}
          slug={slug}
          postId={postId}
          timeZone={timeZone}
          names={names}
          accountIds={selected}
          onPublished={() => router.refresh()}
        />
      ) : null}
    </form>
  );
}
