import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../../src/server/env", async (orig) => {
  const real = await orig<typeof import("../../src/server/env")>();
  return { ...real, getEnv: () => ({ ...real.getEnv(), MOCK_PROVIDER_ENABLED: false }) };
});

import { ForbiddenError } from "../../src/server/dal/errors";
import { forProject } from "../../src/server/dal/scope";
import * as accounts from "../../src/server/services/accounts";
import { fakeSession } from "../helpers/auth";
import { closeDb } from "../helpers/db";
import { createProjectWithMembers } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

describe("MOCK_PROVIDER_ENABLED=false", () => {
  it("hides the mock provider and refuses to connect it", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    expect((await accounts.listConnectableProviders(scope)).map((p) => p.key)).not.toContain("mock");
    await expect(accounts.connectMock(scope, { displayName: "x" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
