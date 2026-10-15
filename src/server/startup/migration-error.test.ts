import { describe, expect, it } from "vitest";
import { describeMigrationFailure } from "./migration-error";

describe("describeMigrationFailure", () => {
  it("keeps the message for an error with no code — the case that printed nothing", () => {
    // Drizzle throws a plain Error when it cannot read the migrations folder.
    expect(describeMigrationFailure(new Error("Can't find meta/_journal.json file"))).toBe(
      "Can't find meta/_journal.json file",
    );
  });

  it("reports a Postgres error with its code, message, detail and hint", () => {
    const pg = Object.assign(new Error('relation "series_runs" already exists'), {
      code: "42P07",
      detail: "A relation with that name is already present.",
      hint: "Drop it or mark the migration applied.",
    });
    expect(describeMigrationFailure(pg)).toBe(
      'relation "series_runs" already exists — A relation with that name is already present. — Drop it or mark the migration applied. (42P07)',
    );
  });

  it("keeps a connection failure's code when it carries no message", () => {
    expect(describeMigrationFailure({ code: "ECONNREFUSED" })).toBe("no message (ECONNREFUSED)");
  });

  it("scrubs the password out of a connection string in the message", () => {
    const e = new Error("could not connect to postgres://docket:hunter2@db:5432/docket");
    expect(describeMigrationFailure(e)).toBe("could not connect to postgres://docket:***@db:5432/docket");
    expect(describeMigrationFailure(e)).not.toContain("hunter2");
  });

  it("handles what is thrown when it is not an Error at all", () => {
    expect(describeMigrationFailure("boom")).toBe("boom");
    expect(describeMigrationFailure(null)).toBe("no error given");
    expect(describeMigrationFailure(undefined)).toBe("no error given");
  });

  it("falls back rather than printing an empty reason", () => {
    expect(describeMigrationFailure(new Error(""))).toBe("no message");
    expect(describeMigrationFailure({})).toBe("no message");
  });
});
