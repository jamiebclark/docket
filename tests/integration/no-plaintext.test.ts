import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { forProject } from "../../src/server/dal/scope";
import { bootstrapFirstUser } from "../../src/server/dal/install";
import { runCrossProject } from "../../src/server/db/cross-project";
import * as invitations from "../../src/server/services/invitations";
import * as members from "../../src/server/services/members";
import * as accounts from "../../src/server/services/accounts";
import * as posts from "../../src/server/services/posts";
import * as slots from "../../src/server/services/slots";
import { mockProvider } from "../../src/providers/mock";
import { runTick } from "../../src/server/scheduler";
import { atTime } from "../helpers/clock";
import { parkAllDueTargets } from "../helpers/scheduling";
import { fakeSession } from "../helpers/auth";
import { closeDb, createThrowawayDb, testDb } from "../helpers/db";
import { createProjectWithMembers } from "../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const APP_PASSWORD = "bsky-app-password-canary-3";

const PASSWORD = "plaintext-canary-password-1";
const SETUP_PASSWORD = "setup-canary-password-2";

describe("SC-009: no plaintext secrets at rest or in logs", () => {
  it("never stores or logs tokens, passwords or the encryption key", async () => {
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      }),
    );
    const secrets: string[] = [PASSWORD, SETUP_PASSWORD, process.env.CREDENTIALS_ENCRYPTION_KEY!, process.env.BETTER_AUTH_SECRET!];
    const tmp = await createThrowawayDb();
    try {
      // Setup flow (isolated database).
      await bootstrapFirstUser({ name: "Setup", email: "setup@example.test", password: SETUP_PASSWORD }, tmp.db);

      // Invitation, regenerate, sign-up and member flows.
      const ctx = await createProjectWithMembers();
      const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
      const first = await invitations.create(scope, { email: `canary-${Date.now()}@example.test`, role: "editor" });
      if (first.delivery.kind !== "manual_link") throw new Error("expected a manual link");
      const firstToken = new URL(first.delivery.url).searchParams.get("token")!;
      const next = await invitations.regenerate(scope, { invitationId: first.invitationId });
      if (next.delivery.kind !== "manual_link") throw new Error("expected a manual link");
      const token = new URL(next.delivery.url).searchParams.get("token")!;
      secrets.push(firstToken, token);
      const { userId } = await invitations.signUp({ token, name: "Canary", password: PASSWORD });
      const owner = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
      await members.changeRole(owner, { userId, role: "admin" });
      await members.remove(owner, { userId });

      // Scan every table (both databases) as text.
      const scan = async (db: ReturnType<typeof testDb>) => {
        const tables = await db.execute<{ table_name: string }>(
          sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
        );
        const hits: string[] = [];
        for (const { table_name } of tables.rows) {
          const dump = await db.execute<{ r: string }>(sql.raw(`select t::text as r from "${table_name}" t`));
          for (const row of dump.rows) for (const s of secrets) if (row.r.includes(s)) hits.push(`${table_name} contains a secret`);
        }
        return hits;
      };
      const hits = [
        ...(await runCrossProject("test: scan all tables for plaintext", () => scan(testDb()))),
        ...(await runCrossProject("test: scan all tables for plaintext", () => scan(tmp.db))),
      ];
      expect(hits).toEqual([]);

      const logText = logged.join("\n");
      for (const s of secrets) expect(logText.includes(s)).toBe(false);
    } finally {
      spies.forEach((s) => s.mockRestore());
      await tmp.drop();
    }
  });
});

