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

/**
 * An inline text link in prose (policy text, footers): purple, always underlined so it is not told
 * apart by colour alone, with the shared focus ring. Use `buttonStyles()` for a link that is an action.
 */
export const linkStyles =
  "rounded-sm font-medium text-primary underline underline-offset-2 hover:text-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

/** Checkbox / radio inputs: brand accent comes from `accent-color` in globals.css. */
export const checkStyles = "size-4 rounded border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2";

/**
 * A link that *is* a whole table cell (a post excerpt, a project name): purple, underlined only on
 * hover or keyboard focus. Standing alone in its own column it is not told apart "by colour alone"
 * the way a link buried in a sentence is, and a permanent rule under 140 characters of post text
 * reads as clutter. Inside prose use `linkStyles`.
 */
export const cellLinkStyles =
  "rounded-sm text-primary underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

/**
 * A control whose glyph is the whole target — a header nav icon, a row's "go to" arrow. The label
 * rides along as `sr-only` text and a `title` tooltip, so it stays reachable without taking width.
 */
export const iconControlStyles =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";
