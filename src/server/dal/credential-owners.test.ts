import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import {
  credentialOwnerFor,
  credentialOwnersFor,
  INSTALL_CREDENTIAL_OWNER,
  jobsExcludingProjects,
} from "./credential-owners";
import { crossProject } from "./scope";

const dialect = new PgDialect();

describe("credential-owners", () => {
  test("credentialOwnerFor resolves to the constant for a project with no stored credential", async () => {
    expect(await credentialOwnerFor("00000000-0000-0000-0000-000000000000")).toBe(INSTALL_CREDENTIAL_OWNER);
  });

  test("credentialOwnersFor([]) resolves to an empty map without a statement", async () => {
    expect(await credentialOwnersFor([])).toEqual(new Map());
  });

  test("credentialOwnersFor defaults every project with no stored credential to the install owner", async () => {
    const ids = ["00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000001"];
    const owners = await crossProject("test: credentialOwnersFor", () => credentialOwnersFor(ids));
    expect(owners.get(ids[0]!)).toBe(INSTALL_CREDENTIAL_OWNER);
    expect(owners.get(ids[1]!)).toBe(INSTALL_CREDENTIAL_OWNER);
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
