import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Which merges cut a release (and so publish a new `latest` image) is decided by .releaserc.json.
// This runs the same plugins semantic-release uses, with that config, against sample commits.
// See docs/decisions.md "Release rules and the edge image".

type PluginEntry = string | [string, Record<string, unknown>];
const config = JSON.parse(readFileSync(join(process.cwd(), ".releaserc.json"), "utf8")) as { plugins: PluginEntry[] };
const pluginConfig = (name: string) => {
  const entry = config.plugins.find((p) => (Array.isArray(p) ? p[0] : p) === name);
  return Array.isArray(entry) ? entry[1] : {};
};

// pnpm does not hoist semantic-release's plugins, so load them from beside semantic-release itself.
const pluginDir = join(realpathSync(join(process.cwd(), "node_modules/semantic-release")), "..", "@semantic-release");
const load = async (name: string) => import(pathToFileURL(join(pluginDir, name, "index.js")).href);

const logger = { log: () => {}, error: () => {}, warn: () => {}, success: () => {} };
const commit = (message: string, i: number) => ({ message, hash: `${i}`.padStart(40, "0"), committerDate: new Date().toISOString() });

async function releaseFor(...messages: string[]): Promise<string | null> {
  const { analyzeCommits } = await load("commit-analyzer");
  return analyzeCommits(pluginConfig("@semantic-release/commit-analyzer"), {
    commits: messages.map(commit),
    logger,
    cwd: process.cwd(),
  });
}

describe("release rules", () => {
  it("keeps the defaults for features, fixes and breaking changes", async () => {
    expect(await releaseFor("feat(ui): add a thing")).toBe("minor");
    expect(await releaseFor("fix: stop a crash")).toBe("patch");
    expect(await releaseFor("perf: faster ticks")).toBe("patch");
    expect(await releaseFor("feat!: drop the old API")).toBe("major");
  });

  it("releases a patch for changes that alter the shipped app or image", async () => {
    expect(await releaseFor("refactor(ui): move screens onto tokens")).toBe("patch");
    expect(await releaseFor('revert: "feat: add a thing"')).toBe("patch");
    expect(await releaseFor("build: bump the node base image")).toBe("patch");
    expect(await releaseFor("build(deps): bump next to 16.3.9")).toBe("patch");
    expect(await releaseFor("chore(deps): bump drizzle-orm")).toBe("patch");
  });

  it("does not release for docs, tests, CI, tooling or dev-only dependencies", async () => {
    for (const message of ["docs: fix a typo", "test: cover the picker", "ci: cache pnpm", "chore: tidy scripts", "style: format", "chore(deps-dev): bump vitest"]) {
      expect(await releaseFor(message), message).toBeNull();
    }
  });

  it("takes the highest bump across a merge", async () => {
    expect(await releaseFor("docs: notes", "refactor: tidy", "feat: new screen")).toBe("minor");
  });
});

describe("release notes", () => {
  it("lists refactors and dependency updates so a patch release is never blank", async () => {
    const { generateNotes } = await load("release-notes-generator");
    const notes: string = await generateNotes(pluginConfig("@semantic-release/release-notes-generator"), {
      commits: ["refactor(ui): move screens onto tokens", "chore(deps): bump drizzle-orm", "docs: fix a typo"].map(commit),
      logger,
      cwd: process.cwd(),
      options: { repositoryUrl: "https://github.com/jamiebclark/docket" },
      lastRelease: { gitTag: "v1.5.0", version: "1.5.0" },
      nextRelease: { gitTag: "v1.5.1", version: "1.5.1" },
    });
    expect(notes).toContain("Code Refactoring");
    expect(notes).toContain("move screens onto tokens");
    expect(notes).toContain("Build and Dependencies");
    expect(notes).toContain("bump drizzle-orm");
    expect(notes).not.toContain("fix a typo");
  });
});
