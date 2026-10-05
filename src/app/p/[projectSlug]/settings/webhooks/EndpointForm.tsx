"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { ShowOnceDialog } from "@/components/ui/ShowOnceDialog";
import { createEndpointAction, updateEndpointAction } from "./actions";
import { EVENT_LABELS, type EndpointDto } from "./dto";
import { checkStyles } from "@/components/ui/controls";

const SELECTABLE = ["post.published", "post.failed", "job.finished", "account.needs_reauth"] as const;

/** Creates an endpoint (and shows its secret once) or, with `endpoint`, edits one. */
export function EndpointForm({
  slug,
  endpoint,
  onDone,
}: {
  slug: string;
  endpoint?: EndpointDto;
  onDone: (message: string) => void;
}) {
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [insecure, setInsecure] = useState(endpoint?.url.startsWith("http:") ?? false);
  // The plaintext lives only here, until the dialog is closed.
  const [secret, setSecret] = useState<string | null>(null);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    start(async () => {
      const result = endpoint ? await updateEndpointAction(slug, endpoint.id, data) : await createEndpointAction(slug, data);
      if (result.ok) {
        setErrors({});
        setFormError(null);
        if (!endpoint && "secret" in result.data) {
          setSecret(result.data.secret);
          form.reset();
        } else {
          onDone("Saved the webhook endpoint.");
        }
        return;
      }
      const fieldErrors = result.fieldErrors ?? {};
      setErrors(fieldErrors);
      setFormError(Object.keys(fieldErrors).length === 0 ? result.message : null);
      const first = Object.keys(fieldErrors)[0];
      if (first) form.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
    });
  }

  return (
    <>
      <form onSubmit={submit} className="flex max-w-xl flex-col gap-3" aria-label={endpoint ? "Edit webhook endpoint" : "Add a webhook endpoint"}>
        <Field
          id="webhook-url"
          name="url"
          label="URL"
          type="url"
          required
          maxLength={2000}
          defaultValue={endpoint?.url}
          error={errors.url}
          onChange={(e) => setInsecure(e.currentTarget.value.trim().toLowerCase().startsWith("http:"))}
        />
        {insecure ? (
          <p className="text-xs text-warning">
            This address is not encrypted (http). Use https unless the receiver is on your own network.
          </p>
        ) : null}
        <Field
          id="webhook-description"
          name="description"
          label="Description"
          hint="Optional."
          maxLength={200}
          defaultValue={endpoint?.description}
          error={errors.description}
        />
        <fieldset className="flex flex-col gap-2" aria-describedby="webhook-events-error">
          <legend className="text-sm font-medium">Events</legend>
          {SELECTABLE.map((type) => (
            <label key={type} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="events"
                value={type}
                defaultChecked={endpoint ? endpoint.events.includes(type) : type !== "account.needs_reauth"} className={checkStyles} />
              {EVENT_LABELS[type]}
            </label>
          ))}
          <p id="webhook-events-error" aria-live="polite" className="min-h-4 text-xs text-danger">
            {errors.events ?? ""}
          </p>
        </fieldset>
        {formError ? (
          <p role="alert" className="text-sm text-danger">
            {formError}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button type="submit" pending={pending} pendingLabel="Saving…">
            {endpoint ? "Save changes" : "Add endpoint"}
          </Button>
        </div>
      </form>
      <ShowOnceDialog
        open={secret !== null}
        onClose={() => {
          setSecret(null);
          onDone("Added the webhook endpoint.");
        }}
        title="Copy the signing secret"
        fieldLabel="Signing secret"
        value={secret ?? ""}
        closeLabel="I have stored this secret"
      />
    </>
  );
}
