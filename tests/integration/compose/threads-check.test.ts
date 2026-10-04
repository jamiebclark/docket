import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";
import { threadsCapabilities } from "../../../src/providers/threads/capabilities";
import { countThreadsText } from "../../../src/providers/threads/text";
import { validateThreads } from "../../../src/providers/threads/validate";
import * as accounts from "../../../src/server/services/accounts";
import * as posts from "../../../src/server/services/posts";

afterAll(async () => {
  await closeDb();
});

async function setup() {
  const env = await postsEnv();
  const account = await accounts.saveConnectedAccount(env.scope, {
    providerKey: "threads",
    externalAccountId: `t-${Math.random().toString(36).slice(2, 8)}`,
    displayName: "@threads",
    settings: {},
  });
  return { env, account };
}

const strings: [string, string][] = [
  ["empty", ""],
  ["500 ascii", "a".repeat(500)],
  ["501 ascii", "a".repeat(501)],
  ["496 + emoji", "a".repeat(496) + "😀"],
  ["497 + emoji", "a".repeat(497) + "😀"],
  ["family", "👨‍👩‍👧‍👦"],
  ["flag and keycap", "🇫🇷1️⃣"],
  ["accents and CJK", "é日é"],
];

describe("composer check for a Threads target (SC-007, G9)", () => {
  it.each(strings)("matches the direct validator for %s", async (_label, text) => {
    const { env, account } = await setup();
    const check = await posts.checkComposition(env.scope, { baseText: text, targets: [{ accountId: account.id }] });
    const t = check.targets[0]!;
    expect(t.count).toBe(countThreadsText(text));
    expect(t.limit).toBe(500);
    expect(t.countingRule).toBe("threads");
    const direct = validateThreads({ text, media: [] }, threadsCapabilities);
    const pick = (issues: { code: string; severity: string }[]) =>
      issues.filter((i) => i.code === "text_too_long" || i.code === "empty_post").map((i) => `${i.severity}:${i.code}`);
    expect(pick(t.issues)).toEqual(pick(direct));
    expect(t.canSchedule).toBe(!direct.some((i) => i.severity === "error"));
  });

  it("serialises to JSON with no function in the result", async () => {
    const { env, account } = await setup();
    const check = await posts.checkComposition(env.scope, { baseText: "a".repeat(501), targets: [{ accountId: account.id }] });
    const round = JSON.parse(JSON.stringify(check));
    expect(round).toEqual(check);
    expect(round.targets[0].countingRule).toBe("threads");
    expect(JSON.stringify(check)).not.toContain("function");
  });
});
