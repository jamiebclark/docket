import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { providers } from "../../../src/providers/registry";
import { validateAgainstCapabilities } from "../../../src/providers/validation";
import type { SocialProvider } from "../../../src/providers/types";
import { forProject } from "../../../src/server/dal/scope";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import * as posts from "../../../src/server/services/posts";
import * as slots from "../../../src/server/services/slots";
import { fakeSession } from "../../helpers/auth";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);

afterAll(async () => {
  const i = providers.findIndex((p) => p.key === "throwaway");
  if (i >= 0) (providers as SocialProvider[]).splice(i, 1);
  await closeDb();
});

// A whole provider, defined here: one object and one registry line.
const throwaway: SocialProvider = {
  key: "throwaway",
  displayName: "Throwaway",
  capabilities: {
    text: { maxLength: 100, countingRule: "code_points" },
    media: { maxImages: 0, allowedMimeTypes: [], maxBytesPerFile: 0, required: false },
    video: { maxVideos: 0 },
    textOnlyAllowed: true,
    postTypes: ["text"],
  },
  connect: { strategy: "credentials", fields: [] },
  settingsSchema: z.object({}),
  validate: (content, caps) => validateAgainstCapabilities(content, caps),
  stepFor: () => ({ name: "publish", mayPublish: true }),
  advance: async () => ({ kind: "done", externalId: "throwaway-1", url: "https://throwaway.invalid/1" }),
};

describe("a new provider needs no engine change (US7)", () => {
  it("is published by runTick once registered", async () => {
    (providers as SocialProvider[]).push(throwaway); // the one registry line
    const BEFORE = new Date("2026-10-01T12:00:00Z");
    const SLOT = new Date("2026-10-05T09:00:00Z");
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const account = await accounts.saveConnectedAccount(scope, {
      providerKey: "throwaway",
      externalAccountId: "throwaway-acct",
      displayName: "Throwaway",
      settings: {},
    });
    await slots.addSlot(scope, { accountId: account.id, weekday: 1, localTime: "09:00" });
    const draft = await posts.createDraft(scope, { baseText: "Hello", targets: [{ accountId: account.id }] });
    await atTime(BEFORE, () => posts.addToQueue(scope, draft.post.id, {}));

    const result = await atTime(SLOT, () => runTick({ config: {} }));
    expect(result.publishing.counts).toMatchObject({ claimed: 1, done: 1 });
    const target = (await posts.getPost(scope, draft.post.id)).targets[0];
    expect(target).toMatchObject({ status: "published" });
  });
});
