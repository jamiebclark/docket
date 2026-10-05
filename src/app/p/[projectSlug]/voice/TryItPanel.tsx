"use client";

import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { LiveRegion } from "@/components/ui/LiveRegion";
import type { TryItResult } from "@/server/services/voice";
import { tryVoiceAction } from "./actions";
import type { PlatformOption } from "./VoiceEditor";
import { checkStyles, controlStyles } from "@/components/ui/controls";

export interface TryItPanelProps {
  slug: string;
  canManage: boolean;
  /** The saved current version; what editors try. */
  versionId: string;
  /** The unsaved form content; what owners and admins try. */
  draft: () => unknown;
  platforms: PlatformOption[];
  defaults: string[];
  /** Starting state for server rendering and tests. */
  initial?: { result?: TryItResult };
}

export function TryItPanel({ slug, canManage, versionId, draft, platforms, defaults, initial }: TryItPanelProps) {
  const uid = useId();
  const [chosen, setChosen] = useState<string[]>(defaults.length > 0 ? defaults : platforms.slice(0, 1).map((p) => p.key));
  const [brief, setBrief] = useState("");
  const [result, setResult] = useState<TryItResult | null>(initial?.result ?? null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const nameOf = (key: string) => platforms.find((p) => p.key === key)?.displayName ?? key;

  function run() {
    setError("");
    start(async () => {
      const r = await tryVoiceAction(slug, {
        brief,
        providerKeys: chosen,
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
      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-1 text-sm font-medium">Platforms</legend>
        {platforms.map((p) => (
          <label key={p.key} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={chosen.includes(p.key)}
              onChange={(e) => setChosen((c) => (e.target.checked ? [...c, p.key].slice(0, 4) : c.filter((k) => k !== p.key)))} className={checkStyles} />
            {p.displayName}
          </label>
        ))}
      </fieldset>
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
        <Button pending={pending} pendingLabel="Trying…" disabled={pending || chosen.length === 0 || brief.trim() === ""} onClick={run}>
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
            <article key={v.providerKey} aria-label={`${nameOf(v.providerKey)} sample`} className="rounded-lg border border-border bg-surface p-3 text-sm">
              <h3 className="font-medium">{nameOf(v.providerKey)}</h3>
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
