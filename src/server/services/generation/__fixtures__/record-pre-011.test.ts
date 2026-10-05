import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { buildCases } from "./cases";

/** Records today's prompt/schema output. Run once, on code untouched by feature 011:
 *  RECORD_PRE_011=1 pnpm vitest run src/server/services/generation/__fixtures__/record-pre-011.test.ts */
describe.skipIf(!process.env.RECORD_PRE_011)("record pre-011 prompts", () => {
  it("writes pre-011-prompts.json", () => {
    writeFileSync(join(__dirname, "pre-011-prompts.json"), JSON.stringify(buildCases(), null, 2) + "\n");
  });
});
