import { afterAll, describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { POST } from "../../src/app/api/auth/[...all]/route";
import { closeDb, getDb } from "../../src/server/db/client";
import { forProject } from "../../src/server/dal/scope";
import { runCrossProject } from "../../src/server/db/cross-project";
import { account, user } from "../../src/server/db/schema";
import * as invitations from "../../src/server/services/invitations";
import { fakeSession } from "../helpers/auth";
import { createProjectWithMembers } from "../helpers/factories";

const ORIGIN = "http://localhost:3000";

function post(path: string, body: unknown, ip = "203.0.113.7"): Promise<Response> {
  return POST(
    new Request(`${ORIGIN}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
  );
}

afterAll(async () => {
  await closeDb();
});

describe("Better Auth HTTP surface", () => {
  it("rejects public sign-up with 400 and creates no user", async () => {
    const db = getDb();
    const [before] = await db.select({ n: count() }).from(user);
    const res = await post("/sign-up/email", { name: "X", email: "nobody@example.com", password: "long-enough-password" });
    expect(res.status).toBe(400);
    const [after] = await db.select({ n: count() }).from(user);
    expect(after?.n).toBe(before?.n);
    expect(await db.select().from(user).where(eq(user.email, "nobody@example.com"))).toHaveLength(0);
  });

  it("rejects sign-up over HTTP even with a valid invitation token (SC-004)", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const email = `http-${Date.now()}@example.com`;
    const { delivery } = await invitations.create(scope, { email, role: "editor" });
    if (delivery.kind !== "manual_link") throw new Error("expected a manual link");
    const token = new URL(delivery.url).searchParams.get("token")!;
    const body = { name: "X", email, password: "long-enough-password" };
    for (const path of [`/sign-up/email?token=${token}`, "/sign-up/email"]) {
      const res = await post(path, { ...body, token });
      expect(res.status).toBe(400);
    }
    expect(await runCrossProject("test", () => getDb().select().from(user).where(eq(user.email, email)))).toHaveLength(0);
    // The invitation is still usable through Docket's own sign-up.
    expect((await invitations.resolveToken(token)).state).toBe("signup");
  });

  it("hides organization endpoints with 404", async () => {
    const res = await post("/organization/create", { name: "x", slug: "x" });
    expect(res.status).toBe(404);
  });

  it("gives the same generic failure for unknown email and wrong password", async () => {
    const db = getDb();
    const [u] = await db
      .insert(user)
      .values({ name: "Known", email: "known@example.com", emailVerified: false })
      .returning({ id: user.id });
    await db.insert(account).values({
      userId: u!.id,
      accountId: u!.id,
      providerId: "credential",
      password: await hashPassword("the-right-password"),
    });
    try {
      const unknown = await post("/sign-in/email", { email: "ghost@example.com", password: "whatever-password" }, "198.51.100.1");
      const wrong = await post("/sign-in/email", { email: "known@example.com", password: "wrong-password-here" }, "198.51.100.2");
      expect(unknown.status).toBe(401);
      expect(wrong.status).toBe(401);
      const a = (await unknown.json()) as { code?: string };
      const b = (await wrong.json()) as { code?: string };
      expect(a.code).toBe("INVALID_EMAIL_OR_PASSWORD");
      expect(b.code).toBe("INVALID_EMAIL_OR_PASSWORD");
    } finally {
      await db.delete(user).where(eq(user.id, u!.id));
    }
  });

  it("rate-limits the 4th sign-in within 10 seconds", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await post("/sign-in/email", { email: "limit@example.com", password: "whatever-password" }, "192.0.2.99");
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
    expect(statuses[3]).toBe(429);
  });

  it("limits sign-in per email even when every try claims a different client IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await post("/sign-in/email", { email: "spread@example.com", password: "whatever-password" }, `203.0.113.${100 + i}`);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
    expect(statuses[3]).toBe(429);
  });

  it("keeps other emails signing in after failures behind a two-entry forwarded header", async () => {
    const db = getDb();
    const [u] = await db
      .insert(user)
      .values({ name: "Other", email: "other-ok@example.com", emailVerified: false })
      .returning({ id: user.id });
    await db.insert(account).values({
      userId: u!.id,
      accountId: u!.id,
      providerId: "credential",
      password: await hashPassword("the-right-password"),
    });
    try {
      const shared = "198.51.100.50, 198.51.100.51";
      for (let i = 0; i < 3; i++) {
        const res = await post("/sign-in/email", { email: "victim@example.com", password: "wrong-password-here" }, shared);
        expect(res.status).toBe(401);
      }
      const ok = await post("/sign-in/email", { email: "other-ok@example.com", password: "the-right-password" }, shared);
      expect(ok.status).toBe(200);
    } finally {
      await db.delete(user).where(eq(user.id, u!.id));
    }
  });
});
