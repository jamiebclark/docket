/**
 * Moves focus to the first field in `order` that has an error, so a refused submit lands the keyboard
 * on the thing to fix rather than leaving it on the submit button (the Forms rule in the docket-ui
 * skill). The ids are `Field`'s own `id`s, which is what `aria-describedby` already points at.
 *
 * Returns the id it focused, or null when nothing matched — a caller that renders a form-level error
 * instead can use that to decide whether anything needs focusing at all.
 */
export function focusFirstError(errors: Record<string, string | undefined>, order: readonly string[]): string | null {
  for (const id of order) {
    if (!errors[id]) continue;
    const el = document.getElementById(id);
    if (!el) continue;
    el.focus();
    return id;
  }
  return null;
}
