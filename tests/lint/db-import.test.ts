import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

const eslint = new ESLint({ overrideConfigFile: "eslint.config.mjs" });

async function messages(filePath: string, code: string) {
  const [res] = await eslint.lintText(code, { filePath });
  return res!.messages.filter((m) => m.ruleId === "no-restricted-imports");
}

// The first lintText call loads the full Next ESLint config; a cold start can exceed
// Vitest\'s 5 s default on a busy machine or CI runner.
describe("db import restriction", { timeout: 30_000 }, () => {
  it.each([
    'import pg from "pg";',
    'import { drizzle } from "drizzle-orm/node-postgres";',
    'import { getDb } from "@/server/db/client";',
    'import { getDb } from "../server/db";',
  ])("rejects %s outside the DAL", async (code) => {
    const msgs = await messages("src/app/example.ts", `${code}\nexport const x = 1;\n`);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0]!.severity).toBe(2);
  });

  it.each([
    ["src/server/services/example.ts", 'import { getDb } from "../db/client";'],
    ["src/server/services/nested/example.ts", 'import { getDb } from "../../db/client";'],
    ["src/server/services/example.ts", 'import { user } from "../db/schema";'],
    ["src/server/example.ts", 'import { getDb } from "./db/client";'],
  ])("rejects relative import in %s: %s", async (filePath, code) => {
    const msgs = await messages(filePath, `${code}\nexport const x = 1;\n`);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0]!.severity).toBe(2);
  });

  it("allows the same imports under src/server/dal", async () => {
    const code = 'import pg from "pg";\nimport { getDb } from "@/server/db/client";\nexport const x = [pg, getDb];\n';
    expect(await messages("src/server/dal/example.ts", code)).toEqual([]);
  });
});
