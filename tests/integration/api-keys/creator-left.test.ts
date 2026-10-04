import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { member } from "../../../src/server/db/schema";
import { createApiKey, listApiKeys } from "../../../src/server/services/api-keys";
import { api } from "../../helpers/api";
import { closeDb, testDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

describe("a key whose creator left the project", () => {
  it("keeps working and is listed with '(no longer a member)' data", async () => {
    const env = await postsEnv();
    const admin = await env.as(env.admin);
    const { secret, key } = await createApiKey(admin, { name: "left", permissions: ["read"], rateLimitPerMinute: 60, expiry: "never" });
    const before = (await listApiKeys(env.scope)).find((k) => k.id === key.id)!;
    expect(before.createdBy.isMember).toBe(true);

    await runCrossProject("test: remove the creator", () =>
      testDb().delete(member).where(and(eq(member.organizationId, env.project.id), eq(member.userId, env.admin.id))),
    );

    expect((await api("GET", "/accounts", { key: secret })).status).toBe(200);
    const after = (await listApiKeys(env.scope)).find((k) => k.id === key.id)!;
    expect(after.createdBy.isMember).toBe(false);
    expect(after.createdBy.name).toBe(env.admin.name);
  });
});
