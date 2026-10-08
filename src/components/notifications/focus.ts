/** After "Mark all as read" removes the button the person pressed, keyboard focus returns to the panel heading. */
export function focusAfterMark(succeeded: boolean, heading: { focus: () => void } | null): void {
  if (succeeded) heading?.focus();
}
