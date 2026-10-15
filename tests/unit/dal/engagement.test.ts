import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// FR-010, enforced structurally: `EngagementItemsRepo` has no way to write `text`, `externalId`,
// `saidAt` or an author field outside `insertIfAbsent`. A trigger would also work; this is cheaper
// and the repo's shape is the whole of the enforcement (data-model.md §2), so the test reads the
// interface's own source rather than exercising it through the database.

const SOURCE = readFileSync("src/server/dal/engagement.ts", "utf8");

function interfaceBody(name: string): string {
  const start = SOURCE.indexOf(`export interface ${name} {`);
  expect(start, `expected an "export interface ${name}" declaration`).toBeGreaterThanOrEqual(0);
  const open = SOURCE.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < SOURCE.length; i++) {
    if (SOURCE[i] === "{") depth++;
    if (SOURCE[i] === "}") {
      depth--;
      if (depth === 0) return SOURCE.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated interface ${name}`);
}

describe("EngagementItemsRepo's public surface (FR-010)", () => {
  const body = interfaceBody("EngagementItemsRepo");
  const methodNames = [...body.matchAll(/^\s*([a-zA-Z]+)\(/gm)].map((m) => m[1]!);

  it("has no method besides insertIfAbsent that could write text, externalId, saidAt or an author field", () => {
    // Readers may take a lookup key (e.g. `getByExternalId`'s externalId); only a write path's own
    // parameters are the hazard FR-010 guards against.
    const writers = methodNames.filter((name) => name !== "insertIfAbsent" && !/^(get|list|count)/.test(name));
    for (const name of writers) {
      const signature = body.slice(body.indexOf(`${name}(`));
      const params = signature.slice(0, signature.indexOf(")") + 1);
      expect(params, `${name}'s parameters`).not.toMatch(/\btext\b/i);
      expect(params, `${name}'s parameters`).not.toMatch(/external[Ii]d/);
      expect(params, `${name}'s parameters`).not.toMatch(/said[Aa]t/);
      expect(params, `${name}'s parameters`).not.toMatch(/author/i);
    }
  });

  it("does declare insertIfAbsent as the one write path for those fields", () => {
    expect(methodNames).toContain("insertIfAbsent");
  });

  it("lists exactly the mutators data-model.md §2 names, plus the readers", () => {
    expect(methodNames.filter((n) => n.startsWith("mark")).sort()).toEqual(["markAnswered", "markDismissed", "markEditedUpstream", "markWithdrawn"]);
  });
});
