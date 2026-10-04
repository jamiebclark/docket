"use client";

import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { startSeriesAction } from "./actions";
import {
  ANGLES_MAX,
  DESCRIPTION_MAX,
  TITLE_MAX,
  addAngle,
  editAngle,
  moveAngle,
  planProblem,
  removeAngle,
  type Angle,
} from "./series-logic";

export interface SeriesPlanEditorProps {
  slug: string;
  /** The brief, voice, accounts, media and policies the plan was made from; sent back with the angles. */
  request: Record<string, unknown>;
  initialAngles: Angle[];
  /** Starting state for server rendering and tests. */
  initial?: { pending?: boolean; error?: string };
}

export function SeriesPlanEditor({ slug, request, initialAngles, initial }: SeriesPlanEditorProps) {
  const uid = useId();
  const [angles, setAngles] = useState<Angle[]>(initialAngles);
  const [error, setError] = useState(initial?.error ?? "");
  const [pending, start] = useTransition();
  const busy = pending || initial?.pending === true;
  const problem = planProblem(angles);

  function submit() {
    setError("");
    start(async () => {
      const result = await startSeriesAction(slug, { ...request, angles });
      // On success the action redirects to the series page.
      if (result && !result.ok) setError(result.message);
    });
  }

  return (
    <form
      className="flex max-w-2xl flex-col gap-4"
      aria-label="Series plan"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && !problem) submit();
      }}
    >
      <h2 className="text-lg font-semibold">Plan</h2>
      <p className="text-sm text-foreground/70">Edit, reorder, remove or add angles. One post is written for each, in this order.</p>
      <ol className="flex flex-col gap-4">
        {angles.map((angle, i) => (
          <li key={i} className="flex flex-col gap-2 rounded-md border border-foreground/30 p-3">
            <label htmlFor={`${uid}-title-${i}`} className="text-sm font-medium">
              Angle {i + 1} title
            </label>
            <input
              id={`${uid}-title-${i}`}
              value={angle.title}
              maxLength={TITLE_MAX}
              onChange={(e) => setAngles((a) => editAngle(a, i, { title: e.target.value }))}
              className="rounded-md border border-foreground/40 bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
            />
            <label htmlFor={`${uid}-description-${i}`} className="text-sm font-medium">
              Angle {i + 1} description
            </label>
            <textarea
              id={`${uid}-description-${i}`}
              rows={2}
              value={angle.description}
              maxLength={DESCRIPTION_MAX}
              onChange={(e) => setAngles((a) => editAngle(a, i, { description: e.target.value }))}
              className="rounded-md border border-foreground/40 bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={i === 0 || busy} onClick={() => setAngles((a) => moveAngle(a, i, -1))}>
                Move up
              </Button>
              <Button
                variant="secondary"
                disabled={i === angles.length - 1 || busy}
                onClick={() => setAngles((a) => moveAngle(a, i, 1))}
              >
                Move down
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => setAngles((a) => removeAngle(a, i))}>
                Remove
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <div>
        <Button variant="secondary" disabled={angles.length >= ANGLES_MAX || busy} onClick={() => setAngles(addAngle)}>
          Add angle
        </Button>
      </div>
      {problem ? (
        <p role="note" className="text-sm text-red-700 dark:text-red-400">
          {problem}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          Error: {error}
        </p>
      ) : null}
      <LiveRegion message={busy ? "Starting…" : error ? `Error: ${error}` : ""} />
      <div className="flex justify-end">
        <Button type="submit" pending={busy} pendingLabel="Starting…" disabled={busy || problem !== null}>
          Write posts
        </Button>
      </div>
    </form>
  );
}
