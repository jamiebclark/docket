import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const engagementDoc = readFileSync(resolve(root, "docs/engagement.md"), "utf8");
const metaSetupDoc = readFileSync(resolve(root, "docs/meta-setup.md"), "utf8");
const providerGuide = readFileSync(resolve(root, "docs/adding-a-provider.md"), "utf8");

function tableRows(markdown: string): string[][] {
  const tableMatch = /\| Platform \| Reading comments\/mentions \| Replying \| Direct messages \|\n\|.*\|\n((?:\|.*\|\n?)+)/.exec(
    markdown,
  );
  if (!tableMatch) throw new Error("supported-platforms table not found");
  return tableMatch[1]
    .trim()
    .split("\n")
    .map((line) => line.split("|").map((cell) => cell.trim()).filter((cell) => cell.length > 0));
}

describe("the supported-platforms table (FR-025, FR-026, FR-027, SC-005)", () => {
  const rows = tableRows(engagementDoc);

  it("has a row for Threads replies and a row for Threads mentions, each naming its own permission", () => {
    const repliesRow = rows.find((r) => r[0] === "Threads — replies");
    const mentionsRow = rows.find((r) => r[0] === "Threads — mentions");
    expect(repliesRow, "Threads — replies row").toBeDefined();
    expect(mentionsRow, "Threads — mentions row").toBeDefined();
    expect(repliesRow?.[1]).toMatch(/threads_manage_replies/);
    expect(mentionsRow?.[1]).toMatch(/threads_manage_mentions/);
  });

  it("every 'Not yet' cell in the reading column has more than the words 'Not yet'", () => {
    for (const row of rows) {
      const cell = row[1];
      if (cell.startsWith("Not yet")) {
        expect(cell, `reading cell for ${row[0]}`).not.toBe("Not yet");
      }
    }
  });

  it("the Threads reading cells mention an endpoint and do not present the permission as the blocker", () => {
    for (const label of ["Threads — replies", "Threads — mentions"]) {
      const cell = rows.find((r) => r[0] === label)?.[1] ?? "";
      expect(cell, `${label} reading cell`).toMatch(/endpoint/i);
      expect(cell, `${label} reading cell`).not.toMatch(/would need/i);
    }
  });

  it("the reply column names no Meta surface as sendable", () => {
    for (const label of ["Facebook Pages", "Instagram", "Threads — replies", "Threads — mentions"]) {
      const cell = rows.find((r) => r[0] === label)?.[2] ?? "";
      expect(cell, `${label} reply cell`).toMatch(/^Not yet/);
    }
  });

  it("the direct messages column is 'Not yet' on every row", () => {
    for (const row of rows) {
      expect(row[3], `${row[0]} DM cell`).toBe("Not yet");
    }
  });
});

describe("docs/engagement.md no longer attributes Threads' absence to the identity shape (FR-026)", () => {
  it("drops the identity-shape sentence", () => {
    expect(engagementDoc).not.toMatch(/commenter\/mention identity shape is not confirmed/i);
  });
});

describe("docs/meta-setup.md no longer claims nothing is read on any Meta surface (FR-028)", () => {
  it("drops the false sentence", () => {
    expect(metaSetupDoc).not.toMatch(/Nothing is read on any Meta or Threads surface yet in this release/i);
  });

  it("states Facebook and Instagram comments are read once the permission is granted", () => {
    expect(metaSetupDoc).toMatch(/Facebook and Instagram comments are read once/i);
  });
});

describe("the Threads opt-in text states that granting does not cause reading (FR-028)", () => {
  it("docs/engagement.md's Threads permission bullet", () => {
    const threadsBullet = /\*\*Threads\*\*:.*?(?=\n- \*\*|\n##)/s.exec(engagementDoc)?.[0] ?? "";
    expect(threadsBullet.replace(/\s+/g, " ")).toMatch(
      /granting these permissions does not cause anything to be read/i,
    );
  });
});

describe("docs/adding-a-provider.md §20 names both reader shapes (FR-029, SC-006)", () => {
  const section20 = /## 20\. .*?(?=\n## 21)/s.exec(providerGuide)?.[0] ?? "";

  it("§20 exists", () => {
    expect(section20).not.toBe("");
  });

  it("names bluesky/engagement.ts and meta/engagement-sweep.ts, and both paths exist on disk", () => {
    expect(section20).toMatch(/src\/providers\/bluesky\/engagement\.ts/);
    expect(section20).toMatch(/src\/providers\/meta\/engagement-sweep\.ts/);
    expect(existsSync(resolve(root, "src/providers/bluesky/engagement.ts"))).toBe(true);
    expect(existsSync(resolve(root, "src/providers/meta/engagement-sweep.ts"))).toBe(true);
  });

  it("no longer claims bluesky is the one real implementation so far", () => {
    expect(section20).not.toMatch(/the one real implementation so far/i);
  });

  it("contains the 'has not published' / 'has not granted' distinction", () => {
    const flattened = section20.replace(/\s+/g, " ");
    expect(flattened).toMatch(/the platform has not published/i);
    expect(flattened).toMatch(/this account has not granted/i);
  });

  it("names src/providers/threads/engagement.ts as the current example of the unpublished case", () => {
    expect(section20).toMatch(/src\/providers\/threads\/engagement\.ts/);
    expect(existsSync(resolve(root, "src/providers/threads/engagement.ts"))).toBe(true);
  });
});
