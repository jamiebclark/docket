"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { connectMockAction } from "./actions";

/** Shown only when the mock provider is enabled (the page decides). */
export function ConnectMockForm({ slug }: { slug: string }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    start(async () => {
      const res = await connectMockAction(slug, { displayName: name });
      if (res.ok) setName("");
      else setError(res.fieldErrors?.displayName ?? res.message);
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3" aria-label="Connect a mock account">
      <div className="min-w-56 flex-1">
        <Field id="mock-name" label="Mock account name" value={name} onChange={(e) => setName(e.target.value)} required error={error} />
      </div>
      <Button type="submit" pending={pending} pendingLabel="Connecting…" className="mb-5">
        Connect mock account
      </Button>
    </form>
  );
}
