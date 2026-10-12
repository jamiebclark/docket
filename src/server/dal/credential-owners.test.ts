import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import { credentialOwnerFor, INSTALL_CREDENTIAL_OWNER, jobsExcludingProjects } from "./credential-owners";

const dialect = new PgDialect();

describe("credential-owners", () => {
  test("credentialOwnerFor resolves to the constant for any input, including empty", async () => {
    expect(await credentialOwnerFor("some-project-id")).toBe(INSTALL_CREDENTIAL_OWNER);
    expect(await credentialOwnerFor("")).toBe(INSTALL_CREDENTIAL_OWNER);
  });

  test("jobsExcludingProjects([]) is undefined", () => {
    expect(jobsExcludingProjects([])).toBeUndefined();
  });

  test("jobsExcludingProjects excludes exactly the given project ids", () => {
    const predicate = jobsExcludingProjects(["project-a", "project-b"]);
    expect(predicate).toBeDefined();
    const { sql, params } = dialect.sqlToQuery(predicate!);
    expect(sql).toContain("not in");
    expect(params).toEqual(["project-a", "project-b"]);
  });

  test("the owner value never contains an API key or any part of one", () => {
    expect(INSTALL_CREDENTIAL_OWNER).not.toMatch(/sk-/);
    expect(INSTALL_CREDENTIAL_OWNER.length).toBeLessThan(20);
  });
});
