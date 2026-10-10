import { expect } from "vitest";

const unescape = (s: string) => s.replaceAll("&#x27;", "'").replaceAll("&amp;", "&");
const text = (s: string) => unescape(s.replace(/<[^>]*>/g, ""));

/**
 * Asserts the page renders exactly one `<h1>`, that its text includes `title`,
 * and that `description` is the text of the `<p>` that follows the heading block.
 */
export function expectPageHeader(html: string, expected: { title: string; description: string }): void {
  expect(html.match(/<h1[\s>]/g) ?? []).toHaveLength(1);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  expect(h1, "page has an <h1>").not.toBeNull();
  expect(text(h1![1] ?? "")).toContain(expected.title);
  const after = html.slice(h1!.index + h1![0].length);
  const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(after);
  expect(p, "a <p> follows the heading").not.toBeNull();
  expect(text(p![1] ?? "")).toBe(expected.description);
}
