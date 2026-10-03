import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "../helpers/db";
import { createProject } from "../helpers/factories";
import {
  createDraftPost,
  createDueTarget,
  createMediaAsset,
  createMockAccount,
  createSlots,
} from "../helpers/scheduling";

afterAll(async () => {
  await closeDb();
});

describe("scheduling test factories", () => {
  it("build an account, slots, media, a draft and a due target", async () => {
    const project = await createProject();
    const account = await createMockAccount(project.id, { behaviour: "multi_step", steps: 2 });
    expect(account.settings).toMatchObject({ behaviour: "multi_step", steps: 2 });
    const slots = await createSlots(project.id, account.id, [{ weekday: 1, localTime: "09:00" }]);
    expect(slots).toHaveLength(1);
    const media = await createMediaAsset(project.id, { altText: "a cat" });
    expect(media.altText).toBe("a cat");
    const { post, targets } = await createDraftPost(project.id, {
      accountIds: [account.id],
      mediaIds: [media.id],
    });
    expect(post.status).toBe("draft");
    expect(targets).toHaveLength(1);
    const due = await createDueTarget(project.id, account.id);
    expect(due.target.status).toBe("scheduled");
    expect(due.target.nextAttemptAt!.getTime()).toBeLessThan(Date.now());
  });
});
