import { expect } from "vitest";

/**
 * Asserts that rendered HTML shows nothing only a manager should see: env var
 * names, deployment hints, member emails, or links to setup surfaces.
 */
export function expectNoPrivilegedText(
  html: string,
  { emails }: { emails: string[] },
): void {
  expect(html).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/);
  expect(html.toLowerCase()).not.toContain("docker");
  expect(html).not.toContain("/api/internal");
  expect(html).not.toContain("<code");
  for (const email of emails) expect(html).not.toContain(email);
  expect(html).not.toContain("accounts#add-account");
  expect(html).not.toMatch(/#account-[^"'\s]*-slots/);
  expect(html).not.toContain("/voice/new");
}