describe("SC-012: no stored credentials in attempts, errors, summaries or listings", () => {
  const BEFORE = new Date("2026-10-01T12:00:00Z");
  const SLOT = new Date("2026-10-05T09:00:00Z");

  it("redacts a secret that a provider echoes in a thrown message, an error and a summary", async () => {
    await parkAllDueTargets();
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      }),
    );
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const leaked: string[] = [];
    const modes = ["throw", "retryable_error", "fatal_error", "ambiguous"] as const;
    const advance = vi.spyOn(mockProvider, "advance");
    try {
      const targetIds: string[] = [];
      const postIds: string[] = [];
      for (const mode of modes) {
        const account = await accounts.connectMock(scope, { displayName: `Leaky ${mode}`, simulateCredentialExpiryHours: 48 });
        await slots.addSlot(scope, { accountId: account.id, weekday: 1, localTime: "09:00" });
        advance.mockImplementationOnce(async (c) => {
          const secret = (c.account.credentials as { token: string }).token;
          leaked.push(secret);
          const message = `request failed with Bearer ${secret}`;
          if (mode === "throw") throw new Error(message);
          return {
            kind: mode,
            error: message,
            summary: { request: { note: message }, response: { body: message, token: secret } },
          };
        });
        const draft = await posts.createDraft(scope, { baseText: `Leak ${mode}`, targets: [{ accountId: account.id }] });
        await atTime(BEFORE, () => posts.addToQueue(scope, draft.post.id, {}));
        postIds.push(draft.post.id);
        targetIds.push(draft.targets[0]!.id);
        // One at a time so each mocked call lands on its own account.
        const tick = await atTime(SLOT, () => runTick({ config: { refreshMaxAccounts: 0 } }));
        expect(JSON.stringify(tick)).not.toContain(leaked.at(-1)!);
      }
      expect(leaked).toHaveLength(modes.length);

      const surfaces: string[] = [JSON.stringify(await accounts.listAccounts(scope))];
      for (const [i, postId] of postIds.entries()) {
        surfaces.push(JSON.stringify(await posts.getPost(scope, postId)));
        surfaces.push(JSON.stringify(await posts.listAttempts(scope, targetIds[i]!)));
        surfaces.push(JSON.stringify(await posts.getPostView(scope, postId))); // post detail page (SC-011)
      }
      surfaces.push(JSON.stringify(await posts.listPosts(scope, {})));
      surfaces.push(logged.join("\n"));
      const stored = await runCrossProject("test: scan stored rows for credentials", async () => {
        const db = testDb();
        const out: string[] = [];
        for (const table of ["post_targets", "publish_attempts", "social_accounts"]) {
          const dump = await db.execute<{ r: string }>(sql.raw(`select t::text as r from "${table}" t`));
          out.push(...dump.rows.map((row) => row.r));
        }
        return out;
      });
      surfaces.push(...stored);
      for (const secret of leaked) for (const text of surfaces) expect(text.includes(secret)).toBe(false);
    } finally {
      advance.mockRestore();
      spies.forEach((s) => s.mockRestore());
    }
  });
});

describe("SC-011: storage credentials never reach media results, logs or rendered output", () => {
  it("keeps the access key and secret out of upload/library/delete results and logs", async () => {
    const { TEST_S3_CONFIG, createMemoryStorage } = await import("../helpers/storage");
    const { setStorageForTests } = await import("../../src/server/storage");
    const media = await import("../../src/server/services/media");
    const { png, corruptBytes } = await import("../helpers/images");
    const { postsEnv } = await import("../helpers/posts-env");
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { MediaCard } = await import("../../src/components/media/MediaCard");

    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      }),
    );
    const storage = createMemoryStorage();
    // Every object operation fails with a message that echoes the credentials, as an SDK error could.
    const leak = `AccessDenied key=${TEST_S3_CONFIG.accessKeyId} secret=${TEST_S3_CONFIG.secretAccessKey}`;
    setStorageForTests(storage);
    try {
      const { scope } = await postsEnv();
      const ok = await media.uploadMedia(scope, { file: { name: "a.png", bytes: await png() } });
      const rejected = await media.uploadMedia(scope, { file: { name: "b.jpg", bytes: corruptBytes() } });
      if (!ok.ok) throw new Error("upload failed");
      storage.delete = async () => {
        throw new Error(leak);
      };
      const list = await media.listMedia(scope);
      const detail = await media.getMedia(scope, ok.asset.id);
      const impact = await media.deleteMediaImpact(scope, ok.asset.id);
      const deleted = await media.deleteMedia(scope, ok.asset.id);
      const html = renderToStaticMarkup(createElement(MediaCard, { item: list.items[0]! }));
      const everything = JSON.stringify([ok, rejected, list, detail, impact, deleted]) + html + logged.join("\n");
      for (const secret of [TEST_S3_CONFIG.accessKeyId, TEST_S3_CONFIG.secretAccessKey]) {
        expect(everything).not.toContain(secret);
      }
      expect(logged.length).toBeGreaterThan(0);
    } finally {
      setStorageForTests(undefined);
      for (const s of spies) s.mockRestore();
    }
  });
});

