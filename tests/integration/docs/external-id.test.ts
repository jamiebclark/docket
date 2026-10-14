import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { projects } from "../../../src/server/db/schema";
import { setLlmForTests } from "../../../src/server/llm";
import { OPERATIONS } from "../../../src/server/api/operations";
import { api, createKey } from "../../helpers/api";
import { closeDb, testDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { deletePost } from "../../../src/server/services/posts";
import { createVoiceProfile } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";
import { createDraftPost } from "../../helpers/scheduling";

afterAll(async () => {
  setLlmForTests(null);
  await closeDb();
});

interface Block {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** The fenced ```http blocks of docs/n8n.md's section 10 ("Post each record once"), parsed into requests. */
function readBlocks(): Block[] {
  const full = readFileSync(resolve(__dirname, "../../../docs/n8n.md"), "utf8");
  const md = full.slice(full.indexOf("## 10. Post each record once"));
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

const operationExists = (method: string, path: string) =>
  OPERATIONS.some((op) => op.method === method && new RegExp(`^${op.path.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(path.replace(/\{\{[^}]+\}\}/g, "x")));

describe("docs/n8n.md § 10 Post each record once", () => {
  it("names only endpoints that exist", () => {
    const blocks = readBlocks();
    expect(blocks.map((b) => `${b.method} ${b.path}`)).toEqual(["POST /generate", "POST /jobs"]);
    for (const b of blocks) expect(operationExists(b.method, b.path), b.path).toBe(true);
  });

  it("tags a generate request, replays on a re-run, and refuses a resubmission after the post is deleted", async () => {
    const env = await postsEnv();
    const account = await env.account({}, true);
    const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Warm and direct." } });
    await testDb().update(projects).set({ defaultVoiceProfileId: profile.id }).where(eq(projects.id, env.project.id));
    const { secret } = await createKey(env.scope, ["read", "write_posts", "generate", "auto_approve"], { rateLimitPerMinute: 1000 });
    const llm = createFakeLlm([{ ok: { variants: { mock: { text: "Row one" } } } }]);
    setLlmForTests(llm);

    const [generate] = readBlocks();
    const vars: Record<string, string> = {
      base: "http://localhost",
      key: secret,
      "row.id": "row-1",
      "row.brief": "Announce row one",
      accountId: account.id,
    };

    const first = await api(generate!.method, fill(generate!.path, vars), {
      key: secret,
      idem: fill(generate!.headers["idempotency-key"] ?? "", vars),
      headers: { "content-type": "application/json" },
      body: fill(generate!.body, vars),
    });
    expect(first.status).toBe(201);
    expect(first.json.alreadyPosted).toBe(false);
    const postId = first.json.post.id;

    const second = await api(generate!.method, fill(generate!.path, vars), {
      key: secret,
      idem: fill(generate!.headers["idempotency-key"] ?? "", { ...vars, "row.id": "row-1-again" }),
      headers: { "content-type": "application/json" },
      body: fill(generate!.body, vars),
    });
    expect(second.status).toBe(200);
    expect(second.json.alreadyPosted).toBe(true);
    expect(second.json.post.id).toBe(postId);
    expect(llm.requests).toHaveLength(1);

    await deletePost(env.scope, postId);
    const third = await api(generate!.method, fill(generate!.path, vars), {
      key: secret,
      idem: fill(generate!.headers["idempotency-key"] ?? "", { ...vars, "row.id": "row-1-again-2" }),
      headers: { "content-type": "application/json" },
      body: fill(generate!.body, vars),
    });
    expect(third.status).toBe(409);
    expect(third.json.error.details.reason).toBe("already_posted_post_deleted");
  });

  it("drops already-posted items on a job create and counts them", async () => {
    const env = await postsEnv();
    const account = await env.account({}, true);
    const profile = await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Warm and direct." } });
    const { secret } = await createKey(env.scope, ["read", "manage_jobs"], { rateLimitPerMinute: 1000 });
    setLlmForTests(createFakeLlm([]));

    const [, jobs] = readBlocks();
    const vars: Record<string, string> = {
      base: "http://localhost",
      key: secret,
      voiceProfileId: profile.id,
      accountId: account.id,
      "batch.id": "batch-1",
    };

    const created = await api(jobs!.method, fill(jobs!.path, vars), {
      key: secret,
      idem: fill(jobs!.headers["idempotency-key"] ?? "", vars),
      headers: { "content-type": "application/json" },
      body: fill(jobs!.body, vars),
    });
    expect(created.status).toBe(201);
    expect(created.json.skippedAlreadyPosted).toBe(0);
    expect(created.json.itemCount).toBe(2);

    // Both ids become posts elsewhere (another flow run, or this job's own runner) before the batch is resent.
    const { post: post1 } = await createDraftPost(env.project.id);
    const { post: post2 } = await createDraftPost(env.project.id);
    await env.scope.externalClaims.insert({ sourceKey: "crm", externalId: "row-1", postId: post1.id, claimedAt: new Date() });
    await env.scope.externalClaims.insert({ sourceKey: "crm", externalId: "row-2", postId: post2.id, claimedAt: new Date() });

    const resubmitted = await api(jobs!.method, fill(jobs!.path, vars), {
      key: secret,
      idem: fill(jobs!.headers["idempotency-key"] ?? "", { ...vars, "batch.id": "batch-2" }),
      headers: { "content-type": "application/json" },
      body: fill(jobs!.body, vars),
    });
    expect(resubmitted.status).toBe(400);
    expect(resubmitted.json.error.details).toMatchObject([{ code: "already_posted", field: "source.items" }]);
  });
});
