import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import { connectMock } from "../../../src/server/services/accounts";
import { forProject } from "../../../src/server/dal/scope";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { OPERATIONS } from "../../../src/server/api/operations";
import { postingSlots } from "../../../src/server/db/schema/accounts";
import { voiceProfiles } from "../../../src/server/db/schema/generation";
import { projects } from "../../../src/server/db/schema";
import { api, createKey, world } from "../../helpers/api";
import { fakeSession } from "../../helpers/auth";
import { closeDb, testDb } from "../../helpers/db";

afterAll(closeDb);

interface Block {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** The fenced ```http blocks of the provisioning example in docs/n8n.md (section 8 only), parsed into requests. */
function readBlocks(): Block[] {
  const full = readFileSync(resolve(__dirname, "../../../docs/n8n.md"), "utf8");
  const start = full.indexOf("## 8. Provision a brand");
  const end = full.indexOf("## 9. Read activity");
  const md = full.slice(start, end);
  return [...md.matchAll(/```http\n([\s\S]*?)```/g)].map((m) => {
    const unindented = (m[1] ?? "").replace(/^ +/gm, "");
    const [head = "", ...rest] = unindented.trimEnd().split(/\n\n/);
    const [requestLine = "", ...headerLines] = head.split("\n");
    const [method = "", url = ""] = requestLine.split(" ");
    return {
      method,
      path: url.replace("{{base}}/api/v1", ""),
      headers: Object.fromEntries(headerLines.map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()])),
      body: rest.join("\n\n"),
    };
  });
}

const fill = (s: string, vars: Record<string, string>) => s.replace(/\{\{([\w.]+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);

const operationExists = (method: string, path: string) =>
  OPERATIONS.some((op) => op.method === method && new RegExp(`^${op.path.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(path.replace(/\{\{[^}]+\}\}/g, "x")));

describe("docs/n8n.md §8 provisioning example", () => {
  it("names only endpoints that exist, in the documented order", () => {
    const blocks = readBlocks();
    expect(blocks.map((b) => b.path.replace(/\{\{[^}]+\}\}/g, "{id}"))).toEqual([
      "/projects",
      "/voice-profiles",
      "/accounts/{id}",
      "/slots/week",
      "/slots",
    ]);
    for (const b of blocks) expect(operationExists(b.method, b.path), b.path).toBe(true);
  });

  it("stands a brand up in at most five HTTP calls (SC-002), with none failing (SC-004), and a re-run creates nothing new (SC-003)", async () => {
    const blocks = readBlocks();
    const w = await world();
    const uniq = Math.random().toString(36).slice(2, 10);
    const brand = {
      id: uniq,
      name: `Brand ${uniq}`,
      slug: `brand-${uniq}`,
      timezone: "America/New_York",
      voiceAndTone: "Warm, a little playful, never salesy.",
      postingInstructions: "Two hashtags max. Never link out.",
    };

    let newKey = "";
    let accountId = "";
    let projectSlug = "";
    let projectId = "";

    async function run(): Promise<{ calls: number; replays: number }> {
      let calls = 0;
      let replays = 0;
      const vars: Record<string, string> = {
        base: "http://localhost",
        key: w.a.keys.manageSetup.secret,
        newKey,
        "brand.id": brand.id,
        "brand.name": brand.name,
        "brand.slug": brand.slug,
        "brand.timezone": brand.timezone,
        "brand.voiceAndTone": brand.voiceAndTone,
        "brand.postingInstructions": brand.postingInstructions,
        accountId,
      };
      for (const b of blocks) {
        const idem = fill(b.headers["idempotency-key"] ?? "", vars);
        const r = await api(b.method, fill(b.path, vars), {
          key: vars[b.path === "/projects" ? "key" : "newKey"],
          idem,
          headers: { "content-type": b.headers["content-type"] ?? "application/json" },
          body: fill(b.body, vars),
        });
        expect(r.status, `${b.path}: ${r.text}`).toBeLessThan(300);
        expect(r.json?.error?.code, b.path).not.toBe("internal_error");
        calls += 1;
        if (r.headers.get("idempotent-replayed") === "true") replays += 1;

        if (b.path === "/projects") {
          vars["project.id"] = r.json.id;
          projectId = r.json.id;
          projectSlug = r.json.slug;

          if (!newKey) {
            // Step 2, done once in the browser: connect the account and create the project-scoped key.
            const newScope = await forProject(fakeSession(w.a.owner.id), projectSlug);
            const account = await connectMock(newScope, { displayName: `Mock ${uniq}` });
            accountId = account.id;
            vars.accountId = account.id;
            const created = await createKey(newScope, ["read", "write_posts", "generate", "manage_setup"]);
            newKey = created.secret;
            vars.newKey = created.secret;
          }
        }
      }
      return { calls, replays };
    }

    const first = await run();
    expect(first.calls).toBeLessThanOrEqual(5);
    expect(first.replays).toBe(0);

    const second = await run();
    expect(second.replays).toBe(second.calls);

    await runCrossProject("test", async () => {
      const db = testDb();
      const [projectCount] = await db.select({ n: count() }).from(projects).where(eq(projects.slug, projectSlug));
      const [profileCount] = await db.select({ n: count() }).from(voiceProfiles).where(eq(voiceProfiles.projectId, projectId));
      const [slotCount] = await db.select({ n: count() }).from(postingSlots).where(eq(postingSlots.projectId, projectId));
      expect(projectCount?.n).toBe(1);
      expect(profileCount?.n).toBe(1);
      expect(slotCount?.n).toBe(8);
    });
  });
});
