import { afterAll, describe, expect, it } from "vitest";
import { decideAnonymousRedirect } from "../../src/app/root-redirect";
import * as setup from "../../src/server/services/setup";
import { closeDb, createThrowawayDb } from "../helpers/db";
import { createUser } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

describe("anonymous entry redirect against the real install state", () => {
  it("goes to /login once the shared test database has a user", async () => {
    await createUser();
    expect(decideAnonymousRedirect(await setup.isAvailable())).toBe("/login");
  });

  it("goes to /setup on an empty install", async () => {
    const empty = await createThrowawayDb();
    try {
      const { isSetupAvailable } = await import("../../src/server/dal/install");
      expect(decideAnonymousRedirect(await isSetupAvailable(empty.db))).toBe("/setup");
    } finally {
      await empty.drop();
    }
  });
});
