import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";
import { registerTestProvider } from "../../helpers/provider-fixtures";
import { mockProvider } from "../../../src/providers/mock";
import type { CustomCountingRule, SocialProvider } from "../../../src/providers/types";
import { validateAgainstCapabilities } from "../../../src/providers/validation";
import * as accounts from "../../../src/server/services/accounts";
import * as posts from "../../../src/server/services/posts";

/** Counts every "a" as three units so it can never coincide with a built-in rule. */
const aaa: CustomCountingRule = {
  kind: "custom",
  name: "triple-a",
  unit: "triples",
  count: (t) => [...t].filter((c) => c === "a").length * 3,
};

const customProvider = registerTestProvider({
  ...mockProvider,
  key: "custom-rule",
  displayName: "Custom rule (test)",
  capabilities: { ...mockProvider.capabilities, text: { maxLength: 9, countingRule: aaa } },
} as SocialProvider);

afterAll(async () => {
  await closeDb();
});

async function setup() {
  const env = await postsEnv();
  const account = await accounts.saveConnectedAccount(env.scope, {
    providerKey: customProvider.key,
    externalAccountId: `c-${Math.random().toString(36).slice(2, 8)}`,
    displayName: "Custom",
    settings: {},
  });
  return { env, account };
}

describe("custom counting rule (G9 invariant)", () => {
  it.each(["b", "a", "aaa", "aaaa", "bbbbbbbbbbbb", "aab"])("TargetCheck.count matches the validation count for %j", async (text) => {
    const { env, account } = await setup();
    const check = await posts.checkComposition(env.scope, { baseText: text, targets: [{ accountId: account.id }] });
    const t = check.targets[0]!;
    const expected = aaa.count(text);
    expect(t.count).toBe(expected);
    expect(t.limit).toBe(9);
    expect(t.countingRule).toBe("triple-a");
    const tooLong = t.issues.find((i) => i.code === "text_too_long");
    expect(tooLong?.count).toBe(tooLong ? expected : undefined);
    expect(t.canSchedule).toBe(expected <= 9);
    const direct = validateAgainstCapabilities({ text, media: [] }, customProvider.capabilities).find((i) => i.code === "text_too_long");
    expect(direct?.count).toBe(tooLong?.count);
  });

  it("states the custom unit in the message", async () => {
    const { env, account } = await setup();
    const check = await posts.checkComposition(env.scope, { baseText: "aaaa", targets: [{ accountId: account.id }] });
    expect(check.targets[0]!.issues.find((i) => i.code === "text_too_long")?.message).toBe("Text is 12 triples; the limit is 9.");
  });

  it("the publish gate blocks exactly when the count exceeds the limit", async () => {
    const { env, account } = await setup();
    for (const [text, blocked] of [["aaa", false], ["aaaa", true]] as const) {
      const draft = await posts.createDraft(env.scope, { baseText: text, targets: [{ accountId: account.id }] });
      const results = await posts.publishNow(env.scope, draft.post.id);
      expect(results[0]!.ok, text).toBe(!blocked);
      if (blocked) expect(results[0]).toMatchObject({ ok: false, code: "validation" });
    }
  });

  it("serialises to JSON with no function in the compose-check result", async () => {
    const { env, account } = await setup();
    const check = await posts.checkComposition(env.scope, { baseText: "aaaa", targets: [{ accountId: account.id }] });
    const round = JSON.parse(JSON.stringify(check));
    expect(round).toEqual(check);
    expect(round.targets[0].countingRule).toBe("triple-a");
    expect(JSON.stringify(check)).not.toContain("function");
  });
});
