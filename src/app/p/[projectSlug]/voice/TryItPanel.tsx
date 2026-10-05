"use client";

import { useId, useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { LiveRegion } from "@/components/ui/LiveRegion";
import type { TryItResult } from "@/server/services/voice";
import { GROUP_LIMIT, groupLimitMessage, groupTargets } from "@/lib/generation/groups";
import { tryVoiceAction } from "./actions";
import type { AccountOption } from "./VoiceEditor";
import { checkStyles, controlStyles } from "@/components/ui/controls";

/** Accounts in list order, as many as fit in one generation. */
function defaultSelection(accounts: AccountOption[]): string[] {
  const picked: AccountOption[] = [];
  for (const a of accounts) {
    if (groupTargets([...picked, a]).length <= GROUP_LIMIT) picked.push(a);
  }
  return picked.map((a) => a.id);
}

export interface TryItPanelProps {
  slug: string;
  canManage: boolean;
  /** The saved current version; what editors try. */
  versionId: string;
  /** The unsaved form content; what owners and admins try. */
  draft: () => unknown;
  accounts: AccountOption[];
  /** Starting state for server rendering and tests. */
  initial?: { result?: TryItResult };
}

export function TryItPanel({ slug, canManage, versionId, draft, accounts, initial }: TryItPanelProps) {
  const uid = useId();
  const [chosen, setChosen] = useState<string[]>(() => defaultSelection(accounts));
  const [brief, setBrief] = useState("");
  const [result, setResult] = useState<TryItResult | null>(initial?.result ?? null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const groupCount = groupTargets(accounts.filter((a) => chosen.includes(a.id))).length;
  const overLimit = groupCount > GROUP_LIMIT;

  function run() {
    setError("");
    start(async () => {
      const r = await tryVoiceAction(slug, {
        brief,
        accountIds: accounts.filter((a) => chosen.includes(a.id)).map((a) => a.id),
        versionId,
        ...(canManage ? { draft: draft() } : {}),
      });
      if (r.ok) setResult(r.data);
      else {
        setResult(null);
        setError(r.message);
      }
    });
  }

  return (
    <section aria-labelledby={`${uid}-h`} className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 shadow-card">
      <h2 id={`${uid}-h`} className="text-lg font-semibold">
        Try it
      </h2>
      <p className="text-xs text-muted-foreground">Samples are not saved.</p>
      {accounts.length === 0 ? (
        <EmptyState
          message="Connect an account to try this voice."
          action={
            <Link href={`/p/${slug}/accounts`} className="text-sm underline">
              Go to Accounts
            </Link>
          }
        />
      ) : (
        <fieldset className="flex flex-wrap gap-4">
          <legend className="mb-1 text-sm font-medium">Accounts</legend>
          {accounts.map((a) => (
            <label key={a.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={chosen.includes(a.id)}
                onChange={(e) => setChosen((c) => (e.target.checked ? [...c, a.id] : c.filter((id) => id !== a.id)))}
                className={checkStyles}
              />
              {a.displayName} ({a.providerName})
            </label>
          ))}
        </fieldset>
      )}
      {overLimit ? (
        <p role="alert" className="text-sm text-danger">
          {groupLimitMessage(groupCount)}
        </p>
      ) : null}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${uid}-brief`} className="text-sm font-medium">
          Brief
        </label>
        <textarea
          id={`${uid}-brief`}
          rows={3}
          required
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          className={controlStyles}
        />
      </div>
      <div>
        <Button pending={pending} pendingLabel="Trying…" disabled={pending || chosen.length === 0 || overLimit || brief.trim() === ""} onClick={run}>
          Try it
        </Button>
      </div>
      {error ? (
        <p role="alert" className="rounded-md border border-danger-border p-3 text-sm">
          Error: {error}
        </p>
      ) : null}
      <LiveRegion message={pending ? "Trying…" : result ? "Samples ready" : ""} />
      {result ? (
        <div className="flex flex-col gap-3">
          {result.variants.map((v) => (
            <article key={v.key} aria-label={`${v.providerName}: ${v.accountNames.join(", ")} sample`} className="rounded-lg border border-border bg-surface p-3 text-sm">
              <h3 className="font-medium">
                {v.providerName}: {v.accountNames.join(", ")}
              </h3>
              <p className="mt-1 whitespace-pre-wrap">{v.text}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {v.count} / {v.limit} ({v.countingRule})
              </p>
              {v.issues.length > 0 ? (
                <ul className="mt-1 list-disc pl-5 text-xs text-warning">
                  {v.issues.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
          <p className="text-xs text-muted-foreground">Took {(result.latencyMs / 1000).toFixed(1)} s.</p>
        </div>
      ) : null}
    </section>
  );
}
