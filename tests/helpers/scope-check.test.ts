import { describe, expect, it } from "vitest";
import { checkScope, type ProjectOwnedTable } from "./scope-check";

const owned: ProjectOwnedTable[] = [
  { table: "projects", scopeColumn: "id" },
  { table: "member", scopeColumn: "organization_id" },
  { table: "invitation_tokens", scopeColumn: "project_id" },
  { table: "membership_audit_log", scopeColumn: "project_id" },
];

const run = (sql: string, crossProjectReason?: string) =>
  checkScope([{ sql, crossProjectReason }], owned);

describe("checkScope", () => {
  it("passes pinned select, update and delete", () => {
    expect(run('select "id", "role" from "member" where "member"."organization_id" = $1').violations).toEqual([]);
    expect(run('update "member" set "role" = $1 where "member"."organization_id" = $2 and "member"."id" = $3').violations).toEqual([]);
    expect(run('delete from "member" where "organization_id" = $1 and "user_id" = $2').violations).toEqual([]);
  });

  it("fails an unpinned query with the documented message", () => {
    const { violations } = run('select "id", "role" from "member" where "member"."user_id" = $1');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(
      /^Unscoped query on project-owned table "member" \(needs "member"\."organization_id" = \$n\):/,
    );
  });

  it("does not accept in (...), ranges or or", () => {
    expect(run('select * from "member" where "organization_id" in ($1, $2)').violations).toHaveLength(1);
    expect(run('select * from "member" where "organization_id" > $1').violations).toHaveLength(1);
    expect(
      run('select * from "member" where "organization_id" = $1 or "user_id" = $2').violations,
    ).toHaveLength(1);
  });

  it("accepts a join pinned by scope-column equality", () => {
    const sql =
      'select "m"."id" from "member" "m" inner join "membership_audit_log" "a" on "a"."project_id" = "m"."organization_id" where "m"."organization_id" = $1';
    expect(run(sql).violations).toEqual([]);
    const unpinned =
      'select "m"."id" from "member" "m" inner join "membership_audit_log" "a" on "a"."project_id" = "m"."organization_id" where "m"."user_id" = $1';
    expect(run(unpinned).violations).toHaveLength(2);
  });

  it("requires the scope column in an insert column list", () => {
    expect(
      run('insert into "member" ("id", "organization_id", "user_id") values ($1, $2, $3), ($4, $5, $6)').violations,
    ).toEqual([]);
    expect(run('insert into "member" ("id", "user_id") values ($1, $2)').violations).toHaveLength(1);
  });

  it("handles quoted identifiers and raw sql statements", () => {
    expect(run("SELECT 1 FROM member WHERE member.organization_id = $1").violations).toEqual([]);
    expect(run("select 1 from member where user_id = $1").violations).toHaveLength(1);
  });

  it("ignores tables that are not project-owned", () => {
    const r = run('select * from "user" where "email" = $1');
    expect(r.violations).toEqual([]);
    expect(r.checked).toBe(0);
  });

  it("records crossProject queries as skipped and counted", () => {
    const r = run('select * from "member"', "list my projects");
    expect(r.violations).toEqual([]);
    expect(r.crossProject).toEqual([{ reason: "list my projects", sql: 'select * from "member"' }]);
  });
});
