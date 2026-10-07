import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import { mediaAssets, postTargets, posts, projects } from "../../../src/server/db/schema";
import { setLlmForTests } from "../../../src/server/llm";
import { OPERATIONS } from "../../../src/server/api/operations";
import { setUrlFetchOverridesForTests } from "../../../src/server/services/media-from-url";
import { setStorageForTests } from "../../../src/server/storage";
import { api, createKey } from "../../helpers/api";
import { closeDb, testDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { startImageServer, type ImageServer } from "../../helpers/image-server";
import { createVoiceProfile } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage } from "../../helpers/storage";

let images: ImageServer;
beforeAll(async () => {
  images = await startImageServer();
});
afterAll(async () => {
  await images.close();
  await closeDb();
});
afterEach(() => {
  setLlmForTests(null);
  setStorageForTests(undefined);
  setUrlFetchOverridesForTests({});
});

interface Block {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** The fenced ```http blocks of the generate-and-queue flow in docs/n8n.md (everything before the recovery section), parsed into requests (template variables left in place). */
function readBlocks(): Block[] {
  const full = readFileSync(resolve(__dirname, "../../../docs/n8n.md"), "utf8");
  const md = full.slice(0, full.indexOf("## 7. Recover failed posts"));
  return [...md.matchAll(/```http\n([\s\S]*?)```/g)].map((m) => {
    const [head = "", ...rest] = (m[1] ?? "").trimEnd().split(/\n\n/);
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

/** Converts a documented path (`/posts/{{post.id}}/queue`) to an OPERATIONS template (`/posts/{postId}/queue`). */
const operationExists = (method: string, path: string) =>
  OPERATIONS.some((op) => op.method === method && new RegExp(`^${op.path.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(path.replace(/\{\{[^}]+\}\}/g, "x")));

describe("docs/n8n.md flow", () => {
  it("names only endpoints that exist, in the documented order", () => {
    const blocks = readBlocks();
    expect(blocks.map((b) => `${b.method} ${b.path.replace(/\{\{post\.id\}\}/, "{id}")}`)).toEqual([
      "POST /media/from-url",
      "POST /generate",
      "POST /posts/{id}/queue",
    ]);
    for (const b of blocks) expect(operationExists(b.method, b.path), b.path).toBe(true);
  });

  it("runs for three rows twice: everything is made once, the second run replays", async () => {
    setStorageForTests(createMemoryStorage());
    setUrlFetchOverridesForTests({ addressPolicy: "allow-loopback" });
    const env = await postsEnv();
    const account = await env.account({}, true);
    const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Warm and direct." } });
    await testDb().update(projects).set({ defaultVoiceProfileId: profile.id }).where(eq(projects.id, env.project.id));
    const { secret } = await createKey(env.scope, ["read", "write_posts", "generate", "auto_approve"], { rateLimitPerMinute: 1000 });
    const llm = createFakeLlm([1, 2, 3].map((n) => ({ ok: { variants: { mock: { text: `Post ${n}` } }, imageAltTexts: [`Alt ${n}`] } })));
    setLlmForTests(llm);

    const blocks = readBlocks();
    const rows = [1, 2, 3].map((n) => ({ id: `row-${n}`, imageUrl: images.ok, alt: `Alt ${n}`, brief: `Brief ${n}` }));

    async function run(): Promise<{ replays: number; calls: number; queuedAt: string[] }> {
      let replays = 0;
      let calls = 0;
      const queuedAt: string[] = [];
      for (const row of rows) {
        const vars: Record<string, string> = {
          base: "http://localhost",
          key: secret,
          "row.id": row.id,
          "row.imageUrl": row.imageUrl,
          "row.alt": row.alt,
          "row.brief": row.brief,
          accountId: account.id,
        };
        for (const b of blocks) {
          const idem = fill(b.headers["idempotency-key"] ?? "", vars);
          const r = await api(b.method, fill(b.path, vars), {
            key: secret,
            idem,
            headers: { "content-type": b.headers["content-type"] ?? "application/json" },
            body: fill(b.body, vars),
          });
          expect(r.status, `${b.path}: ${r.text}`).toBeLessThan(300);
          calls += 1;
          if (r.headers.get("idempotent-replayed") === "true") replays += 1;
          if (b.path === "/media/from-url") vars["media.id"] = r.json.id;
          else if (b.path === "/generate") vars["post.id"] = r.json.post.id;
          else for (const t of r.json.results) {
            expect(t.ok, JSON.stringify(t)).toBe(true);
            queuedAt.push(t.scheduledAt ?? t.scheduledFor ?? JSON.stringify(t));
          }
        }
      }
      return { replays, calls, queuedAt };
    }

    const first = await run();
    expect(first.replays).toBe(0);
    expect(new Set(first.queuedAt).size).toBe(3);

    const second = await run();
    expect(second.replays).toBe(second.calls);
    expect(llm.requests).toHaveLength(3);

    const db = testDb();
    const [m] = await db.select({ n: count() }).from(mediaAssets).where(eq(mediaAssets.projectId, env.project.id));
    const [p] = await db.select({ n: count() }).from(posts).where(eq(posts.projectId, env.project.id));
    const targets = await db.select().from(postTargets).where(eq(postTargets.projectId, env.project.id));
    expect(m?.n).toBe(3);
    expect(p?.n).toBe(3);
    expect(targets).toHaveLength(3);
    expect(targets.every((t) => t.status === "scheduled")).toBe(true);
    expect(new Set(targets.map((t) => String(t.scheduledAt))).size).toBe(3);
  });
});
