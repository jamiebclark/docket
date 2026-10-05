"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { ShowOnceDialog } from "@/components/ui/ShowOnceDialog";
import { createApiKeyAction } from "./actions";

const PERMISSIONS = [
  { value: "read", label: "read", help: "See accounts, media, posts, slots and jobs." },
  { value: "write_posts", label: "write_posts", help: "Upload media, create posts, add them to the queue or schedule them." },
  { value: "generate", label: "generate", help: "Generate a post with the model." },
  { value: "manage_jobs", label: "manage_jobs", help: "Create generation jobs, add items, close, retry and cancel them." },
  {
    value: "auto_approve",
    label: "auto_approve",
    help: "Let this key skip review: posts it generates can be approved, and queued, without anyone checking them.",
    warning: true,
  },
] as const;

export function CreateKeyForm({ slug, onCreated }: { slug: string; onCreated: () => void }) {
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  // The plaintext lives only here, until the dialog is closed.
  const [secret, setSecret] = useState<string | null>(null);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    start(async () => {
      const result = await createApiKeyAction(slug, data);
      if (result.ok) {
        setErrors({});
        setFormError(null);
        setSecret(result.data.secret);
        form.reset();
        return;
      }
      const fieldErrors = result.fieldErrors ?? {};
      setErrors(fieldErrors);
      setFormError(Object.keys(fieldErrors).length === 0 ? result.message : null);
      const first = Object.keys(fieldErrors)[0];
      if (first) form.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
    });
  }

  function close() {
    setSecret(null);
    onCreated();
  }

  return (
    <>
      <form onSubmit={submit} className="flex max-w-xl flex-col gap-3" aria-label="Create an API key">
        <Field id="key-name" name="name" label="Name" hint="For example: n8n." required maxLength={64} error={errors.name} />
        <fieldset aria-describedby="key-permissions-error" className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Permissions</legend>
          {PERMISSIONS.map((p) => (
            <div key={p.value} className={`flex items-start gap-2 ${"warning" in p ? "rounded-md border border-warning-border p-2" : ""}`}>
              <input
                id={`perm-${p.value}`}
                type="checkbox"
                name="permissions"
                value={p.value}
                defaultChecked={p.value === "read"}
                aria-describedby={`perm-${p.value}-help`}
                className="mt-1"
              />
              <div className="flex flex-col">
                <label htmlFor={`perm-${p.value}`} className="font-mono text-sm">
                  {p.label}
                </label>
                <p id={`perm-${p.value}-help`} className="text-xs text-muted-foreground">
                  {"warning" in p ? "Warning: " : ""}
                  {p.help}
                </p>
              </div>
            </div>
          ))}
          <p id="key-permissions-error" aria-live="polite" className="min-h-4 text-xs text-danger">
            {errors.permissions ?? ""}
          </p>
        </fieldset>
        <Field
          id="key-rate"
          name="rateLimitPerMinute"
          label="Rate limit"
          hint="Requests per minute."
          type="number"
          min={1}
          max={1000}
          defaultValue={60}
          error={errors.rateLimitPerMinute}
        />
        <Select id="key-expiry" name="expiry" label="Expiry" defaultValue="never" error={errors.expiry}>
          <option value="never">Never</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">365 days</option>
        </Select>
        {formError ? (
          <p role="alert" className="text-sm text-danger">
            {formError}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button type="submit" pending={pending} pendingLabel="Creating…">
            Create key
          </Button>
        </div>
      </form>
      <ShowOnceDialog
        open={secret !== null}
        onClose={close}
        title="Copy your new key"
        fieldLabel="API key"
        value={secret ?? ""}
        closeLabel="I have stored this key"
      />
    </>
  );
}