describe("an app password is never stored, returned or logged", () => {
  it("connect by credentials keeps the app password out of every row, result and log line", async () => {
    const { createFakePds, mintJwt } = await import("../helpers/fake-pds");
    const pds = createFakePds().route("POST", "/xrpc/com.atproto.server.createSession", {
      json: {
        accessJwt: mintJwt(new Date("2030-01-01T00:00:00Z")),
        refreshJwt: mintJwt(new Date("2030-03-01T00:00:00Z")),
        did: "did:plc:canary",
        handle: "canary.bsky.social",
      },
    });
    vi.stubGlobal("fetch", pds.fetch);
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      }),
    );
    try {
      const ctx = await createProjectWithMembers();
      const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
      const out = await accounts.connectWithCredentials(scope, {
        providerKey: "bluesky",
        fields: { handle: "canary.bsky.social", appPassword: APP_PASSWORD },
      });
      expect(out.ok).toBe(true);
      expect(JSON.stringify(out)).not.toContain(APP_PASSWORD);
      expect(JSON.stringify(await accounts.listAccounts(scope))).not.toMatch(/accessJwt|refreshJwt/);
      expect(logged.join("\n")).not.toContain(APP_PASSWORD);
      const dumps = await runCrossProject("test: scan all tables for the app password", async () => {
        const db = testDb();
        const tables = await db.execute<{ table_name: string }>(
          sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
        );
        const hits: string[] = [];
        for (const { table_name } of tables.rows) {
          const dump = await db.execute<{ r: string }>(sql.raw(`select t::text as r from "${table_name}" t`));
          if (dump.rows.some((row) => row.r.includes(APP_PASSWORD))) hits.push(table_name);
        }
        return hits;
      });
      expect(dumps).toEqual([]);
    } finally {
      spies.forEach((s) => s.mockRestore());
      vi.unstubAllGlobals();
    }
  });
});

describe("Meta tokens are ciphertext only", () => {
  it("keeps the Page token out of every column except credentials_encrypted and candidates_encrypted", async () => {
    const [{ createFakeGraph }, connect, { sessionFor }, { postsEnv }, { clearRecordedQueries }] = await Promise.all([
      import("../helpers/fake-graph"),
      import("../../src/server/services/connect"),
      import("../helpers/connect-group"),
      import("../helpers/posts-env"),
      import("../setup/scope-recorder"),
    ]);
    const PAGE_TOKEN = "EAAG-canary-page-token-7";
    vi.stubEnv("META_APP_ID", "12345");
    vi.stubEnv("META_APP_SECRET", "canary-app-secret-8");
    vi.stubEnv("META_GRAPH_VERSION", "v26.0");
    const fake = createFakeGraph();
    fake.install();
    try {
      fake.on("GET", "/v26.0/oauth/access_token", [
        { kind: "ok", body: { access_token: "short" } },
        { kind: "ok", body: { access_token: "long" } },
      ]);
      fake.on("GET", "/v26.0/me/accounts", { kind: "ok", body: { data: [{ id: "100", name: "Acme", access_token: PAGE_TOKEN }] } });
      const env = await postsEnv();
      const session = await sessionFor(env.owner.id);
      const { url } = await connect.startOAuthConnect(env.scope, { groupKey: "meta" }, session);
      const state = new URL(url).searchParams.get("state")!;
      const out = await connect.handleOAuthCallback(new URLSearchParams({ state, code: "c" }), { userId: env.owner.id, sessionId: session.sessionId });
      if (out.kind !== "chooser") throw new Error("expected chooser");
      // Pending: the token exists only inside candidates_encrypted.
      const pending = await testDb().execute(sql`select to_jsonb(a) - 'candidates_encrypted' as r from connect_attempts a where id = ${out.attemptId}`);
      expect(JSON.stringify(pending.rows)).not.toContain(PAGE_TOKEN);
      const chosen = await connect.chooseConnectCandidates(env.scope, { attemptId: out.attemptId, selected: ["facebook:100"] }, session);
      expect(chosen.ok).toBe(true);
      const saved = await testDb().execute(sql`select to_jsonb(a) - 'credentials_encrypted' as r from social_accounts a where project_id = ${env.project.id}`);
      expect(saved.rows.length).toBe(1);
      expect(JSON.stringify(saved.rows)).not.toContain(PAGE_TOKEN);
      const cipher = await testDb().execute(sql`select credentials_encrypted as c from social_accounts where project_id = ${env.project.id}`);
      expect(String((cipher.rows[0] as { c: string }).c)).not.toContain(PAGE_TOKEN);
      clearRecordedQueries();
    } finally {
      fake.uninstall();
      vi.unstubAllEnvs();
    }
  });
});
