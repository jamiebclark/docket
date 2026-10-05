"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import type { CredentialField } from "@/providers/types";
import { connectCredentialsAction } from "./actions";

const initialValues = (fields: CredentialField[]) =>
  Object.fromEntries(fields.map((f) => [f.name, f.secret ? "" : (f.defaultValue ?? "")]));

/** Connects (or, with `accountId`, reconnects) an account from the fields a provider declares. Secrets never persist here. */
export function ConnectCredentialsForm({
  slug,
  providerKey,
  providerName,
  fields,
  accountId,
  submitLabel,
}: {
  slug: string;
  providerKey: string;
  providerName: string;
  fields: CredentialField[];
  accountId?: string;
  submitLabel: string;
}) {
  const idBase = `connect-${providerKey}-${accountId ?? "new"}`;
  const formRef = useRef<HTMLFormElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const [values, setValues] = useState(() => initialValues(fields));
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");
  const [failures, setFailures] = useState(0);
  const [pending, start] = useTransition();

  // After a failed submit, move focus to the first invalid field, or to the alert when no field is at fault.
  useEffect(() => {
    if (failures === 0) return;
    const invalid = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (invalid ?? alertRef.current)?.focus();
  }, [failures]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage("");
    setFieldErrors({});
    setAnnouncement("");
    const submitted = values;
    start(async () => {
      const res = await connectCredentialsAction(slug, { providerKey, fields: submitted, ...(accountId ? { accountId } : {}) });
      if (res.ok) {
        setValues(initialValues(fields));
        setAnnouncement(`Connected ${res.data.displayName}`);
        return;
      }
      // Secrets are cleared after every submit, success or failure.
      setValues((current) => ({ ...current, ...Object.fromEntries(fields.filter((f) => f.secret).map((f) => [f.name, ""])) }));
      setFieldErrors(res.fieldErrors ?? {});
      setMessage(res.message);
      setFailures((n) => n + 1);
    });
  }

  return (
    <form ref={formRef} onSubmit={submit} className="flex max-w-md flex-col gap-2" aria-label={`${submitLabel} ${providerName} account`}>
      {fields.map((field) => (
        <Field
          key={field.name}
          id={`${idBase}-${field.name}`}
          label={field.label}
          hint={field.help}
          placeholder={field.placeholder}
          value={values[field.name] ?? ""}
          onChange={(e) => setValues((current) => ({ ...current, [field.name]: e.target.value }))}
          type={field.secret ? "password" : "text"}
          autoComplete={field.secret ? "new-password" : "off"}
          spellCheck={false}
          inputMode={/url/i.test(field.name) ? "url" : undefined}
          required={!field.optional}
          aria-required={!field.optional}
          error={fieldErrors[field.name]}
        />
      ))}
      <p ref={alertRef} tabIndex={-1} role="alert" className="min-h-4 text-sm text-danger">
        {message}
      </p>
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {announcement}
      </p>
      <div>
        <Button type="submit" pending={pending} pendingLabel="Connecting…">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
