"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { mockBehaviours } from "@/providers/mock/settings";
import { reconnectMockAction, setMockBehaviourAction } from "./actions";
import { ChoiceField } from "@/components/ui/ChoiceField";

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
