/**
 * Shared class strings for form controls, so raw `<input>`, `<textarea>` and `<select>` elements match
 * `Field` and `Select`. Invalid state comes from `aria-invalid`, never from colour passed in by hand.
 */
export const controlStyles =
  "w-full rounded-lg border border-input bg-surface px-3 py-[0.4375rem] text-sm text-foreground shadow-xs placeholder:text-muted-foreground/80 transition-colors hover:border-primary/60 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/40 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-70 aria-invalid:border-danger aria-invalid:ring-danger/30";

/** Visible label above a control. */
export const labelStyles = "text-sm font-medium text-foreground";

/** Help text linked through `aria-describedby`. */
export const hintStyles = "text-xs text-muted-foreground";

/** Inline field error inside an `aria-live` region. */
export const errorStyles = "min-h-4 text-xs font-medium text-danger";

/** Checkbox / radio inputs: brand accent comes from `accent-color` in globals.css. */
export const checkStyles = "size-4 rounded border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";
