import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { closeDb, testDb } from "../../helpers/db";
import { createProject } from "../../helpers/factories";

afterAll(async () => {
  await closeDb();
});

async function insertWith(grantedScopes: string[] | null): Promise<void> {
  const project = await createProject({ name: "Granted scopes CHECK" });
  try {
    await testDb()
      .insert(socialAccounts)
      .values({
        projectId: project.id,
        providerKey: "mock",
        displayName: "Account",
        externalAccountId: randomUUID(),
        grantedScopes,
      });
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    throw cause;
  }
}

// data-model.md §1 — the `social_accounts_granted_scopes_shape` CHECK, tested directly against raw
// values inserted via Drizzle (which goes straight to SQL, with no application-level filtering in
// the way), so the CHECK itself — not `normalizeGrantedScopes` — is what is proven here (FR-009).
describe("social_accounts_granted_scopes_shape CHECK", () => {
  it("rejects a Meta-token-shaped entry", async () => {
    await expect(insertWith(["EAABwzLixnjYBAblahblahblahsecrettoken"])).rejects.toThrow(/violates check constraint/);
  });

  it("rejects 41 entries", async () => {
    const entries = Array.from({ length: 41 }, (_, i) => `scope_${i}`);
    await expect(insertWith(entries)).rejects.toThrow(/violates check constraint/);
  });

  it("rejects an entry containing uppercase or disallowed characters", async () => {
    await expect(insertWith(["Not Valid!"])).rejects.toThrow(/violates check constraint/);
  });

  it("accepts an empty array", async () => {
    await expect(insertWith([])).resolves.toBeUndefined();
  });

  it("accepts null", async () => {
    await expect(insertWith(null)).resolves.toBeUndefined();
  });

  it("accepts a normal permission list", async () => {
    await expect(insertWith(["instagram_basic", "pages_read_engagement"])).resolves.toBeUndefined();
  });
});
