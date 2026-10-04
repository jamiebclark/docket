import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { connectAttempts } from "../../../src/server/db/schema";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { createConnectAttemptsRepo } from "../../../src/server/dal/connect-attempts";
import { lookupByStateHash, purgeExpiredConnectAttempts } from "../../../src/server/dal/connect-attempts";
import { closeDb, testDb } from "../../helpers/db";
import { createProject, createSession, createUser } from "../../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const hash = () => createHash("sha256").update(randomBytes(32)).digest("hex");
const minutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);

async function setup() {
  const project = await createProject();
  const other = await createProject();
  const user = await createUser();
  const session = await createSession(user.id);
  const otherSession = await createSession(user.id);
  const now = new Date();
  const repo = createConnectAttemptsRepo(testDb(), project.id);
  const bind = { userId: user.id, sessionId: session.id, now };
  const start = (stateHash = hash(), expiresAt = minutes(now, 10)) =>
    repo.create({ userId: user.id, sessionId: session.id, groupKey: "meta", stateHash, expiresAt });
  return { project, other, user, session, otherSession, now, repo, bind, start };
}

describe("connect attempts repository", () => {
  it("pins every method to its project", async () => {
    const { other, bind, repo, start } = await setup();
    const { id } = await start();
    const foreign = createConnectAttemptsRepo(testDb(), other.id);
    expect(await foreign.consumeState(id, bind)).toBe(false);
    expect(await repo.consumeState(id, bind)).toBe(true);
    expect(await foreign.storeCandidates(id, "enc:v1:x")).toBe(false);
    expect(await repo.storeCandidates(id, "enc:v1:x")).toBe(true);
    expect(await foreign.getReady(id, bind)).toBeNull();
    expect((await repo.getReady(id, bind))?.id).toBe(id);
  });

  it("requires the same user and session", async () => {
    const { otherSession, bind, repo, start } = await setup();
    const { id } = await start();
    expect(await repo.consumeState(id, { ...bind, sessionId: otherSession.id })).toBe(false);
    expect(await repo.consumeState(id, { ...bind, userId: (await createUser()).id })).toBe(false);
    expect(await repo.consumeState(id, bind)).toBe(true);
  });

  it("consumes state once: two parallel callbacks get one winner", async () => {
    const { bind, repo, start } = await setup();
    const { id } = await start();
    const results = await Promise.all([repo.consumeState(id, bind), repo.consumeState(id, bind)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await repo.consumeState(id, bind)).toBe(false);
  });

  it("is unreadable once expired", async () => {
    const { now, bind, repo, start } = await setup();
    const { id } = await start(hash(), minutes(now, 10));
    expect(await repo.consumeState(id, bind)).toBe(true);
    await repo.storeCandidates(id, "enc:v1:x");
    expect(await repo.getReady(id, { ...bind, now: minutes(now, 11) })).toBeNull();
    const second = await start(hash(), minutes(now, -1));
    expect(await repo.consumeState(second.id, bind)).toBe(false);
  });

  it("serves only ready attempts, and completion discards the ciphertext", async () => {
    const { now, bind, repo, start } = await setup();
    const { id } = await start();
    expect(await repo.getReady(id, bind)).toBeNull();
    await repo.consumeState(id, bind);
    expect(await repo.getReady(id, bind)).toBeNull();
    await repo.storeCandidates(id, "enc:v1:x");
    expect(await repo.getReady(id, bind)).not.toBeNull();
    await repo.complete(id, now);
    expect(await repo.getReady(id, bind)).toBeNull();
    const [row] = await runCrossProject("test: read", async () =>
      await testDb().select().from(connectAttempts).where(eq(connectAttempts.id, id)),
    );
    expect(row?.candidatesEncrypted).toBeNull();
    expect(row?.completedAt).not.toBeNull();
  });

  it("creates a ready attempt for a paste, encrypting with the new id", async () => {
    const { user, session, now, bind, repo } = await setup();
    let seen = "";
    const { id } = await repo.createReady({
      userId: user.id,
      sessionId: session.id,
      groupKey: "meta",
      stateHash: hash(),
      expiresAt: minutes(now, 10),
      encrypt: (attemptId) => {
        seen = attemptId;
        return `enc:v1:${attemptId}`;
      },
    });
    expect(seen).toBe(id);
    expect((await repo.getReady(id, bind))?.candidatesEncrypted).toBe(`enc:v1:${id}`);
  });

  it("looks up by state hash across projects and purges attempts expired over an hour", async () => {
    const { project, now, start } = await setup();
    const stateHash = hash();
    const { id } = await start(stateHash);
    const found = await lookupByStateHash(stateHash, testDb());
    expect(found).toMatchObject({ id, projectId: project.id, projectSlug: project.slug, groupKey: "meta" });
    expect(await lookupByStateHash(hash(), testDb())).toBeNull();

    const old = await start(hash(), minutes(now, -90));
    const recent = await start(hash(), minutes(now, -30));
    await purgeExpiredConnectAttempts(now, testDb());
    const ids = await runCrossProject("test: read", async () =>
      (await testDb().select({ id: connectAttempts.id }).from(connectAttempts)).map((r) => r.id),
    );
    expect(ids).not.toContain(old.id);
    expect(ids).toContain(recent.id);
    expect(ids).toContain(id);
  });
});
