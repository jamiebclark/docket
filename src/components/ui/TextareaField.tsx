"use client";

import { useLayoutEffect, useRef, type ReactNode, type Ref, type TextareaHTMLAttributes } from "react";
import { controlStyles, errorStyles, hintStyles, labelStyles } from "./controls";
import { measureHeight, sizingStyle } from "./textarea-sizing";

function supportsFieldSizing() {
  return typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");
}

/** Releases the previously assigned height so `scrollHeight` reflects content, not the last clamp. */
function releaseHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
}

function resize(el: HTMLTextAreaElement, minRows?: number, maxRows?: number | null, rowHeightRem?: number) {
  if (supportsFieldSizing()) return;
  releaseHeight(el);
  const lineHeight = getComputedStyle(el).lineHeight;
  const lineHeightPx = lineHeight === "normal" ? null : parseFloat(lineHeight);
  const measurement = measureHeight({ scrollHeight: el.scrollHeight, lineHeightPx }, { minRows, maxRows, rowHeightRem });
  if (measurement.height !== null) {
    el.style.height = `${measurement.height}px`;
  }
  el.style.overflowY = measurement.overflowY;
}

/**
 * Labelled, auto-growing multi-line text control. `error` is rendered in an `aria-live` region
 * linked through `aria-describedby`; `hint` and `counter` are linked the same way.
 */
export function TextareaField({
  id,
  label,
  hideLabel,
  hint,
  beforeControl,
  error,
  counter,
  counterClassName = "text-right text-xs text-muted-foreground",
  mono,
  minRows,
  maxRows,
  rowHeightRem,
  className = "",
  ref,
  onInput,
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id" | "rows"> & {
  id: string;
  label: ReactNode;
  hideLabel?: boolean;
  hint?: ReactNode;
  /** Rendered after the hint and before the control; excluded from aria-describedby (e.g. a chip row). */
  beforeControl?: ReactNode;
  error?: string;
  counter?: ReactNode;
  counterClassName?: string;
  mono?: boolean;
  minRows?: number;
  maxRows?: number | null;
  rowHeightRem?: number;
  ref?: Ref<HTMLTextAreaElement>;
}) {
  const hintId = `${id}-hint`;
  const countId = `${id}-count`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, counter ? countId : null, errorId].filter(Boolean).join(" ");
  const style = sizingStyle({ minRows, maxRows, rowHeightRem });
  const localRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const el = localRef.current;
    if (el) resize(el, minRows, maxRows, rowHeightRem);
  });

  useLayoutEffect(() => {
    const el = localRef.current;
    if (!el || supportsFieldSizing()) return;
    if (el.scrollHeight !== 0) return;
    const observer = new ResizeObserver(() => {
      if (el.scrollHeight !== 0) {
        resize(el, minRows, maxRows, rowHeightRem);
        observer.disconnect();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={hideLabel ? "sr-only" : labelStyles}>
        {label}
      </label>
      {hint ? (
        <p id={hintId} className={hintStyles}>
          {hint}
        </p>
      ) : null}
      {beforeControl}
      <textarea
        id={id}
        rows={style.rows}
        ref={(el) => {
          localRef.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        style={{ minHeight: style.minHeight, maxHeight: style.maxHeight }}
        className={`${controlStyles} field-sizing-content overflow-y-auto ${mono ? "font-mono " : ""}${className}`}
        onInput={(e) => {
          resize(e.currentTarget, minRows, maxRows, rowHeightRem);
          onInput?.(e);
        }}
        {...rest}
      />
      {counter ? (
        <p id={countId} className={counterClassName}>
          {counter}
        </p>
      ) : null}
      <p id={errorId} aria-live="polite" className={errorStyles}>
        {error ?? ""}
      </p>
    </div>
  );
}
