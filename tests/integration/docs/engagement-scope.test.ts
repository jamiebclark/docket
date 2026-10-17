import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const buildPrompt = readFileSync(resolve(root, "docs/build-prompt.md"), "utf8");
const constitution = readFileSync(resolve(root, ".specify/memory/constitution.md"), "utf8");
const engagementDoc = readFileSync(resolve(root, "docs/engagement.md"), "utf8");

describe("the out-of-scope list no longer names comment/inbox management (FR-065)", () => {
  it("docs/build-prompt.md's out-of-scope list does not", () => {
    const scoped = /## Out of scope for now\n\n(.+)/.exec(buildPrompt)?.[1] ?? "";
    expect(scoped).not.toMatch(/comment|inbox/i);
  });

  it(".specify/memory/constitution.md's engineering-constraints out-of-scope list does not", () => {
    const line = /Out of scope until a spec says otherwise:.*/.exec(constitution)?.[0] ?? "";
    expect(line).not.toBe("");
    expect(line).not.toMatch(/inbox\/comments/i);
  });

  // 077 bumped the constitution to 1.5.0; 078 bumped it again. Pinning the exact version makes
  // this fail on every later amendment, which says nothing about engagement's scope change, so
  // assert the floor instead: the 077 bump happened and has not been reverted.
  it("the constitution was amended with a version bump", () => {
    const version = /\*\*Version\*\*:\s*(\d+)\.(\d+)\.(\d+)\b/.exec(constitution);
    expect(version, "the constitution states a version").not.toBeNull();
    const [major, minor] = [Number(version?.[1]), Number(version?.[2])];
    expect(major * 1000 + minor).toBeGreaterThanOrEqual(1 * 1000 + 5);
  });
});

describe("the four recorded gaps are findable in docs/engagement.md (FR-069, SC-016)", () => {
  it("names no moderation", () => {
    expect(engagementDoc).toMatch(/no comment moderation/i);
  });

  it("names no public API or MCP surface", () => {
    expect(engagementDoc).toMatch(/no public api or mcp surface/i);
  });

  it("names no webhooks", () => {
    expect(engagementDoc).toMatch(/no webhooks/i);
  });

  it("names direct messages as pending research", () => {
    expect(engagementDoc).toMatch(/direct messages are pending research/i);
  });
});
