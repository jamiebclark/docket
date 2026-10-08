import { describe, expect, it } from "vitest";
import { projectOwnedTables } from "../../src/server/db/project-owned";
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

  it("does not let a pin inside a subquery pin the outer reference", () => {
    const sql =
      'select "member"."organization_id" from "member" where "member"."user_id" in (select "user_id" from "member" where "member"."organization_id" = $1)';
    expect(run(sql).violations).toHaveLength(1);
  });

  it("does not count a negated equality as a pin", () => {
    expect(
      run('select * from "member" where not "member"."organization_id" = $1').violations,
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

  it("fails closed on negation, insert-select and comma joins", () => {
    expect(
      run(
        'select "id" from "member" where not ("member"."user_id" = $1 and "member"."organization_id" = $2)',
      ).violations,
    ).toHaveLength(1);
    expect(
      run(
        'insert into "member" ("id", "organization_id", "user_id") select "id", "organization_id", "user_id" from "member" where "member"."user_id" = $1',
      ).violations,
    ).toHaveLength(1);
    expect(
      run('select * from "member", "membership_audit_log" where "member"."organization_id" = $1').violations,
    ).toHaveLength(1);
    expect(run('select * from "member" where not $1 = "member"."organization_id"').violations).toHaveLength(1);
  });
});

describe("generation tables are in the project-owned registry", () => {
  it.each(["voice_profiles", "voice_profile_versions", "generation_series", "generation_failures"])(
    "%s: an unpinned query fails and a pinned one passes",
    (table) => {
      expect(projectOwnedTables.some((t) => t.table === table && t.scopeColumn === "project_id")).toBe(true);
      const registry = [...projectOwnedTables];
      expect(checkScope([{ sql: `select * from "${table}" where "id" = $1` }], registry).violations).toHaveLength(1);
      expect(
        checkScope([{ sql: `select * from "${table}" where "${table}"."project_id" = $1` }], registry).violations,
      ).toEqual([]);
    },
  );
});

describe("project-set statements", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const OUTSIDE = "33333333-3333-4333-8333-333333333333";
  const registry = [...projectOwnedTables];
  const set = { reason: "activity: my projects", projectIds: [A, B] };
  const sql = (n: number) => `select * from activity_events where activity_events.project_id = $${n}`;

  it("passes a pin inside the caller's set", () => {
    const r = checkScope([{ sql: sql(1), params: [A], projectSet: set }], registry);
    expect(r.violations).toEqual([]);
    expect(r.projectSet.map((p) => p.reason)).toEqual(["activity: my projects"]);
  });

  it("fails a pin outside the set", () => {
    const { violations } = checkScope([{ sql: sql(2), params: ["x", OUTSIDE], projectSet: set }], registry);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^Project-set query pinned to a project outside the caller's set \("activity: my projects"\)/);
  });

  it("fails an unpinned activity_events query inside the section", () => {
    const { violations } = checkScope(
      [{ sql: "select * from activity_events where activity_events.outcome = $1", params: ["failed"], projectSet: set }],
      registry,
    );
    expect(violations[0]).toMatch(/^Unscoped query on project-owned table "activity_events"/);
  });

  it("checks every pin of a union, and ignores non-pin parameters", () => {
    const union = `(select * from activity_events where activity_events.project_id = $1 and activity_events.platform = $2) union all (select * from activity_events where activity_events.project_id = $3)`;
    expect(checkScope([{ sql: union, params: [A, OUTSIDE, B], projectSet: set }], registry).violations).toEqual([]);
    expect(checkScope([{ sql: union, params: [A, A, OUTSIDE], projectSet: set }], registry).violations).toHaveLength(1);
  });

  it("leaves a record without a project set exactly as before", () => {
    expect(checkScope([{ sql: sql(1), params: [OUTSIDE] }], registry).violations).toEqual([]);
  });
});
