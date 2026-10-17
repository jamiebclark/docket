import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A connect action either refreshes the route the browser is already on, or hands the client a
// `landing` URL to push to. Doing both races: refresh() re-renders the current route, router.push()
// tears that stream down, Next reports "The destination stream closed early" and the route's error
// boundary shows "Something went wrong" — after the connect has already succeeded. The account is
// live and the person is told it failed, which is how a working reconnect looked broken on
// 2026-10-17. The OAuth path is exempt: it redirects server-side, where Next sequences the two.
const SOURCE = "src/app/p/[projectSlug]/accounts/actions.ts";

/**
 * Each `export async function name(...) { ... }` body.
 *
 * These actions take an inline object *type* in the parameter list (`input: { id: string }`), so
 * the first `{` after the name is the parameter type, not the body. Close the parameter list by
 * matching parentheses first, then take the `{` after it — past any return-type annotation.
 */
function actionBodies(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /export async function (\w+)\s*\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const open = src.indexOf("(", m.index + "export async function ".length);
    let depth = 0;
    let afterParams = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) { afterParams = i; break; }
    }
    if (afterParams === -1) continue;
    const start = src.indexOf("{", afterParams);
    if (start === -1) continue;
    depth = 0;
    let end = start;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) { end = i; break; }
    }
    out.push({ name: m[1]!, body: src.slice(start, end + 1) });
  }
  return out;
}

/** Comments mention `refresh()` to explain the rule; only real calls count. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

describe("connect actions that return a landing URL", () => {
  const src = readFileSync(SOURCE, "utf8");
  const actions = actionBodies(src).map((a) => ({ ...a, body: stripComments(a.body) }));

  // Guards the parser itself: an earlier version matched the parameter type's `{`, so every body
  // came back as the parameter list and the rule below passed against a file that broke it.
  it("extracts real function bodies, not the parameter types", () => {
    expect(actions.length).toBeGreaterThan(3);
    const credentials = actions.find((a) => a.name === "connectCredentialsAction");
    expect(credentials).toBeDefined();
    expect(credentials!.body).toMatch(/\bconnectWithCredentials\b/);
    expect(actions.filter((a) => /\blanding:\s*landingFor\(/.test(a.body))).not.toHaveLength(0);
  });

  it("never also refresh the router, directly or through mutate()", () => {
    const offenders = actions
      .filter((a) => /\blanding:\s*landingFor\(/.test(a.body))
      // a server-side redirect is safe: Next sequences the refresh and the navigation itself
      .filter((a) => !/\bredirect\(/.test(a.body))
      .filter((a) => /\brefresh\(\)/.test(a.body) || /\breturn mutate\(/.test(a.body))
      .map((a) => a.name);
    expect(offenders, `${offenders.join(", ")} both refresh and hand the client a landing URL`).toEqual([]);
  });

  it("keeps the rule discoverable where someone would add the next connect action", () => {
    expect(src).toMatch(/must NOT also `refresh\(\)`/);
  });
});
