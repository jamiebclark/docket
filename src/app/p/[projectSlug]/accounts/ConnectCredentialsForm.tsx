"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import type { CredentialField } from "@/providers/types";
import { connectCredentialsAction } from "./actions";

/**
 * Secrets always start empty — a stored app password exists so the server can reauthenticate
 * itself, never to be rendered back into a field. A non-secret field may be prefilled from the
 * account being reconnected when its provider asked for that, so nobody retypes a handle Docket
 * already knows.
 */
const initialValues = (fields: CredentialField[], account?: { displayName: string }) =>
  Object.fromEntries(
    fields.map((f) => {
      if (f.secret) return [f.name, ""];
      const prefill = account && f.prefillOnReconnect === "displayName" ? account.displayName : undefined;
      return [f.name, prefill ?? f.defaultValue ?? ""];
    }),
  );

/** Connects (or, with `accountId`, reconnects) an account from the fields a provider declares. Secrets never persist here. */
export function ConnectCredentialsForm({
  slug,
  providerKey,
  providerName,
  fields,
  accountId,
  account,
  submitLabel,
}: {
  slug: string;
  providerKey: string;
  providerName: string;
  fields: CredentialField[];
  accountId?: string;
  /** The account being reconnected, for fields their provider marked `prefillOnReconnect`. */
  account?: { displayName: string };
  submitLabel: string;
}) {
  const idBase = `connect-${providerKey}-${accountId ?? "new"}`;
  const formRef = useRef<HTMLFormElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const [values, setValues] = useState(() => initialValues(fields, account));
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");
  const [failures, setFailures] = useState(0);
  const router = useRouter();
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
        setValues(initialValues(fields, account));
        setAnnouncement(`Connected ${res.data.displayName}`);
        router.push(res.data.landing);
        return;
      }
      // Secrets are cleared on success (above) but kept on failure: the value is still in the field
      // either way, and wiping it means retyping a 19-character app password to correct a typo.
      setFieldErrors(res.fieldErrors ?? {});
      setMessage(res.message);
      setFailures((n) => n + 1);
    });
  }

  return (
    <form ref={formRef} onSubmit={submit} method="post" className="flex max-w-md flex-col gap-2" aria-label={`${submitLabel} ${providerName} account`}>
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
