"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { mockBehaviours } from "@/providers/mock/settings";
import { addSlotAction, deleteSlotAction, reconnectMockAction, setMockBehaviourAction, setSlotPausedAction } from "./actions";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { ChoiceField } from "@/components/ui/ChoiceField";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Add-slot form: weekday buttons plus a 24-hour time input. A duplicate comes back as a field error. */
export function SlotEditor({ slug, accountId }: { slug: string; accountId: string }) {
  const [weekday, setWeekday] = useState("1");
  const [time, setTime] = useState("09:00");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    start(async () => {
      const res = await addSlotAction(slug, { accountId, weekday: Number(weekday), localTime: time });
      if (!res.ok) setError(res.fieldErrors?.localTime ?? res.message);
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Add a posting slot">
      <SegmentedControl
        name={`slot-day-${accountId}`}
        label="Weekday"
        value={weekday}
        onChange={setWeekday}
        options={DAYS.map((d, i) => ({ value: String(i + 1), label: d }))}
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-40">
          <Field id={`slot-time-${accountId}`} type="time" label="Time" value={time} onChange={(e) => setTime(e.target.value)} required error={error} />
        </div>
        <Button type="submit" pending={pending} pendingLabel="Adding…" className="mb-5">
          Add slot
        </Button>
      </div>
    </form>
  );
}

/** Pause/resume, and delete behind a confirm step. */
export function SlotRowActions({ slug, id, paused, label }: { slug: string; id: string; paused: boolean; label: string }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  function run(fn: () => ReturnType<typeof deleteSlotAction>) {
    setError("");
    start(async () => {
      const res = await fn();
      if (!res.ok) setError(res.message);
      else setConfirming(false);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" disabled={pending} onClick={() => run(() => setSlotPausedAction(slug, { id, paused: !paused }))}>
        {paused ? "Resume" : "Pause"}
        <span className="sr-only"> {label}</span>
      </Button>
      {confirming ? (
        <>
          <Button variant="danger" pending={pending} pendingLabel="Deleting…" onClick={() => run(() => deleteSlotAction(slug, { id }))}>
            Confirm delete {label}
          </Button>
          <Button variant="secondary" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <Button variant="danger" onClick={() => setConfirming(true)}>
          Delete<span className="sr-only"> {label}</span>
        </Button>
      )}
      <span role="alert" className="text-xs text-danger">
        {error}
      </span>
    </div>
  );
}

export function ReconnectMockButton({ slug, id }: { slug: string; id: string }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  return (
    <div>
      <Button
        pending={pending}
        pendingLabel="Reconnecting…"
        onClick={() =>
          start(async () => {
            const res = await reconnectMockAction(slug, { id });
            setError(res.ok ? "" : res.message);
            if (res.ok) router.push(res.data.landing);
          })
        }
      >
        Reconnect
      </Button>
      <p role="alert" className="min-h-4 text-xs text-danger">
        {error}
      </p>
    </div>
  );
}

export function MockBehaviourForm({ slug, id, behaviour }: { slug: string; id: string; behaviour: string }) {
  const [value, setValue] = useState(behaviour);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const res = await setMockBehaviourAction(slug, { id, settings: { behaviour: value } });
          setError(res.ok ? "" : res.message);
        });
      }}
    >
      <div className="w-56">
        <ChoiceField
          id={`behaviour-${id}`}
          name="behaviour"
          label="Mock behaviour"
          value={value}
          onChange={setValue}
          error={error}
          options={mockBehaviours.map((b) => ({ value: b, label: b.replaceAll("_", " ") }))}
        />
      </div>
      <Button type="submit" variant="secondary" pending={pending} pendingLabel="Saving…" className="mb-5">
        Change behaviour
      </Button>
    </form>
  );
}
