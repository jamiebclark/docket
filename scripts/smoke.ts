// Smoke test for a running stack (research D29). Run by hand:
//   docker compose run --rm worker node scripts/smoke.mjs
// It drives services and HTTP, never server actions. Not part of CI. Never runs at import.
import { eq } from "drizzle-orm";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getDb } from "../src/server/db/client";
import { user } from "../src/server/db/schema";
import { forProject } from "../src/server/dal/scope";
import { closeDb } from "../src/server/dal";
import * as setup from "../src/server/services/setup";
import * as projects from "../src/server/services/projects";
import * as accounts from "../src/server/services/accounts";
import * as posts from "../src/server/services/posts";
import { getSchedulerHealth } from "../src/server/services/scheduler-health";

const WAIT_HEALTH_MS = 90_000;
const WAIT_PUBLISH_MS = 60_000;
const MAX_TICK_AGE_MS = 2 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class StepFailed extends Error {}

function ok(step: string, detail: string) {
  console.log(`✓ ${step} — ${detail}`);
}

async function step<T>(name: string, fn: () => Promise<{ detail: string; value: T }>): Promise<T> {
  try {
    const { detail, value } = await fn();
    ok(name, detail);
    return value;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.log(`✗ ${name} — ${reason}`);
    throw new StepFailed(reason);
  }
}

function fail(message: string): never {
  throw new Error(message);
}

async function findOrCreateUser(): Promise<{ id: string; email: string }> {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase();
  const db = getDb();
  if (email) {
    const [row] = await db.select({ id: user.id, email: user.email }).from(user).where(eq(user.email, email)).limit(1);
    if (row) return row;
  }
  if (!(await setup.isAvailable())) {
    const [any] = await db.select({ id: user.id, email: user.email }).from(user).limit(1);
    if (any) return any;
    fail("no user exists and setup is unavailable");
  }
  const created = await setup.createFirstUser({
    name: "Smoke",
    email: email ?? "smoke@example.com",
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? crypto.randomUUID(),
  });
  return { id: created.userId, email: created.email };
}

export async function main(): Promise<number> {
  const base = (process.env.SMOKE_BASE_URL ?? "http://web:3000").replace(/\/$/, "");
  try {
    await step("health", async () => {
      const deadline = Date.now() + WAIT_HEALTH_MS;
      for (;;) {
        try {
          const res = await fetch(`${base}/api/health`);
          if (res.ok) return { detail: `${base}/api/health answered 200`, value: null };
        } catch {
          // not up yet
        }
        if (Date.now() > deadline) fail(`${base}/api/health did not answer within ${WAIT_HEALTH_MS / 1000} s`);
        await sleep(2_000);
      }
    });

    const smokeUser = await step("user", async () => {
      const u = await findOrCreateUser();
      return { detail: "smoke user ready", value: u };
    });
    const session = { user: { id: smokeUser.id } };

    const slug = await step("project", async () => {
      const stamp = new Date().toISOString().slice(0, 10);
      const made = await projects.create(session, {
        name: `smoke ${stamp}`,
        slug: `smoke-${stamp}-${Math.random().toString(36).slice(2, 7)}`,
        timezone: "UTC",
      });
      return { detail: `created ${made.slug}`, value: made.slug };
    });
    const scope = await forProject(session, slug);

    const account = await step("mock account", async () => {
      const a = await accounts.connectMock(scope, { displayName: "Smoke mock" });
      return { detail: "connected (set MOCK_PROVIDER_ENABLED=true if this fails)", value: a };
    });

    const postId = await step("publish now", async () => {
      const draft = await posts.createDraft(scope, {
        baseText: `Docket smoke post ${new Date().toISOString()}`,
        targets: [{ accountId: account.id }],
      });
      await posts.publishNow(scope, draft.post.id);
      return { detail: "queued for the worker", value: draft.post.id };
    });

    await step("worker publishes", async () => {
      const deadline = Date.now() + WAIT_PUBLISH_MS;
      for (;;) {
        const detail = await posts.getPost(scope, postId);
        const statuses = detail.targets.map((t) => t.status);
        if (statuses.length > 0 && statuses.every((s) => s === "published")) {
          return { detail: "published by the running worker", value: null };
        }
        if (statuses.some((s) => s === "failed" || s === "ambiguous")) fail(`target ended as ${statuses.join(", ")}`);
        if (Date.now() > deadline) fail(`not published within ${WAIT_PUBLISH_MS / 1000} s (is the worker running?)`);
        await sleep(2_000);
      }
    });

    await step("scheduler health", async () => {
      const health = await getSchedulerHealth(scope);
      if (!health.lastSuccessAt) fail("no successful tick recorded");
      const age = Date.now() - new Date(health.lastSuccessAt).getTime();
      if (age > MAX_TICK_AGE_MS) fail(`last tick ${Math.round(age / 1000)} s ago`);
      return { detail: `last tick ${Math.max(0, Math.round(age / 1000))} s ago`, value: null };
    });

    await step("security headers", async () => {
      const res = await fetch(`${base}/login`, { redirect: "manual" });
      const missing = ["content-security-policy", "x-content-type-options"].filter((h) => !res.headers.get(h));
      if (missing.length) fail(`/login is missing ${missing.join(", ")}`);
      return { detail: "/login carries CSP and nosniff", value: null };
    });

    await step("tick requires secret", async () => {
      const res = await fetch(`${base}/api/internal/tick`, { method: "POST" });
      if (res.status !== 401) fail(`expected 401 without the secret, got ${res.status}`);
      return { detail: "401 without the secret", value: null };
    });

    await step("cross-origin refused", async () => {
      const res = await fetch(`${base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ email: "x@example.com", password: "x" }),
      });
      if (res.status !== 403) fail(`expected 403 for a cross-origin POST, got ${res.status}`);
      return { detail: "403 for a cross-origin POST", value: null };
    });

    return 0;
  } catch (e) {
    if (!(e instanceof StepFailed)) console.log(`✗ smoke — ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await closeDb().catch(() => undefined);
  }
}

const invoked = process.argv[1] ? safeReal(process.argv[1]) : null;
function safeReal(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code));
}
