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
    <form onSubmit={submit} className="flex flex-wrap items-start gap-3" aria-label="Connect a mock account">
      <Field id="mock-name" label="Mock account name" value={name} onChange={(e) => setName(e.target.value)} required error={error} />
      <Button type="submit" pending={pending} pendingLabel="Connecting…" className="mt-6">
        Connect mock account
      </Button>
    </form>
  );
}
