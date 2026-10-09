"use client";

import type { PostingFieldView } from "@/providers/types";
import type { PostingPanelView } from "@/server/services/posts/compose";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { checkStyles, controlStyles, hintStyles, labelStyles } from "@/components/ui/controls";
import { fieldDescribedBy } from "./posting-ui";

export interface PostingImage {
  id: string;
  thumbnailUrl: string;
  altText: string;
}

/** A provider's per-target posting fields, notice and consent (G25–G27). Renders only what the check returned. */
export function PostingFieldsPanel({
  idPrefix,
  panel,
  images,
  disabled,
  onChange,
  onAgree,
  onRetry,
}: {
  idPrefix: string;
  panel: PostingPanelView;
  /** Images in post order, shown when the target asks for consent so the person sees what they agree to. */
  images: readonly PostingImage[];
  disabled: boolean;
  onChange: (key: string, value: unknown) => void;
  /** Ticking stores the current fingerprint; unticking clears it. */
  onAgree: (agreed: boolean) => void;
  onRetry: () => void;
}) {
  const consentId = `${idPrefix}-consent`;
  return (
    <fieldset className="mt-3 flex flex-col gap-3 border-t border-border pt-3" disabled={disabled}>
      <legend className="text-xs font-semibold">{panel.heading ?? "Posting settings"}</legend>

      {panel.notice ? (
        <Alert tone="info">
          {panel.notice.text}
          {panel.notice.doc ? (
            <>
              {" "}
              <a href={panel.notice.doc} className="font-medium underline" target="_blank" rel="noreferrer">
                Read how TikTok&apos;s audit works
              </a>
            </>
          ) : null}
        </Alert>
      ) : null}

      {panel.details === "error" ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm font-medium text-danger">
            {panel.detailsError}
          </p>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}

      {panel.fields.map((field) => (
        <PostingField key={field.key} idPrefix={idPrefix} field={field} onChange={onChange} />
      ))}

      {panel.consent && images.length > 0 ? (
        <ol className="flex flex-wrap gap-2" aria-label="Images, in order">
          {images.map((m, n) => (
            <li key={m.id}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a media-library thumbnail, already sized by the server */}
              <img src={m.thumbnailUrl} alt={m.altText || `Image ${n + 1}`} className="size-16 rounded-md border border-border object-cover" />
            </li>
          ))}
        </ol>
      ) : null}

      {panel.afterPreview ? <p className={hintStyles}>{panel.afterPreview}</p> : null}

      {panel.consent ? (
        <div className="flex flex-col gap-1">
          <p id={`${consentId}-text`} className="text-sm">
            {panel.consent.declaration}
          </p>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              className={checkStyles}
              checked={panel.consent.agreed}
              disabled={disabled || panel.details === "error" || panel.consent.fingerprint === ""}
              aria-describedby={`${consentId}-text`}
              onChange={(e) => onAgree(e.target.checked)}
            />
            I agree
          </label>
        </div>
      ) : null}
    </fieldset>
  );
}

function PostingField({
  idPrefix,
  field,
  onChange,
}: {
  idPrefix: string;
  field: PostingFieldView;
  onChange: (key: string, value: unknown) => void;
}) {
  const id = `${idPrefix}-${field.key}`;
  const describedBy = fieldDescribedBy(idPrefix, field);
  const reason = field.disabled ? (
    <p id={`${id}-reason`} className={hintStyles}>
      {field.disabled.reason}
    </p>
  ) : null;
  const help = field.help ? (
    <p id={`${id}-help`} className={hintStyles}>
      {field.help}
    </p>
  ) : null;

  switch (field.kind) {
    case "choice":
      return (
        <div className="flex flex-col gap-1">
          <label htmlFor={id} className={labelStyles}>
            {field.label}
          </label>
          <select
            id={id}
            required={field.required}
            className={controlStyles}
            value={field.value ?? ""}
            disabled={!!field.disabled}
            aria-describedby={describedBy}
            onChange={(e) => onChange(field.key, e.target.value === "" ? null : e.target.value)}
          >
            <option value="">{field.placeholder}</option>
            {field.options.map((o) => (
              <option key={o.value} value={o.value} disabled={!!o.disabled}>
                {o.disabled ? `${o.label} — ${o.disabled.reason}` : o.label}
              </option>
            ))}
          </select>
          {reason}
          {help}
        </div>
      );
    case "toggle":
      return (
        <div className="flex flex-col gap-0.5">
          <label htmlFor={id} className="flex items-center gap-2 text-sm">
            <input
              id={id}
              type="checkbox"
              className={checkStyles}
              checked={field.value}
              disabled={!!field.disabled}
              aria-describedby={describedBy}
              onChange={(e) => onChange(field.key, e.target.checked)}
            />
            {field.label}
          </label>
          {reason}
          {help}
        </div>
      );
    case "text":
      return (
        <div className="flex flex-col gap-1">
          <label htmlFor={id} className={labelStyles}>
            {field.label} <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <input
            id={id}
            type="text"
            className={controlStyles}
            value={field.value}
            disabled={!!field.disabled}
            aria-describedby={`${id}-count${describedBy ? ` ${describedBy}` : ""}`}
            aria-invalid={field.value.length > field.maxLength || undefined}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
          {/* The unit is the provider's own (UTF-16 for TikTok); `length` is that count, and the check re-validates it. */}
          <p id={`${id}-count`} className={hintStyles}>
            {field.value.length} / {field.maxLength}
          </p>
          {reason}
          {help}
        </div>
      );
    case "fixed":
      return (
        <div className="flex flex-col gap-0.5">
          <p className={labelStyles}>{field.label}</p>
          <p className="text-sm">{field.display}</p>
          <p className={hintStyles}>
            {field.explanation}
            {field.doc ? (
              <>
                {" "}
                <a href={field.doc} className="underline" target="_blank" rel="noreferrer">
                  Learn more
                </a>
              </>
            ) : null}
          </p>
          {reason}
          {help}
        </div>
      );
  }
}
