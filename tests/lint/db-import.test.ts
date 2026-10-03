import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

const eslint = new ESLint({ overrideConfigFile: "eslint.config.mjs" });

async function messages(filePath: string, code: string) {
  const [res] = await eslint.lintText(code, { filePath });
  return res!.messages.filter((m) => m.ruleId === "no-restricted-imports");
}

describe("db import restriction", () => {
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

  it("allows the same imports under src/server/dal", async () => {
    const code = 'import pg from "pg";\nimport { getDb } from "@/server/db/client";\nexport const x = [pg, getDb];\n';
    expect(await messages("src/server/dal/example.ts", code)).toEqual([]);
  });
});
