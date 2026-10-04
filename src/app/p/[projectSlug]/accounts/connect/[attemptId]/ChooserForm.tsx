"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { chooseConnectCandidatesAction } from "../../actions";

export interface ChooserCandidate {
  key: string;
  providerName: string;
  displayName: string;
  parentKey: string | null;
  notes: string[];
  state: "new" | "connected" | "needs_reauth";
}

const BADGE: Record<ChooserCandidate["state"], { label: string; tone: "success" | "danger" } | null> = {
  new: null,
  connected: { label: "Already connected", tone: "success" },
  needs_reauth: { label: "Needs reconnecting", tone: "danger" },
};

function Option({
  c,
  checked,
  onChange,
}: {
  c: ChooserCandidate;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const badge = BADGE[c.state];
  const id = `candidate-${c.key.replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4" />
        <label htmlFor={id} className="text-sm">
          {c.displayName} <span className="text-foreground/70">({c.providerName})</span>
        </label>
        {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
      </div>
      {c.notes.map((note) => (
        <p key={note} className="ml-6 text-sm text-foreground/70">
          {note}
        </p>
      ))}
    </div>
  );
}

/** Pick which Pages and linked accounts to connect. Only candidate keys leave the browser; no secret is ever here. */
export function ChooserForm({ slug, attemptId, candidates }: { slug: string; attemptId: string; candidates: ChooserCandidate[] }) {
  const alertRef = useRef<HTMLParagraphElement>(null);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(candidates.filter((c) => c.state === "needs_reauth").map((c) => c.key)),
  );
  const [message, setMessage] = useState("");
  const [failures, setFailures] = useState(0);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (failures > 0) alertRef.current?.focus();
  }, [failures]);

  const keys = new Set(candidates.map((c) => c.key));
  const roots = candidates.filter((c) => !c.parentKey || !keys.has(c.parentKey));
  const childrenOf = (key: string) => candidates.filter((c) => c.parentKey === key);

  const toggle = (key: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage("");
    start(async () => {
      // On success the action redirects, so a result only arrives on failure.
      const res = await chooseConnectCandidatesAction(slug, { attemptId, selected: [...selected] });
      if (res && !res.ok) {
        setMessage(res.message);
        setFailures((n) => n + 1);
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-4" aria-label="Choose accounts to connect">
      {roots.map((root) => (
        <fieldset key={root.key} className="flex flex-col gap-2 rounded-lg border border-foreground/20 p-4">
          <legend className="px-1 text-sm font-semibold">{root.displayName}</legend>
          <Option c={root} checked={selected.has(root.key)} onChange={(on) => toggle(root.key, on)} />
          {childrenOf(root.key).map((child) => (
            <div key={child.key} className="ml-6">
              <Option c={child} checked={selected.has(child.key)} onChange={(on) => toggle(child.key, on)} />
            </div>
          ))}
        </fieldset>
      ))}
      <p ref={alertRef} tabIndex={-1} role="alert" className="min-h-4 text-sm text-red-700 dark:text-red-400">
        {message}
      </p>
      <div className="flex gap-2">
        <Button type="submit" pending={pending} pendingLabel="Connecting…">
          Connect
        </Button>
        <Link href={`/p/${slug}/accounts`} className="rounded-md border border-foreground/30 px-3 py-1.5 text-sm font-medium hover:bg-foreground/10">
          Cancel
        </Link>
      </div>
    </form>
  );
}
