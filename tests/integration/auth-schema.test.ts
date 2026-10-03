import { describe, expect, it } from "vitest";
import { getAuth, withBetterAuth } from "../../src/server/auth/auth";

// Research U1: Better Auth's runtime schema check must accept the migrated (timestamptz) schema.
describe("Better Auth against the migrated schema", () => {
  it("boots and answers an auth.api call", async () => {
    const session = await withBetterAuth(() => getAuth().api.getSession({ headers: new Headers() }));
    expect(session).toBeNull();
  });
});
