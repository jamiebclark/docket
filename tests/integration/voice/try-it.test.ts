import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ConflictError } from "../../../src/server/dal/errors";
import * as voice from "../../../src/server/services/voice";
import { closeDb, testDb } from "../../helpers/db";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { postsEnv } from "../../helpers/posts-env";
import { clearRecordedQueries } from "../../setup/scope-recorder";

afterAll(closeDb);

const ok = (variants: Record<string, string>): FakeStep => ({
  ok: { variants: Object.fromEntries(Object.entries(variants).map(([k, text]) => [k, { text }])) },
});

async function rowCounts(): Promise<Record<string, number>> {
  const db = testDb();
  const tables = await db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
  );
  const out: Record<string, number> = {};
  for (const { table_name } of tables.rows) {
    const res = await db.execute<{ n: string }>(sql.raw(`select count(*)::text as n from "${table_name}"`));
    out[table_name] = Number(res.rows[0]!.n);
  }
  // The counts are deliberately unscoped (all tables): keep them out of the scope check.
  clearRecordedQueries();
  return out;
}

async function setup() {
  const env = await postsEnv();
  const { profileId } = await voice.createVoiceProfile(env.scope, {
    name: "Brand",
    content: { voiceAndTone: "SAVED-TONE" },
  });
  const current = await voice.getVoiceProfile(env.scope, profileId);
  return { env, versionId: current.current.id };
}

describe("tryVoice", () => {
  it("returns a variant per platform with counts and writes nothing", async () => {
    const { env, versionId } = await setup();
    const llm = createFakeLlm([ok({ bluesky: "Hello Bluesky", threads: "Hello Threads" })]);
    const before = await rowCounts();
    const res = await voice.tryVoice(env.scope, { brief: "Say hi", providerKeys: ["bluesky", "threads"], versionId }, llm);
    expect(await rowCounts()).toEqual(before);
    expect(res.variants.map((v) => v.providerKey)).toEqual(["bluesky", "threads"]);
    expect(res.variants[0]).toMatchObject({ text: "Hello Bluesky", count: 13, issues: [] });
    expect(res.variants[0]!.limit).toBeGreaterThan(0);
    expect(res.latencyMs).toBeGreaterThan(0);
    expect(llm.requests.length).toBeLessThanOrEqual(2);
  });

  it("uses an owner's unsaved draft, but an editor's draft is ignored for the saved version", async () => {
    const { env, versionId } = await setup();
    const draft = { voiceAndTone: "DRAFT-TONE" };
    const ownerLlm = createFakeLlm([ok({ bluesky: "x" })]);
    await voice.tryVoice(env.scope, { brief: "b", providerKeys: ["bluesky"], draft, versionId }, ownerLlm);
    expect(ownerLlm.requests[0]!.system + ownerLlm.requests[0]!.user).toContain("DRAFT-TONE");

    const editorLlm = createFakeLlm([ok({ bluesky: "x" })]);
    const editor = await env.as(env.editor);
    await voice.tryVoice(editor, { brief: "b", providerKeys: ["bluesky"], draft, versionId }, editorLlm);
    const prompt = editorLlm.requests[0]!.system + editorLlm.requests[0]!.user;
    expect(prompt).toContain("SAVED-TONE");
    expect(prompt).not.toContain("DRAFT-TONE");
  });

  it("surfaces a failed call as a plain message and writes nothing", async () => {
    const { env, versionId } = await setup();
    const before = await rowCounts();
    const llm = createFakeLlm([{ fail: "timeout" }, { fail: "timeout" }]);
    await expect(voice.tryVoice(env.scope, { brief: "b", providerKeys: ["bluesky"], versionId }, llm)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(llm.requests.length).toBeLessThanOrEqual(2);
    expect(await rowCounts()).toEqual(before);
  });
});
