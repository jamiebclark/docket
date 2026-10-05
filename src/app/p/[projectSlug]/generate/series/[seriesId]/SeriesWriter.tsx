"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { writeSeriesPostAction } from "../../actions";
import { progressLabel, writeInOrder, type Angle, type Slot } from "../../series-logic";

export interface SeriesWriterProps {
  slug: string;
  seriesId: string;
  angles: Angle[];
  /** One per angle: already written, failed earlier, or still to do. */
  initialSlots: Slot[];
}

export function SeriesWriter({ slug, seriesId, angles, initialSlots }: SeriesWriterProps) {
  const [slots, setSlots] = useState<Slot[]>(initialSlots);
  const running = useRef(false);

  const write = (position: number) => writeSeriesPostAction(slug, { seriesId, position });
  const setSlot = (position: number, slot: Slot) => setSlots((all) => all.map((s, i) => (i === position ? slot : s)));

  async function run(positions: number[]) {
    if (running.current) return;
    running.current = true;
    try {
      await writeInOrder(positions, write, setSlot);
    } finally {
      running.current = false;
    }
  }

  useEffect(() => {
    const todo = initialSlots.flatMap((s, i) => (s.state === "pending" ? [i] : []));
    if (todo.length > 0) void run(todo);
    // Runs once on arrival; later writes come from "Try again".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const label = progressLabel(slots);
  return (
    <section aria-labelledby="series-progress" className="flex max-w-2xl flex-col gap-4">
      <h2 id="series-progress" className="text-lg font-semibold">
        {label}
      </h2>
      <LiveRegion message={label} />
      <ol className="flex flex-col gap-3">
        {angles.map((angle, i) => {
          const slot = slots[i]!;
          return (
            <li key={i} className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-3 text-sm">
              <p className="font-medium">
                {i + 1}. {angle.title}
              </p>
              {slot.state === "done" ? (
                <Link href={`/p/${slug}/generate/result/${slot.postId}`} className="underline">
                  View post {i + 1}
                </Link>
              ) : slot.state === "failed" ? (
                <div role="alert" className="flex flex-col items-start gap-2">
                  <p>Error: {slot.message}</p>
                  <Button variant="secondary" onClick={() => void run([i])}>
                    Try again
                  </Button>
                </div>
              ) : (
                <p className="text-muted-foreground">{slot.state === "writing" ? "Writing…" : "Waiting"}</p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
