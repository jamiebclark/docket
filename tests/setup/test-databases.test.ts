import { describe, expect, it } from "vitest";
import { parseLabel, runDatabaseName, slug, staleReason, type DatabaseInfo, type RunLabel } from "./test-databases";
import { workerDatabaseUrl } from "./worker-databases";

const now = new Date("2026-10-05T12:00:00Z");
const label = (over: Partial<RunLabel> = {}): RunLabel => ({
  docketTestRun: "abc123",
  host: "this-host",
  pid: 4242,
  started: "2026-10-05T11:00:00Z",
  cwd: "/repo",
  ...over,
});
const db = (over: Partial<DatabaseInfo> = {}): DatabaseInfo => ({ name: "docket_repo_abc123_test", connections: 0, label: label(), ...over });
const opts = { now, host: "this-host", isAlive: () => true };

describe("run database names", () => {
  it("adds the checkout and run id, keeping the _test suffix", () => {
    expect(runDatabaseName("docket_test", "/x/.claude/worktrees/ui-makeover", "3f9a1c")).toBe("docket_ui_makeover_3f9a1c_test");
    expect(runDatabaseName("docket_ui_test", "/Users/me/code/docket", "3f9a1c")).toBe("docket_ui_docket_3f9a1c_test");
  });

  it("stays within Postgres's 63-byte limit with a worker suffix", () => {
    const name = runDatabaseName("docket_test", `/x/${"very-long-worktree-name-".repeat(5)}`, "3f9a1c");
    const worker = new URL(workerDatabaseUrl(`postgres://u@h/${name}`, 12)).pathname.slice(1);
    expect(worker.length).toBeLessThanOrEqual(63);
    expect(worker).toMatch(/_w12_test$/);
  });

  it("refuses a configured name without _test", () => {
    expect(() => runDatabaseName("docket", "/repo", "3f9a1c")).toThrow(/_test/);
  });

  it("slugs to lowercase letters, digits and underscores", () => {
    expect(slug("Feat/UI Makeover!")).toBe("feat_ui_makeover");
    expect(slug("---")).toBe("run");
  });
});

describe("run labels", () => {
  it("round-trips and rejects foreign comments", () => {
    expect(parseLabel(JSON.stringify(label()))).toEqual(label());
    expect(parseLabel("hand-made database")).toBeNull();
    expect(parseLabel(JSON.stringify({ hello: 1 }))).toBeNull();
    expect(parseLabel(null)).toBeNull();
  });
});

describe("stale database rules", () => {
  it("drops a run whose owner process has exited on this host", () => {
    expect(staleReason(db(), { ...opts, isAlive: () => false })).toMatch(/pid 4242 has exited/);
  });

  it("keeps a run whose owner is alive and recent", () => {
    expect(staleReason(db(), opts)).toBeNull();
  });

  it("drops a run older than the stale limit even if a process with that pid exists", () => {
    expect(staleReason(db({ label: label({ started: "2026-10-04T10:00:00Z" }) }), opts)).toMatch(/older than 12 h/);
    expect(staleReason(db(), { ...opts, staleHours: 0.5 })).toMatch(/older than 0.5 h/);
  });

  it("cannot judge another host's pid, so waits for the age limit", () => {
    expect(staleReason(db({ label: label({ host: "ci-runner" }) }), { ...opts, isAlive: () => false })).toBeNull();
  });

  it("never drops a database someone is connected to", () => {
    expect(staleReason(db({ connections: 2 }), { ...opts, isAlive: () => false, staleHours: 0 })).toBeNull();
  });

  it("never drops non-test, protected or kept databases", () => {
    const dead = { ...opts, isAlive: () => false, includeUnlabeled: true };
    expect(staleReason(db({ name: "docket" }), dead)).toBeNull();
    expect(staleReason(db({ name: "docket_dev", label: null }), dead)).toBeNull();
    expect(staleReason(db(), { ...dead, keep: new Set(["docket_repo_abc123_test"]) })).toBeNull();
  });

  it("leaves unlabelled test databases alone unless asked", () => {
    expect(staleReason(db({ label: null }), opts)).toBeNull();
    expect(staleReason(db({ label: null }), { ...opts, includeUnlabeled: true })).toBe("unlabelled");
  });
});
