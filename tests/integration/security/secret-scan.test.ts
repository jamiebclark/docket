import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Distinctive fake values for every secret the deployment holds. Set before any module reads the environment.
const ENV = vi.hoisted(() => {
  const values = {
    BETTER_AUTH_SECRET: "scan-auth-secret-7f3a91c2d8e45b60a1f2c3d4e5f60718",
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 0x5a).toString("base64"),
    TICK_SECRET: "scan-tick-secret-b81d0e47c9a2f356d0e1a2b3c4d5e6f7",
    S3_BUCKET: "scan-bucket",
    S3_ACCESS_KEY_ID: "SCANACCESSKEYID0042",
    S3_SECRET_ACCESS_KEY: "scan-s3-secret-access-key-c4d2e8f1a6b30957",
    S3_PUBLIC_BASE_URL: "https://media.example.test",
    S3_ENDPOINT: "http://127.0.0.1:1",
    OPENAI_API_KEY: "sk-scan-openai-0a1b2c3d4e5f60718293a4b5c6d7e8f9",
    ANTHROPIC_API_KEY: "sk-ant-scan-1f2e3d4c5b6a79880a1b2c3d4e5f6071",
    META_APP_ID: "730194628105",
    META_APP_SECRET: "scanmetaappsecret9c1e7a40b2d5f836",
    THREADS_APP_ID: "481726350917",
    THREADS_APP_SECRET: "scanthreadsappsecret5b8e2c90d4a1f7",
    THREADS_GRAPH_BASE: "https://graph.threads.test",
    // Meta and Threads refuse a callback address that is not public HTTPS, so the scanned run uses one.
    BETTER_AUTH_URL: "https://docket.scan.test",
    SMTP_HOST: "smtp.scan.test",
    SMTP_FROM: "scan-from@example.test",
    SMTP_USER: "scan-smtp-user-4a1e7c902b",
    SMTP_PASSWORD: "scan-smtp-password-f3a8c9d1e6b50473",
  };
  Object.assign(process.env, values);
  return values;
});

const session = vi.hoisted(() => ({ current: null as { user: { id: string }; session: { id: string } } | null }));
vi.mock("@/server/auth/session", () => ({ getSession: async () => session.current }));
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => ({
  ...(await import("../../helpers/actions")).navigationModule,
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import AccountsPage from "../../../src/app/p/[projectSlug]/accounts/page";
import ApiKeysPage from "../../../src/app/p/[projectSlug]/settings/api-keys/page";
import MembersPage from "../../../src/app/p/[projectSlug]/settings/members/page";
import WebhooksPage from "../../../src/app/p/[projectSlug]/settings/webhooks/page";
import FailuresPage from "../../../src/app/p/[projectSlug]/failures/page";
import InboxPage from "../../../src/app/p/[projectSlug]/inbox/page";
import InboxItemPage from "../../../src/app/p/[projectSlug]/inbox/[itemId]/page";
import ReviewPage from "../../../src/app/p/[projectSlug]/review/page";
import { requestDraft, writeReply } from "../../../src/server/services/engagement/draft";
import { approveReply } from "../../../src/server/services/engagement/review";
import { listInbox } from "../../../src/server/services/engagement/inbox";
import { POST as composeCheck } from "../../../src/app/p/[projectSlug]/compose/check/route";
import { GET as authGet, POST as authPost } from "../../../src/app/api/auth/[...all]/route";
import { GET as health } from "../../../src/app/api/health/route";
import { POST as tickPost } from "../../../src/app/api/internal/tick/route";
import PostPage from "../../../src/app/p/[projectSlug]/posts/[postId]/page";
import JobsPage from "../../../src/app/p/[projectSlug]/jobs/page";
import JobPage from "../../../src/app/p/[projectSlug]/jobs/[jobId]/page";
import { connectAttempts, installState, llmCallUsage, membershipAuditLog, projectLlmSettings, session as sessionTable, user } from "../../../src/server/db/schema";
import { publishAttempts } from "../../../src/server/db/schema/attempts";
import { postTargets } from "../../../src/server/db/schema/posts";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { createAnthropicProvider } from "../../../src/server/llm/anthropic";
import { createOpenAiProvider } from "../../../src/server/llm/openai";
import type { LlmConfig } from "../../../src/server/llm/config";
import { setLlmForTests, setLlmFactoryForTests } from "../../../src/server/llm";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import { importDatedList } from "../../../src/server/services/standing-series/dated-import";
import StandingSeriesDetailPage from "../../../src/app/p/[projectSlug]/jobs/series/[seriesId]/page";
import ModelPage from "../../../src/app/p/[projectSlug]/settings/model/page";
import UsagePage from "../../../src/app/p/[projectSlug]/settings/usage/page";
import MediaPage from "../../../src/app/p/[projectSlug]/media/page";
import { saveProjectModel, removeProjectModel, checkProjectModel } from "../../../src/app/p/[projectSlug]/settings/model/actions";
import { generateImage } from "../../../src/server/services/media-generate";
import { setImageProviderForTests } from "../../../src/server/llm/image-provider";
import { createFakeImageProvider } from "../../helpers/fake-image";
import { png } from "../../helpers/images";
import { NotFoundSignal } from "../../helpers/actions";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import * as connect from "../../../src/server/services/connect";
import { generateSingle } from "../../../src/server/services/generation/single";
import { createJob } from "../../../src/server/services/jobs";
import * as posts from "../../../src/server/services/posts";
import * as projectsService from "../../../src/server/services/projects";
import * as setup from "../../../src/server/services/setup";
import * as slots from "../../../src/server/services/slots";
import * as invitations from "../../../src/server/services/invitations";
import { hashApiKey } from "../../../src/server/dal/api-keys";
import { createApiKey } from "../../../src/server/services/api-keys";
import { setStorageForTests } from "../../../src/server/storage";
import { api } from "../../helpers/api";
import { POST as mcpPost } from "../../../src/app/api/mcp/route";
import { closeDb, testDb, withDbCause } from "../../helpers/db";
import { addMember, csvBuilder, createVoiceProfile } from "../../helpers/factories";
import { createFakeGraph } from "../../helpers/fake-graph";
import { createFakeLlm } from "../../helpers/fake-llm";
import { createFakeLlmFetch, type FakeLlmResponse } from "../../helpers/fake-llm-http";
import { createFakePds, mintJwt } from "../../helpers/fake-pds";
import { clearHolds, clearProjectCredentials, jobsEnv, modelOk, tickConfig } from "../../helpers/jobs-env";
import { atTime } from "../../helpers/clock";
import { createDueTarget, createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { eventsFor } from "../../helpers/activity";
import { pageCandidate, registerThrowaway, sessionFor, throwawayGroup, unregisterThrowaway } from "../../helpers/connect-group";
import { blueskyLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";
import { postsEnv } from "../../helpers/posts-env";
import type { PublishContext, SocialProvider, StepResult } from "../../../src/providers/types";
import { createMemoryStorage } from "../../helpers/storage";
import { deliverAt, webhookEnv } from "../../helpers/webhooks";
import { renderProblemEmail } from "../../../src/lib/email/render";
import { mintUnsubscribeToken, unsubscribeUrl } from "../../../src/lib/email/unsubscribe";
import { getMailer, setMailerForTests } from "../../../src/server/mail";
import { recordingMailer } from "../../helpers/mailer";
import { DEFAULT_GRAPH_BASE } from "../../../src/providers/meta/graph";
import { graphVersion } from "../../../src/providers/meta/config";
import { createFakeTikTok, type FakeTikTok } from "../../helpers/fake-tiktok";
import { createFakePinterest, type FakePinterest } from "../../helpers/fake-pinterest";
import { createFakeX, type FakeX } from "../../helpers/fake-x";
import { postMetricPollStates, accountMetricPollStates, postMetricSnapshots, accountMetricSnapshots } from "../../../src/server/db/schema/insights";

afterAll(async () => {
  // A stored credential would otherwise make a later file's project configured (worker DBs are shared).
  await clearProjectCredentials();
  setStorageForTests(undefined);
  await closeDb();
});
afterEach(() => {
  vi.restoreAllMocks();
  setImageProviderForTests(null);
});
beforeAll(() => setStorageForTests(createMemoryStorage()));

// ---- the scanner ---------------------------------------------------------------------------------------------

interface Secret {
  name: string;
  value: string;
  /** Extra renderings of the same secret (a key given as base64 is also scanned as its hex bytes). */
  also?: string[];
}
interface Piece {
  place: string;
  text: string;
}
interface Finding {
  secret: string;
  form: string;
  place: string;
}

function formsOf(s: Secret): [string, string][] {
  const out: [string, string][] = [];
  for (const v of [s.value, ...(s.also ?? [])]) {
    const buf = Buffer.from(v, "utf8");
    out.push(["raw", v], ["base64", buf.toString("base64")], ["base64url", buf.toString("base64url")], ["url-encoded", encodeURIComponent(v)], ["hex", buf.toString("hex")]);
  }
  // Base64 padding differs by alignment, so also look for the unpadded body.
  return out.map(([form, text]) => [form, text.replace(/=+$/, "")] as [string, string]);
}

/** Every secret, in every form, in every captured piece. A finding names the secret, the form and the place. */
function scan(pieces: readonly Piece[], secrets: readonly Secret[]): Finding[] {
  const findings: Finding[] = [];
  for (const piece of pieces) {
    for (const secret of secrets) {
      for (const [form, needle] of formsOf(secret)) {
        if (needle.length >= 8 && piece.text.includes(needle)) findings.push({ secret: secret.name, form, place: piece.place });
      }
    }
  }
  return findings;
}

// ---- capture -------------------------------------------------------------------------------------------------

const text = (v: unknown) => (typeof v === "string" ? v : v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : JSON.stringify(v));

function captureOutput(pieces: Piece[]): void {
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void pieces.push({ place: `console.${m}`, text: a.map(text).join(" ") }));
  }
  const sink = (place: string) => (chunk: unknown) => {
    pieces.push({ place, text: text(chunk) });
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(sink("stdout") as never);
  vi.spyOn(process.stderr, "write").mockImplementation(sink("stderr") as never);
}

/** The test helper already consumed the body; rebuild a readable response from what it kept. */
const rebuilt = (r: { status: number; headers: Headers; text: string }) => new Response(r.text, { status: r.status, headers: r.headers });

/** A JSON-RPC request to `POST /api/mcp`, mirroring `tests/helpers/mcp.ts`'s `rpc`. */
function mcpRequest(method: string, params: Record<string, unknown>, key?: string): Request {
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
  if (key) headers.set("authorization", `Bearer ${key}`);
  return new Request("http://localhost/api/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
}

async function responsePiece(place: string, res: Response): Promise<Piece> {
  const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
  return { place, text: `${res.status}\n${headers}\n${await res.text()}` };
}

const ENV_SECRETS: Secret[] = [
  { name: "BETTER_AUTH_SECRET", value: ENV.BETTER_AUTH_SECRET },
  { name: "CREDENTIALS_ENCRYPTION_KEY", value: ENV.CREDENTIALS_ENCRYPTION_KEY, also: [Buffer.alloc(32, 0x5a).toString("hex")] },
  { name: "TICK_SECRET", value: ENV.TICK_SECRET },
  { name: "S3_SECRET_ACCESS_KEY", value: ENV.S3_SECRET_ACCESS_KEY },
  { name: "S3_ACCESS_KEY_ID", value: ENV.S3_ACCESS_KEY_ID },
  { name: "OPENAI_API_KEY", value: ENV.OPENAI_API_KEY },
  { name: "ANTHROPIC_API_KEY", value: ENV.ANTHROPIC_API_KEY },
  { name: "META_APP_SECRET", value: ENV.META_APP_SECRET },
  { name: "THREADS_APP_SECRET", value: ENV.THREADS_APP_SECRET },
];

const SETUP_EMAIL = "scan-owner@example.com";
const SETUP_PASSWORD = "scan-setup-password-e3b9c1d70a42f865";
const DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const APP_PASSWORD = "abcd-efgh-ijkl-mnop";
const ACCESS = mintJwt(new Date(Date.now() + 60_000));
const REFRESH = mintJwt(new Date(Date.now() + 60 * 86_400_000));
const NEW_ACCESS = mintJwt(new Date(Date.now() + 7_200_000));
const NEW_REFRESH = mintJwt(new Date(Date.now() + 61 * 86_400_000));

describe("secret scan (FR-020, SC-005)", () => {
  it("reports a deliberately leaked secret, naming the secret and the place", () => {
    const pieces: Piece[] = [];
    captureOutput(pieces);
    console.log(`debug: tick said ${ENV.TICK_SECRET}`);
    process.stderr.write(`b64: ${Buffer.from(ENV.BETTER_AUTH_SECRET).toString("base64")}`);
    const findings = scan(pieces, ENV_SECRETS);
    expect(findings).toContainEqual({ secret: "TICK_SECRET", form: "raw", place: "console.log" });
    expect(findings).toContainEqual({ secret: "BETTER_AUTH_SECRET", form: "base64", place: "stderr" });
  });

  it("finds no secret in any output across a full run", async () => {
    await parkAllDueTargets();
    const db = testDb();
    const pieces: Piece[] = [];
    captureOutput(pieces);

    // First-run setup through the setup service. Files run serially per database, and setup needs it empty of accounts.
    // Wrapped so a failure names the Postgres error. This delete cascades across the 36 foreign keys
    // that reference "user" and has been the suite's biggest flake; see withDbCause for why neither the
    // JSON report nor the lane stderr ever recorded the cause.
    await withDbCause("wipe users for first-run setup", () => db.delete(user));
    await withDbCause("wipe install state", () => db.delete(installState));
    expect(await setup.isAvailable()).toBe(true);
    const created = await setup.createFirstUser({ name: "Scan Owner", email: SETUP_EMAIL, password: SETUP_PASSWORD });
    pieces.push({ place: "service result: setup", text: JSON.stringify(created) });
    pieces.push({ place: "service result: setup again", text: JSON.stringify(await setup.createFirstUser({ name: "Late", email: "late@example.com", password: SETUP_PASSWORD }).catch((e: unknown) => String(e))) });

    // A real sign-in through the auth handler, so a real session token exists.
    const signIn = await authPost(
      new Request(`${ENV.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ENV.BETTER_AUTH_URL, "x-forwarded-for": "192.0.2.202" },
        body: JSON.stringify({ email: SETUP_EMAIL, password: SETUP_PASSWORD }),
      }),
    );
    expect(signIn.status).toBe(200);
    const [sessionRow] = await db.select().from(sessionTable).where(eq(sessionTable.userId, created.userId));
    expect(sessionRow?.token.length).toBeGreaterThan(20);
    const sessionToken = sessionRow!.token;
    // The token's own appearances, asserted and then taken out by location (the rest of each response is scanned):
    // the sign-in Set-Cookie, and the JSON fields in which Better Auth hands the caller its own token
    // (docs/security.md, "Session token in auth responses").
    const setCookie = signIn.headers.getSetCookie().join("\n");
    expect(decodeURIComponent(setCookie)).toContain(`session_token=${sessionToken}.`);
    const signInBody = (await signIn.json()) as { token?: string };
    expect(signInBody.token).toBe(sessionToken);
    delete signInBody.token;
    const signInHeaders = [...signIn.headers.entries()].filter(([k]) => k !== "set-cookie").map(([k, v]) => `${k}: ${v}`);
    pieces.push({ place: "POST /api/auth/sign-in/email (real user)", text: `${signIn.status}\n${signInHeaders.join("\n")}\n${JSON.stringify(signInBody)}` });
    const cookie = setCookie.split("\n").map((c) => c.split(";")[0]).join("; ");
    const signedIn = { sessionId: sessionRow!.id };

    const env = await webhookEnv(["post.published", "post.failed"]);
    await addMember(env.project.id, created.userId, "owner");
    const scope = await env.as({ id: created.userId });

    // Credentials: a Bluesky account connected through the fake PDS (app password, access and refresh tokens).
    const pds = createFakePds();
    pds.route("POST", "/xrpc/com.atproto.server.createSession", { json: { accessJwt: ACCESS, refreshJwt: REFRESH, did: DID, handle: "me.bsky.social" } });
    pds.route("POST", "/xrpc/com.atproto.server.refreshSession", { json: { accessJwt: NEW_ACCESS, refreshJwt: NEW_REFRESH, did: DID, handle: "me.bsky.social" } });
    vi.stubGlobal("fetch", pds.fetch);
    const connected = await accounts.connectWithCredentials(scope, {
      providerKey: "bluesky",
      fields: { handle: "me.bsky.social", appPassword: APP_PASSWORD, pdsUrl: "" },
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    pieces.push({ place: "action result: connect", text: JSON.stringify(connected) });
    const bad = createFakePds();
    bad.route("POST", "/xrpc/com.atproto.server.createSession", { status: 401, json: { error: "AuthenticationRequired", message: `Invalid ${APP_PASSWORD}` } });
    vi.stubGlobal("fetch", bad.fetch);
    pieces.push({
      place: "action result: wrong password",
      text: JSON.stringify(await accounts.connectWithCredentials(scope, { providerKey: "bluesky", fields: { handle: "me.bsky.social", appPassword: APP_PASSWORD, pdsUrl: "" } })),
    });

    // Meta and Threads sign-in, bound to the real session, with token exchanges whose errors echo the app secret.
    const graph = createFakeGraph();
    graph.install();
    graph.on("GET", "/v26.0/oauth/access_token", { kind: "graph_error", code: 1, message: `Error validating client secret ${ENV.META_APP_SECRET}` });
    graph.on("POST", "/oauth/access_token", { kind: "graph_error", code: 1, message: `Error validating client secret ${ENV.THREADS_APP_SECRET}` });
    for (const groupKey of ["meta", "threads"]) {
      const started = await connect.startOAuthConnect(scope, { groupKey }, signedIn);
      pieces.push({ place: `service result: ${groupKey} start`, text: JSON.stringify(started) });
      const state = new URL(started.url).searchParams.get("state")!;
      const outcome = await connect.handleOAuthCallback(new URLSearchParams({ state, code: `scan-${groupKey}-code` }), { userId: created.userId, ...signedIn });
      expect(outcome).toMatchObject({ kind: "accounts", code: "exchange_failed" });
      pieces.push({ place: `service result: ${groupKey} callback`, text: JSON.stringify(outcome) });
    }
    // Each exchange did send the app secret, to the platform only.
    expect(graph.requests.filter((r) => Object.values(r.params).includes(ENV.META_APP_SECRET) || Object.values(r.params).includes(ENV.THREADS_APP_SECRET))).toHaveLength(2);
    graph.uninstall();
    vi.stubGlobal("fetch", pds.fetch);

    // Publishing: a success, a rejection whose message echoes a token, and two unknown outcomes.
    const scripts = [
      { json: { uri: `at://${DID}/app.bsky.feed.post/3k`, cid: "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgzmq2vz2m" } },
      { status: 400, json: { error: "InvalidRequest", message: `bad ${NEW_ACCESS}` } },
      { status: 502, json: { error: "UpstreamFailure", message: `upstream ${NEW_ACCESS}` } },
      { status: 502, json: { error: "UpstreamFailure", message: `upstream ${NEW_REFRESH}` } },
    ];
    const targetIds: string[] = [];
    for (const script of scripts) {
      pds.route("POST", "/xrpc/com.atproto.repo.createRecord", script);
      targetIds.push((await createDueTarget(env.project.id, connected.account.id, { baseText: "hello" })).target.id);
      await runTick(tickConfig({}));
    }

    // Resolving the unknown outcomes: one published with a link, one not published and requeued.
    const [, , publishedLater, notPublished] = targetIds as [string, string, string, string];
    const ambiguous = await db.select({ id: postTargets.id, status: postTargets.status }).from(postTargets).where(and(eq(postTargets.projectId, env.project.id), inArray(postTargets.id, [publishedLater, notPublished])))
      .orderBy(asc(postTargets.createdAt));
    expect(ambiguous.map((t) => t.status)).toEqual(["ambiguous", "ambiguous"]);
    await slots.addSlot(scope, { accountId: connected.account.id, weekday: 1, localTime: "09:00" });
    const resolved = [
      await posts.resolveAmbiguous(scope, publishedLater, { outcome: "published", url: "https://bsky.app/profile/me.bsky.social/post/3k" }),
      await posts.resolveAmbiguous(scope, notPublished, { outcome: "not_published", requeue: true }),
    ];
    expect(resolved.map((r) => r.status)).toEqual(["published", "scheduled"]);
    pieces.push({ place: "service result: resolve", text: JSON.stringify(resolved) });

    // One-time secrets: asserted here, then kept out of the corpus by never adding these responses to it.
    const apiKey = await createApiKey(scope, { name: "scan", permissions: ["read"], rateLimitPerMinute: 60, expiry: "never" });
    expect(apiKey.secret.length).toBeGreaterThan(20);
    expect(env.secret.startsWith("whsec_")).toBe(true);
    const writeKey = await createApiKey(scope, { name: "scan-write", permissions: ["write_posts"], rateLimitPerMinute: 60, expiry: "never" });
    const IDEM_PREFIX = "scan-idempotency-key-5d9e1f3a7c20b846";
    const oneTime: Secret[] = [
      { name: "api key", value: apiKey.secret },
      { name: "write api key", value: writeKey.secret },
      { name: "write api key hash", value: hashApiKey(writeKey.secret) },
      { name: "idempotency key", value: IDEM_PREFIX },
      { name: "webhook secret", value: env.secret },
    ];
    let inviteToken = "";
    await invitations.create(scope, { email: "scan-invitee@example.com", role: "editor" }, {
      async deliver(input) {
        inviteToken = new URL(input.acceptUrl).searchParams.get("token") ?? input.acceptUrl;
        return { kind: "manual_link", url: input.acceptUrl, expiresAt: input.invitation.expiresAt, email: "unavailable" };
      },
    });
    expect(inviteToken.length).toBeGreaterThan(20);
    oneTime.push({ name: "invitation token", value: inviteToken });

    // Webhook emission: the receiver sees the request the customer's system would see.
    await env.publishPost();
    await deliverAt(new Date(Date.now() + 5000));
    for (const r of env.receiver.requests) pieces.push({ place: "webhook receiver request", text: `${JSON.stringify(r.headers)}\n${r.body}` });
    expect(env.receiver.requests.length).toBeGreaterThan(0);
    // The signature header is the only appearance of the webhook secret's influence, and it is an HMAC.
    expect(env.receiver.requests[0]!.headers["docket-signature"]).toBeTruthy();

    // Route handlers. Pages and session routes see the real signed-in user and session.
    session.current = { user: { id: created.userId }, session: { id: sessionRow!.id } };
    const slug = env.project.slug;
    const [failedPostId] = (await db.select({ postId: postTargets.postId }).from(postTargets).where(and(eq(postTargets.projectId, env.project.id), eq(postTargets.id, targetIds[1]!)))).map((r) => r.postId);
    const routeCalls: [string, () => Promise<Response>][] = [
      ["GET /api/v1/posts", async () => rebuilt(await api("GET", "/posts", { key: apiKey.secret }))],
      ["GET /api/v1/posts (bad key)", async () => rebuilt(await api("GET", "/posts", { key: `${apiKey.secret}x` }))],
      ["POST tick (right secret)", async () => tickPost(new Request("http://localhost/api/internal/tick", { method: "POST", headers: { authorization: `Bearer ${ENV.TICK_SECRET}` } }))],
      ["POST tick (wrong secret)", async () => tickPost(new Request("http://localhost/api/internal/tick?secret=nope", { method: "POST", headers: { authorization: "Bearer nope" } }))],
      ["GET /api/health", async () => health()],
      [
        "POST compose/check",
        async () =>
          composeCheck(new Request("http://localhost/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseText: "hi", targets: [] }) }), {
            params: Promise.resolve({ projectSlug: slug }),
          }),
      ],
      [
        "POST /api/auth/sign-in/email (unknown user)",
        async () =>
          authPost(
            new Request(`${ENV.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
              method: "POST",
              headers: { "content-type": "application/json", origin: ENV.BETTER_AUTH_URL, "x-forwarded-for": "192.0.2.201" },
              body: JSON.stringify({ email: "nobody@example.com", password: "long-enough-password" }),
            }),
          ),
      ],
      [
        "POST /api/auth/sign-in/email (wrong password)",
        async () =>
          authPost(
            new Request(`${ENV.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
              method: "POST",
              headers: { "content-type": "application/json", origin: ENV.BETTER_AUTH_URL, "x-forwarded-for": "192.0.2.203" },
              body: JSON.stringify({ email: SETUP_EMAIL, password: `${SETUP_PASSWORD}-wrong` }),
            }),
          ),
      ],
      ["POST retry (API)", async () => rebuilt(await api("POST", `/posts/${failedPostId}/targets/${targetIds[1]}/retry`, { key: writeKey.secret, idem: `${IDEM_PREFIX}-retry`, body: { mode: "now" } }))],
      ["POST resolve (API, refused)", async () => rebuilt(await api("POST", `/posts/${failedPostId}/targets/${targetIds[1]}/resolve`, { key: writeKey.secret, idem: `${IDEM_PREFIX}-resolve`, body: { outcome: "not_published" } }))],
      ["POST retry-failed (API)", async () => rebuilt(await api("POST", "/targets/retry-failed", { key: writeKey.secret, idem: `${IDEM_PREFIX}-bulk`, body: { mode: "now" } }))],
      ["POST /api/mcp (tools/list)", async () => mcpPost(mcpRequest("tools/list", {}, apiKey.secret))],
      ["POST /api/mcp (tools/list, tampered key)", async () => mcpPost(mcpRequest("tools/list", {}, `${apiKey.secret}x`))],
      ["POST /api/mcp (tools/call)", async () => mcpPost(mcpRequest("tools/call", { name: "docket_list_accounts", arguments: {} }, apiKey.secret))],
      ["POST /api/mcp (tools/call, tampered key)", async () => mcpPost(mcpRequest("tools/call", { name: "docket_list_accounts", arguments: {} }, `${apiKey.secret}x`))],
    ];
    for (const [place, call] of routeCalls) pieces.push(await responsePiece(place, await call()));
    // The signed-in session route returns the caller's own token as `session.token`.
    const current = await authGet(new Request(`${ENV.BETTER_AUTH_URL}/api/auth/get-session`, { headers: { cookie } }));
    const currentBody = (await current.json()) as { session: { token?: string; userId: string } };
    expect(currentBody.session.userId).toBe(created.userId);
    expect(currentBody.session.token).toBe(sessionToken);
    delete currentBody.session.token;
    const currentHeaders = [...current.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    pieces.push({ place: "GET /api/auth/get-session (signed in)", text: `${current.status}\n${currentHeaders}\n${JSON.stringify(currentBody)}` });

    // Engagement (077): inbound items through the mock provider, a person-authored draft left pending,
    // a model-authored draft (through the real prompt-building path) approved and sent to an ambiguous
    // outcome, and a direct message — all rendered below on the inbox, item, review and failures pages
    // (FR-062, SC-013).
    await projectsService.updateSettings(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scope as any,
      {
        name: env.project.name,
        slug: env.project.slug,
        timezone: env.project.timezone,
        defaultApprovalPolicy: "review_required",
        defaultSchedulingPolicy: "leave_as_draft",
        confirmUnreviewedQueue: false,
        tagline: "Fresh bread daily",
        description: "A neighbourhood bakery.",
        websiteUrl: "https://scan.example",
      },
    );
    await createVoiceProfile(env.project.id, { content: { voiceAndTone: "Warm and plain." } });
    await accounts.connectMock(scope, {
      displayName: "Scan Inbox",
      settings: {
        engagementSendBehaviour: "ambiguous",
        engagementItems: [
          { kind: "reply", externalId: "scan-eng-1", text: "Love this bakery!", authorHandle: "ada", authorDisplayName: "Ada" },
          { kind: "reply", externalId: "scan-eng-2", text: "Great post!", authorHandle: "bea", authorDisplayName: "Bea" },
          { kind: "direct_message", externalId: "scan-eng-dm", text: "Can you ship internationally?", authorHandle: "cam" },
        ],
      },
    });
    await runTick(tickConfig({ engagementReadMinIntervalMs: 0 }));
    const engagementList = await listInbox(scope);
    const item1 = engagementList.items.find((i) => i.externalId === "scan-eng-1")!;
    const item2 = engagementList.items.find((i) => i.externalId === "scan-eng-2")!;
    const written1 = await writeReply(scope, item1.id, "Thanks so much for the kind words!");
    if (!written1.ok) throw new Error("unreachable");
    pieces.push({ place: "service result: engagement draft (person)", text: JSON.stringify(written1) });

    setLlmForTests(createFakeLlm([{ ok: { text: "Thanks for stopping by!" } }]));
    const drafted2 = await requestDraft(scope, item2.id);
    setLlmForTests(null);
    if (!drafted2.ok) throw new Error("unreachable");
    pieces.push({ place: "service result: engagement draft (model)", text: JSON.stringify(drafted2) });
    const approved2 = await approveReply(scope, drafted2.draftId);
    expect(approved2.ok).toBe(true);
    await runTick(tickConfig({ engagementReadMinIntervalMs: 0 })); // engagement-send: item2 -> ambiguous

    // Insights (079): a tick polls Bluesky's real numbers for the published target through the same
    // fake PDS, with a platform failure shaped to echo a current access token, and the resulting
    // panel is rendered below on the post detail page (FR-075, SC-011).
    pds.route("GET", "/xrpc/app.bsky.feed.getPosts", { status: 500, json: { error: "InternalServerError", message: `insights failure echoing ${NEW_ACCESS}` } });
    await runTick(tickConfig({}));
    const [insightsTarget] = await db
      .select({ postId: postTargets.postId })
      .from(postTargets)
      .where(and(eq(postTargets.projectId, env.project.id), eq(postTargets.id, targetIds[0]!)));
    const insightsPostId = insightsTarget!.postId;

    // Rendered pages.
    const params = { params: Promise.resolve({ projectSlug: slug }) };
    const pages: [string, () => Promise<unknown>][] = [
      ["page: accounts", () => AccountsPage(params)],
      ["page: api keys", () => ApiKeysPage(params)],
      ["page: webhooks", () => WebhooksPage(params)],
      ["page: members", () => MembersPage(params)],
      ["page: failures", () => FailuresPage({ ...params, searchParams: Promise.resolve({}) })],
      ["page: inbox", () => InboxPage({ ...params, searchParams: Promise.resolve({}) })],
      ["page: inbox item", () => InboxItemPage({ params: Promise.resolve({ projectSlug: slug, itemId: item1.id }) })],
      ["page: review", () => ReviewPage({ ...params, searchParams: Promise.resolve({}) })],
      ["page: post (insights)", () => PostPage({ params: Promise.resolve({ projectSlug: slug, postId: insightsPostId }) })],
    ];
    for (const [place, render] of pages) {
      pieces.push({ place, text: renderToStaticMarkup((await render()) as never) });
    }

    // Generation: a billing refusal whose provider error body embeds the configured key, through the real
    // provider layer, plus a held job's two Batch jobs screens (FR-033, H19).
    const genEnv = await jobsEnv();
    const anthropicConfig: LlmConfig = { provider: "anthropic", model: "test-model", apiKey: ENV.ANTHROPIC_API_KEY, timeoutMs: 10_000, maxOutputTokens: 1000 };
    const anthropicFetch = createFakeLlmFetch([
      { status: 400, json: { type: "error", error: { type: "invalid_request_error", message: `Your credit balance is too low to access the Anthropic API (${ENV.ANTHROPIC_API_KEY}). Please go to Plans & Billing to upgrade or purchase credits.` } } },
    ]);
    const anthropicLlm = createAnthropicProvider(anthropicConfig, { fetch: anthropicFetch, maxRetries: 0 });
    const genSingleInput = (over: Record<string, unknown> = {}) => ({
      requestId: randomUUID(),
      voiceProfileId: genEnv.profile.id,
      brief: "Announce the spring sale",
      targetAccountIds: [genEnv.account.id],
      ...over,
    });
    pieces.push({
      place: "service result: generation (anthropic credit refusal)",
      text: JSON.stringify(await generateSingle(genEnv.scope, genSingleInput(), anthropicLlm)),
    });

    const openAiConfig: LlmConfig = { provider: "openai", model: "test-model", apiKey: ENV.OPENAI_API_KEY, timeoutMs: 10_000, maxOutputTokens: 1000 };
    const openAiFetch = createFakeLlmFetch([
      { status: 429, json: { error: { message: `You exceeded your current quota, please check your plan and billing details. (${ENV.OPENAI_API_KEY})`, type: "insufficient_quota", code: "insufficient_quota", param: null } } },
    ]);
    const openAiLlm = createOpenAiProvider(openAiConfig, { fetch: openAiFetch, maxRetries: 0 });
    pieces.push({
      place: "service result: generation (openai credit refusal)",
      text: JSON.stringify(await generateSingle(genEnv.scope, genSingleInput(), openAiLlm)),
    });

    // Per-project LLM credential (L32): set, changed and removed through the real server actions; the
    // settings page rendered for owner, admin and editor; a check; and a tick that generates on it, with
    // the provider's billing refusal embedding the then-current key.
    const PROJECT_LLM_KEY = "sk-scan-project-llm-initial-7c9e2b4d6f810395a7c1";
    const PROJECT_LLM_KEY_2 = "sk-scan-project-llm-changed-3b5d7f901a2c4e6809d3";
    const sessionBeforeLlm = session.current;
    const asUser = (u: { id: string }) => {
      session.current = { user: { id: u.id }, session: { id: `scan-llm-session-${u.id}` } };
    };
    const modelForm = (fields: Record<string, string> = {}) => {
      const fd = new FormData();
      fd.set("slug", genEnv.project.slug);
      for (const [k, v] of Object.entries(fields)) fd.set(k, v);
      return fd;
    };

    asUser(genEnv.owner);
    pieces.push({ place: "action result: save project llm", text: JSON.stringify(await saveProjectModel(null, modelForm({ provider: "openai", model: "scan-model", apiKey: PROJECT_LLM_KEY }))) });
    pieces.push({ place: "action result: change project llm", text: JSON.stringify(await saveProjectModel(null, modelForm({ provider: "openai", model: "scan-model-2", apiKey: PROJECT_LLM_KEY_2 }))) });

    const openAiCheckOk: FakeLlmResponse = {
      status: 200,
      json: {
        id: "r",
        object: "response",
        created_at: 1,
        model: "m",
        status: "completed",
        error: null,
        incomplete_details: null,
        output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ text: "Welcome to the bakery's spring opening!" }), annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    };
    const projectLlmFetch = createFakeLlmFetch([
      openAiCheckOk,
      { status: 429, json: { error: { message: `You exceeded your current quota, please check your plan and billing details. (${PROJECT_LLM_KEY_2})`, type: "insufficient_quota", code: "insufficient_quota", param: null } } },
    ]);
    setLlmFactoryForTests((config) => createOpenAiProvider(config, { fetch: projectLlmFetch, maxRetries: 0 }));

    const renderModelPage = async (u: { id: string }) => {
      asUser(u);
      return renderToStaticMarkup((await ModelPage({ params: Promise.resolve({ projectSlug: genEnv.project.slug }) })) as never);
    };
    pieces.push({ place: "page: model (owner)", text: await renderModelPage(genEnv.owner) });
    pieces.push({ place: "page: model (admin)", text: await renderModelPage(genEnv.admin) });
    try {
      await renderModelPage(genEnv.editor);
      throw new Error("expected the editor's model page to 404");
    } catch (error) {
      if (!(error instanceof NotFoundSignal)) throw error;
    }

    asUser(genEnv.owner);
    pieces.push({ place: "action result: check project llm", text: JSON.stringify(await checkProjectModel(null, modelForm())) });

    await genEnv.asset();
    const { jobId: projectLlmJobId } = await createJob(genEnv.scope, genEnv.input());
    await runTick(tickConfig({ jobMaxItems: 5 }));
    pieces.push({
      place: "page: job detail (project llm refusal)",
      text: renderToStaticMarkup((await JobPage({ params: Promise.resolve({ projectSlug: genEnv.project.slug, jobId: projectLlmJobId }), searchParams: Promise.resolve({}) })) as never),
    });

    setLlmFactoryForTests(null);
    await clearHolds();
    asUser(genEnv.owner);
    pieces.push({ place: "action result: remove project llm", text: JSON.stringify(await removeProjectModel(null, modelForm())) });
    session.current = sessionBeforeLlm;

    const projectLlmSecrets: Secret[] = [
      { name: "project llm key (initial)", value: PROJECT_LLM_KEY },
      { name: "project llm key (changed)", value: PROJECT_LLM_KEY_2 },
    ];

    // A completed job on the install's own credential, so the job page carries real token totals (FR-028)
    // and the Usage page below has a non-empty report to render.
    await genEnv.asset();
    setLlmForTests(createFakeLlm([modelOk("Scan success post.")]));
    const { jobId: usageJobId } = await createJob(genEnv.scope, genEnv.input());
    await runTick(tickConfig({ jobMaxItems: 5 }));
    setLlmForTests(null);
    const sessionBeforeUsage = session.current;
    session.current = { user: { id: genEnv.owner.id }, session: { id: "scan-usage-job-session" } };
    pieces.push({
      place: "page: job detail (real usage)",
      text: renderToStaticMarkup((await JobPage({ params: Promise.resolve({ projectSlug: genEnv.project.slug, jobId: usageJobId }), searchParams: Promise.resolve({}) })) as never),
    });
    session.current = sessionBeforeUsage;

    // The Usage page (FR-026, SC-010): owner and admin see it; the editor gets the same not-found as
    // any page they may not manage.
    const renderUsagePage = async (u: { id: string }) => {
      session.current = { user: { id: u.id }, session: { id: `scan-usage-session-${u.id}` } };
      return UsagePage({ params: Promise.resolve({ projectSlug: genEnv.project.slug }), searchParams: Promise.resolve({}) });
    };
    pieces.push({ place: "page: usage (owner)", text: renderToStaticMarkup((await renderUsagePage(genEnv.owner)) as never) });
    pieces.push({ place: "page: usage (admin)", text: renderToStaticMarkup((await renderUsagePage(genEnv.admin)) as never) });
    try {
      await renderUsagePage(genEnv.editor);
      throw new Error("expected the editor's usage page to 404");
    } catch (error) {
      if (!(error instanceof NotFoundSignal)) throw error;
    }
    session.current = sessionBeforeUsage;

    await genEnv.asset();
    setLlmForTests(createFakeLlm([{ fail: "credit_exhausted" }]));
    const { jobId: heldJobId } = await createJob(genEnv.scope, genEnv.input());
    await runTick(tickConfig({ jobMaxItems: 5 }));
    setLlmForTests(null);
    const sessionBefore = session.current;
    session.current = { user: { id: genEnv.owner.id }, session: { id: "scan-jobs-session" } };
    pieces.push({ place: "page: jobs list (held)", text: renderToStaticMarkup(await JobsPage({ params: Promise.resolve({ projectSlug: genEnv.project.slug }), searchParams: Promise.resolve({}) })) });
    pieces.push({ place: "page: job detail (held)", text: renderToStaticMarkup((await JobPage({ params: Promise.resolve({ projectSlug: genEnv.project.slug, jobId: heldJobId }), searchParams: Promise.resolve({}) })) as never) });
    session.current = sessionBefore;
    await clearHolds();

    // Image generation (T038, quickstart.md §8): one image through a fake provider, then the Media
    // page rendered for owner, admin and editor — no fake key, SDK error text or raw provider
    // payload may appear anywhere.
    setImageProviderForTests(createFakeImageProvider([{ bytes: await png(256, 256) }]));
    asUser(genEnv.owner);
    const imageResult = await generateImage(genEnv.scope, { prompt: "a cat on a roof", aspect: "square" });
    expect(imageResult.ok).toBe(true);
    pieces.push({ place: "service result: generate image", text: JSON.stringify(imageResult) });
    setImageProviderForTests(null);

    const renderMediaPage = async (u: { id: string }) => {
      asUser(u);
      return renderToStaticMarkup(
        (await MediaPage({ params: Promise.resolve({ projectSlug: genEnv.project.slug }), searchParams: Promise.resolve({}) })) as never,
      );
    };
    pieces.push({ place: "page: media (owner)", text: await renderMediaPage(genEnv.owner) });
    pieces.push({ place: "page: media (admin)", text: await renderMediaPage(genEnv.admin) });
    pieces.push({ place: "page: media (editor)", text: await renderMediaPage(genEnv.editor) });
    session.current = sessionBeforeLlm;

    // Standing series (T070): a pool series and a generate series, ticked through the worker (whose own
    // log lines are already in `pieces` via the console spy), then /jobs and the series detail page
    // rendered for all three roles.
    const seriesCreatedAt = new Date("2026-01-10T00:00:00.000Z");
    const seriesFiringAt = new Date("2026-01-11T00:00:01.000Z");
    const seriesInput = (over: Record<string, unknown> = {}) => ({
      name: `Scan series ${randomUUID().slice(0, 8)}`,
      brief: "Brief.",
      template: "Write a short post.",
      voiceProfileId: genEnv.profile.id,
      targetAccountIds: [genEnv.account.id],
      cadence: { count: 1, period: "day" as const },
      approval: null,
      scheduling: null,
      confirmUnreviewedQueue: false,
      ...over,
    });
    const { seriesId: poolSeriesId } = await atTime(seriesCreatedAt, () =>
      createStandingSeries(genEnv.scope, seriesInput({ media: { source: "pool" } })),
    );
    const poolAssetKey = `projects/${genEnv.project.id}/media/${randomUUID()}/original.png`;
    const poolAssetBytes = await png(64, 64);
    await genEnv.storage.put(poolAssetKey, poolAssetBytes, "image/png");
    await genEnv.scope.media.insert({
      storageKey: poolAssetKey,
      publicUrl: genEnv.storage.publicUrl(poolAssetKey),
      mimeType: "image/png",
      byteSize: poolAssetBytes.length,
      width: 64,
      height: 64,
      altText: "Pool photo",
      tags: [],
    });

    setImageProviderForTests(createFakeImageProvider([{ bytes: await png(64, 64) }]));
    const { seriesId: generateSeriesId } = await atTime(seriesCreatedAt, () =>
      createStandingSeries(genEnv.scope, seriesInput({ media: { source: "generate", prompt: "A cool picture" } })),
    );

    // A dated series (T067): an import with a problem row alongside a good one, firing the good row
    // in the same tick, so its import-problems alert and rows table render too.
    const { seriesId: datedSeriesId } = await atTime(seriesCreatedAt, () =>
      createStandingSeries(genEnv.scope, seriesInput({ occurrenceRule: "dated_list", cadence: null, media: { source: "none" } })),
    );
    const datedCsv = csvBuilder(["date", "name"], [["01-11", "Ada Lovelace"], ["02-30", "Impossible"]]);
    const datedImportResult = await atTime(seriesCreatedAt, () =>
      importDatedList(genEnv.scope, datedSeriesId, { name: "scan.csv", bytes: new Uint8Array(datedCsv) }),
    );
    pieces.push({ place: "service result: dated import", text: JSON.stringify(datedImportResult) });

    setLlmForTests(createFakeLlm([modelOk("Scan pool post.", 1), modelOk("Scan generate post.", 1), modelOk("Scan dated post.")]));
    await atTime(seriesFiringAt, () => runTick(tickConfig({})));
    setLlmForTests(null);
    setImageProviderForTests(null);

    const renderSeriesDetail = async (u: { id: string }, seriesId: string) => {
      asUser(u);
      return renderToStaticMarkup(
        (await StandingSeriesDetailPage({
          params: Promise.resolve({ projectSlug: genEnv.project.slug, seriesId }),
          searchParams: Promise.resolve({}),
        })) as never,
      );
    };
    const renderJobsPage = async (u: { id: string }) => {
      asUser(u);
      return renderToStaticMarkup(await JobsPage({ params: Promise.resolve({ projectSlug: genEnv.project.slug }), searchParams: Promise.resolve({}) }));
    };
    for (const { id, label } of [
      { id: poolSeriesId, label: "pool" },
      { id: generateSeriesId, label: "generate" },
      { id: datedSeriesId, label: "dated" },
    ]) {
      for (const [role, u] of [["owner", genEnv.owner], ["admin", genEnv.admin], ["editor", genEnv.editor]] as const) {
        pieces.push({ place: `page: standing series detail (${label}, ${role})`, text: await renderSeriesDetail(u, id) });
      }
    }
    for (const [role, u] of [["owner", genEnv.owner], ["admin", genEnv.admin], ["editor", genEnv.editor]] as const) {
      pieces.push({ place: `page: jobs with standing series (${role})`, text: await renderJobsPage(u) });
    }
    session.current = sessionBeforeLlm;
    // Worker databases are shared across test files (see the `afterAll` comment above): a series left
    // enabled here would otherwise become due for a later file's plain `runTick(tickConfig())`, which has no
    // reason to expect standing series in play at all.
    for (const id of [poolSeriesId, generateSeriesId, datedSeriesId]) {
      await genEnv.scope.standingSeries.update(id, { enabled: false });
    }

    // Granted scopes (T046-T052): one account per provider carrying a scripted grantedScopes value,
    // plus a token-shaped reply that must normalize to null rather than being stored (FR-015, FR-056).
    const REJECTED_TOKEN = "EAAscanRejectedTokenShapedValue9Qx7Zc3";
    const repos = forSchedulerProject(env.project.id);
    for (const providerKey of ["facebook", "instagram", "threads", "x", "tiktok", "pinterest"] as const) {
      await repos.accounts.upsertConnected({
        providerKey,
        displayName: `Scan ${providerKey}`,
        externalAccountId: `scan-${providerKey}-${randomUUID()}`,
        settings: {},
        credentialsEncrypted: accounts.encryptCredentials(randomUUID(), { token: `scan-${providerKey}-credential` }),
        credentialsExpiresAt: null,
        connectedByUserId: null,
        grantedScopes: [`${providerKey}_read_insights`],
      });
    }
    const rejected = await repos.accounts.upsertConnected({
      providerKey: "pinterest",
      displayName: "Scan pinterest (rejected)",
      externalAccountId: `scan-pinterest-rejected-${randomUUID()}`,
      settings: {},
      credentialsEncrypted: accounts.encryptCredentials(randomUUID(), { token: "scan-pinterest-rejected-credential" }),
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: [REJECTED_TOKEN], // token-shaped: fails GRANTED_SCOPE_PATTERN, so the whole list is rejected
    });
    expect((await repos.accounts.get(rejected.id))?.grantedScopes).toBeNull();

    // Stored rows.
    pieces.push({ place: "publish_attempts", text: JSON.stringify(await db.select().from(publishAttempts).where(eq(publishAttempts.projectId, env.project.id))) });
    pieces.push({ place: "post_targets", text: JSON.stringify(await db.select().from(postTargets).where(eq(postTargets.projectId, env.project.id))) });
    pieces.push({ place: "membership_audit_log", text: JSON.stringify(await db.select().from(membershipAuditLog).where(eq(membershipAuditLog.projectId, env.project.id))) });
    pieces.push({ place: "membership_audit_log (project llm)", text: JSON.stringify(await db.select().from(membershipAuditLog).where(eq(membershipAuditLog.projectId, genEnv.project.id))) });
    pieces.push({ place: "project_llm_settings", text: JSON.stringify(await db.select().from(projectLlmSettings).where(eq(projectLlmSettings.projectId, genEnv.project.id))) });
    pieces.push({ place: "llm_call_usage", text: JSON.stringify(await db.select().from(llmCallUsage).where(eq(llmCallUsage.projectId, genEnv.project.id))) });
    pieces.push({ place: "connect_attempts", text: JSON.stringify(await db.select().from(connectAttempts).where(eq(connectAttempts.projectId, env.project.id))) });
    const accountRows = await db.select().from(socialAccounts).where(eq(socialAccounts.projectId, env.project.id));
    pieces.push({ place: "social_accounts", text: JSON.stringify(accountRows.map((r) => ({ ...r, credentialsEncrypted: undefined }))) });
    for (const delivery of await env.scope.webhooks.listDeliveries(env.endpoint.id, { limit: 50 })) {
      pieces.push({ place: "webhook delivery", text: JSON.stringify(delivery) });
      pieces.push({ place: "webhook attempts", text: JSON.stringify(await env.scope.webhooks.listAttempts([delivery.id])) });
    }

    const credentials: Secret[] = [
      { name: "bluesky app password", value: APP_PASSWORD },
      ...[ACCESS, REFRESH, NEW_ACCESS, NEW_REFRESH].map((value, i) => ({ name: `bluesky token ${i + 1}`, value })),
      { name: "setup password", value: SETUP_PASSWORD },
      { name: "session token", value: sessionToken },
      { name: "rejected token-shaped granted scope", value: REJECTED_TOKEN },
      ...projectLlmSecrets,
    ];
    // Something was captured from every kind of place, so an empty corpus cannot pass.
    expect(new Set(pieces.map((p) => p.place.split(":")[0])).size).toBeGreaterThan(6);
    expect(scan(pieces, [...ENV_SECRETS, ...credentials, ...oneTime])).toEqual([]);
  });

  it("the Meta insights readers and their panel states never echo a credential (FR-015, SC-010)", async () => {
    await parkAllDueTargets();
    const FB_TOKEN = "scan-fb-page-token-7a1c9e3d5b8042f6097a1c2d3e4f5061";
    const FB_VIDEO_TOKEN = "scan-fb-video-page-token-2b4e6a8c0d1f3759680a1b2c3d4e5f60";
    const IG_TOKEN = "scan-ig-page-token-9c0b1a2938475665f4e3d2c1b0a9f8e7";
    const TH_TOKEN = "scan-threads-token-1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60";
    const GRAPH_ERROR_ECHO = `Rejected for token ${FB_TOKEN}`;

    const ctx = await postsEnv();
    const repos = forSchedulerProject(ctx.project.id);

    // A normal Facebook Page post: granted the required scopes, a real Graph call is attempted, and
    // the fake Graph error message echoes the page token — covered because this is the only one of
    // the five accounts below whose reader actually reaches the network this tick.
    const fbNormal = await repos.accounts.upsertConnected({
      providerKey: "facebook",
      displayName: "Scan FB Page",
      externalAccountId: "scan-fb-normal",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["pages_read_engagement", "read_insights"],
    });
    await repos.accounts.setCredentials(fbNormal.id, accounts.encryptCredentials(fbNormal.id, { pageToken: FB_TOKEN }), null);
    // A Reel's bare video id: classified `unqueryable` before any request is issued (FR-036) — its
    // own distinctive token must never be touched this tick, let alone leaked.
    const fbVideo = await repos.accounts.upsertConnected({
      providerKey: "facebook",
      displayName: "Scan FB Reel",
      externalAccountId: "scan-fb-video",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["pages_read_engagement", "read_insights"],
    });
    await repos.accounts.setCredentials(fbVideo.id, accounts.encryptCredentials(fbVideo.id, { pageToken: FB_VIDEO_TOKEN }), null);
    // No insights scope granted: excluded from the claim before any credential is ever decrypted
    // (FR-023) — renders `needs_reconnect` or `permission_not_requested`.
    const fbGated = await repos.accounts.upsertConnected({
      providerKey: "facebook",
      displayName: "Scan FB Gated",
      externalAccountId: "scan-fb-gated",
      settings: {},
      credentialsEncrypted: accounts.encryptCredentials(randomUUID(), { pageToken: "scan-fb-gated-token-should-never-be-read" }),
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: [],
    });
    // A story already past Instagram's 24h lifetime: born frozen `expired` with no provider call
    // (FR-041) — its token must never be touched either.
    const igExpired = await repos.accounts.upsertConnected({
      providerKey: "instagram",
      displayName: "Scan IG Story",
      externalAccountId: "scan-ig-expired",
      settings: {},
      credentialsEncrypted: accounts.encryptCredentials(randomUUID(), { pageToken: IG_TOKEN }),
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
    });
    // Threads still declares `unavailable`: never claimed, never called (080 behaviour, unchanged).
    const threads = await repos.accounts.upsertConnected({
      providerKey: "threads",
      displayName: "Scan Threads",
      externalAccountId: "scan-threads",
      settings: {},
      credentialsEncrypted: accounts.encryptCredentials(randomUUID(), { pageToken: TH_TOKEN }),
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["threads_manage_insights"],
    });

    const post = await repos.posts.insert({ baseText: "Scan insights" });
    const FB_PAGE_POST_ID = "100000000000001_200000000000002";
    const targets = await repos.targets.insertMany([
      { postId: post.id, socialAccountId: fbNormal.id },
      { postId: post.id, socialAccountId: fbVideo.id },
      { postId: post.id, socialAccountId: fbGated.id },
      { postId: post.id, socialAccountId: igExpired.id },
      { postId: post.id, socialAccountId: threads.id },
    ]);
    const [fbNormalTarget, fbVideoTarget, fbGatedTarget, igTarget, threadsTarget] = targets;
    const NOW = new Date("2026-08-01T00:00:00Z");
    await repos.targets.update(fbNormalTarget!.id, { status: "published", externalId: FB_PAGE_POST_ID, publishedAt: NOW });
    await repos.targets.update(fbVideoTarget!.id, { status: "published", externalId: "987654321", publishedAt: NOW });
    await repos.targets.update(fbGatedTarget!.id, { status: "published", externalId: "100000000000003_200000000000004", publishedAt: NOW });
    await repos.targets.update(igTarget!.id, { status: "published", externalId: "scan-ig-story-1", publishedAt: new Date(NOW.getTime() - 30 * 3_600_000), chosenPostType: "story" });
    await repos.targets.update(threadsTarget!.id, { status: "published", externalId: "scan-threads-media-1", publishedAt: NOW });

    const graph = createFakeGraph();
    graph.on("GET", `/${graphVersion()}/${FB_PAGE_POST_ID}/insights`, { kind: "graph_error", code: 1, message: GRAPH_ERROR_ECHO });
    graph.fallback({ kind: "graph_error", code: 803, message: "Unexpected request in the insights panel scan test" });
    graph.install();
    try {
      await atTime(new Date(NOW.getTime() + 3_600_000), () => runTick(tickConfig({})));
    } finally {
      graph.uninstall();
    }

    // The Reel's and the gated account's tokens were never even reached for.
    expect(graph.requests.some((r) => r.path.includes("scan-fb-video") || r.path.includes(FB_VIDEO_TOKEN))).toBe(false);
    expect(graph.requests.some((r) => r.path.includes("987654321"))).toBe(false);
    expect(graph.requests.length).toBeGreaterThanOrEqual(1);
    expect(graph.requests.every((r) => r.host === new URL(DEFAULT_GRAPH_BASE).host)).toBe(true);

    const sessionBefore = session.current;
    session.current = { user: { id: ctx.owner.id }, session: { id: "scan-insights-panel-session" } };
    const params = { params: Promise.resolve({ projectSlug: ctx.project.slug, postId: post.id }) };
    const postMarkup = renderToStaticMarkup((await PostPage(params)) as never);
    session.current = sessionBefore;
    const pieces: Piece[] = [{ place: "page: post (meta insights panel states)", text: postMarkup }];
    // Sanity: the four 081 panel states this entry adds all actually rendered, not just an absence of secrets.
    expect(postMarkup).toContain("not confirmed"); // threads: unavailable, 080 behaviour
    expect(postMarkup).toMatch(/read_insights|cannot read its numbers|has not been given permission|Reconnect/);
    expect(postMarkup).toContain("cannot be used to request its numbers"); // facebook: unqueryable
    expect(postMarkup).toContain("story has expired"); // instagram: expired

    const secrets: Secret[] = [
      { name: "facebook page token (normal)", value: FB_TOKEN },
      { name: "facebook page token (video)", value: FB_VIDEO_TOKEN },
      { name: "facebook page token (gated)", value: "scan-fb-gated-token-should-never-be-read" },
      { name: "instagram page token", value: IG_TOKEN },
      { name: "threads token", value: TH_TOKEN },
      { name: "graph error echo of the facebook token", value: GRAPH_ERROR_ECHO },
    ];
    expect(scan(pieces, [...ENV_SECRETS, ...secrets])).toEqual([]);
  });

  it("the TikTok, Pinterest and X insights readers and their poll-state/snapshot rows never echo a credential (FR-013, FR-054)", async () => {
    await parkAllDueTargets();
    process.env.X_INSIGHTS_ENABLED = "true";

    const TT_ACCESS = "scan-tiktok-access-7a1c9e3d5b8042f6097a1c2d3e4f5061";
    const TT_REFRESH = "scan-tiktok-refresh-2b4e6a8c0d1f3759680a1b2c3d4e5f60";
    const PIN_ACCESS = "scan-pinterest-access-9c0b1a2938475665f4e3d2c1b0a9f8e7";
    const PIN_REFRESH = "scan-pinterest-refresh-1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60";
    const X_ACCESS = "scan-x-access-3f4a5b6c7d8e9f001122334455667788";
    const X_REFRESH = "scan-x-refresh-8899aabbccddeeff0011223344556677";

    const ctx = await postsEnv();
    const repos = forSchedulerProject(ctx.project.id);
    const NOW = new Date("2026-09-01T00:00:00Z");
    const future = new Date(NOW.getTime() + 60 * 86_400_000);

    const post = await repos.posts.insert({ baseText: "Scan three-platform insights" });
    const TT_VIDEO_ID = "scan-tiktok-video-1";
    const PIN_PIN_ID = "scan-pinterest-pin-1";
    const X_POST_ID = "2001";

    // Each provider's account, target and fake are set up and ticked on its own: the fakes each
    // stub `global.fetch` unconditionally (no host filter), so installing more than one at a time
    // would have the last-installed fake answer every provider's requests.
    const tiktokAccount = await repos.accounts.upsertConnected({
      providerKey: "tiktok",
      displayName: "Scan TikTok",
      externalAccountId: "scan-tiktok-open-id",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["video.list", "user.info.stats"],
    });
    await repos.accounts.setCredentials(
      tiktokAccount.id,
      accounts.encryptCredentials(tiktokAccount.id, {
        v: 1,
        accessToken: TT_ACCESS,
        refreshToken: TT_REFRESH,
        accessExpiresAt: future.getTime(),
        refreshIssuedAt: NOW.getTime(),
        refreshExpiresAt: future.getTime(),
        refreshExpiryEstimated: false,
        openId: "scan-tiktok-open-id",
      }),
      null,
    );
    const [tiktokTarget] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: tiktokAccount.id }]);
    await repos.targets.update(tiktokTarget!.id, { status: "published", externalId: TT_VIDEO_ID, publicPostId: TT_VIDEO_ID, publishedAt: NOW });

    const fakeTikTok: FakeTikTok = createFakeTikTok().install();
    fakeTikTok.on("POST", "/v2/video/query/", { kind: "error", code: "validation_error", message: `Request refused for token ${TT_ACCESS}`, status: 400 });
    fakeTikTok.on("GET", "/v2/user/info/", { kind: "error", code: "validation_error", message: `Request refused for token ${TT_ACCESS}`, status: 400 });
    try {
      await atTime(new Date(NOW.getTime() + 3_600_000), () => runTick(tickConfig({})));
    } finally {
      fakeTikTok.uninstall();
    }
    expect(fakeTikTok.callsTo("POST", "/v2/video/query/")).toHaveLength(1);

    const pinterestAccount = await repos.accounts.upsertConnected({
      providerKey: "pinterest",
      displayName: "Scan Pinterest",
      externalAccountId: "scan-pinterest-user-1",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["pins:read"],
    });
    await repos.accounts.setCredentials(
      pinterestAccount.id,
      accounts.encryptCredentials(pinterestAccount.id, {
        v: 1,
        accessToken: PIN_ACCESS,
        refreshToken: PIN_REFRESH,
        accessExpiresAt: future.getTime(),
        refreshIssuedAt: NOW.getTime(),
        refreshExpiresAt: future.getTime(),
        refreshExpiryEstimated: false,
      }),
      null,
    );
    const [pinterestTarget] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: pinterestAccount.id }]);
    await repos.targets.update(pinterestTarget!.id, { status: "published", externalId: PIN_PIN_ID, publishedAt: NOW });

    const fakePinterest: FakePinterest = createFakePinterest().install();
    fakePinterest.on("GET", `/v5/pins/${PIN_PIN_ID}/analytics`, { kind: "error", message: `Request refused for token ${PIN_ACCESS}`, status: 400 });
    fakePinterest.on("GET", "/v5/user_account", { kind: "ok", body: { follower_count: 12, monthly_views: 340 } });
    try {
      await atTime(new Date(NOW.getTime() + 3_600_000), () => runTick(tickConfig({})));
    } finally {
      fakePinterest.uninstall();
    }
    // Pinterest's account-metrics read did succeed, so a snapshot exists to scan alongside the
    // failed post-metrics read.
    expect(fakePinterest.callsTo("GET", "/v5/user_account")).toHaveLength(1);
    expect(fakePinterest.callsTo("GET", `/v5/pins/${PIN_PIN_ID}/analytics`)).toHaveLength(1);

    const xAccount = await repos.accounts.upsertConnected({
      providerKey: "x",
      displayName: "Scan X",
      externalAccountId: "scan-x-user-1",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["tweet.read"],
    });
    await repos.accounts.setCredentials(
      xAccount.id,
      accounts.encryptCredentials(xAccount.id, {
        v: 1,
        accessToken: X_ACCESS,
        refreshToken: X_REFRESH,
        accessExpiresAt: future.getTime(),
        refreshIssuedAt: NOW.getTime(),
      }),
      null,
    );
    const [xTarget] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: xAccount.id }]);
    await repos.targets.update(xTarget!.id, { status: "published", externalId: X_POST_ID, publishedAt: NOW });

    const fakeX: FakeX = createFakeX().install();
    fakeX.on("GET", "/2/tweets", { kind: "problem", status: 403, title: "Forbidden", detail: `Request refused for token ${X_ACCESS}` });
    try {
      await atTime(new Date(NOW.getTime() + 3_600_000), () => runTick(tickConfig({})));
    } finally {
      fakeX.uninstall();
      delete process.env.X_INSIGHTS_ENABLED;
    }
    expect(fakeX.callsTo("GET", "/2/tweets")).toHaveLength(1);

    const sessionBefore = session.current;
    session.current = { user: { id: ctx.owner.id }, session: { id: "scan-three-platform-insights-session" } };
    const params = { params: Promise.resolve({ projectSlug: ctx.project.slug, postId: post.id }) };
    const postMarkup = renderToStaticMarkup((await PostPage(params)) as never);
    session.current = sessionBefore;

    const db = testDb();
    const pieces: Piece[] = [
      { place: "page: post (tiktok/pinterest/x insights panel)", text: postMarkup },
      { place: "post_targets (public_post_id)", text: JSON.stringify(await db.select().from(postTargets).where(eq(postTargets.projectId, ctx.project.id))) },
      { place: "post_metric_poll_states", text: JSON.stringify(await db.select().from(postMetricPollStates).where(eq(postMetricPollStates.projectId, ctx.project.id))) },
      { place: "account_metric_poll_states", text: JSON.stringify(await db.select().from(accountMetricPollStates).where(eq(accountMetricPollStates.projectId, ctx.project.id))) },
      { place: "post_metric_snapshots", text: JSON.stringify(await db.select().from(postMetricSnapshots).where(eq(postMetricSnapshots.projectId, ctx.project.id))) },
      { place: "account_metric_snapshots", text: JSON.stringify(await db.select().from(accountMetricSnapshots).where(eq(accountMetricSnapshots.projectId, ctx.project.id))) },
    ];

    const secrets: Secret[] = [
      { name: "tiktok access token", value: TT_ACCESS },
      { name: "tiktok refresh token", value: TT_REFRESH },
      { name: "pinterest access token", value: PIN_ACCESS },
      { name: "pinterest refresh token", value: PIN_REFRESH },
      { name: "x access token", value: X_ACCESS },
      { name: "x refresh token", value: X_REFRESH },
    ];
    expect(scan(pieces, [...ENV_SECRETS, ...secrets])).toEqual([]);
    // The three accounts' poll states are now rescheduled hours or days past this test's fake `NOW`,
    // which is still well before the real clock another test's unwrapped `runTick()` reads — park them
    // so they cannot leak a claim into a later file sharing this worker's database.
    await parkAllDueTargets();
  });

  it("activity events store no secret even when a provider, refresh or connect error echoes one (SC-006)", async () => {
    await parkAllDueTargets();
    const TOKEN = "scan-activity-token-9f8e7d6c5b4a39281706f5e4d3c2b1a0";
    const CODE = "scan-activity-code-0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    const PASSWORD_ECHO = "scan-activity-app-password-aabbccddeeff00112233445566";

    registerTestProvider({
      ...blueskyLikeProvider,
      key: "scan-activity-echo",
      displayName: "Echo",
      advance: async (ctx: PublishContext): Promise<StepResult> => ({
        kind: "retryable_error",
        error: `Provider rejected ${(ctx.account.credentials as { token: string }).token}`,
      }),
      refreshCredentials: async ({ credentials }) => ({ ok: false, transient: false, reason: `Refresh refused for ${(credentials as { token: string }).token}` }),
    } as SocialProvider);

    const env = await postsEnv();
    const repos = forSchedulerProject(env.project.id);
    const account = await createMockAccount(env.project.id, {}, { providerKey: "scan-activity-echo", displayName: "Echo", credentialsExpiresAt: new Date(Date.now() + 3_600_000) });
    await repos.accounts.setCredentials(account.id, accounts.encryptCredentials(account.id, { token: TOKEN }), new Date(Date.now() + 3_600_000));
    await createDueTarget(env.project.id, account.id);
    await runTick(tickConfig({ refreshMaxAccounts: 1000 }));
    await runTick(tickConfig({ refreshMaxAccounts: 1000 }));

    // A connect callback whose platform text and exchange message echo the authorization code.
    registerThrowaway();
    try {
      const sess = await sessionFor(env.owner.id);
      throwawayGroup.describeCallbackError = (params) => ({ code: "platform_error", message: `Denied for code ${params.get("code")}` });
      const begin = async () => new URL((await connect.startOAuthConnect(env.scope, { groupKey: "throwaway" }, sess)).url).searchParams.get("state")!;
      const caller = { userId: env.owner.id, sessionId: sess.sessionId };
      await connect.handleOAuthCallback(new URLSearchParams({ state: await begin(), error: "denied", error_description: CODE, code: CODE }), caller);
      delete throwawayGroup.describeCallbackError;
      vi.spyOn(throwawayGroup, "exchangeCode").mockResolvedValueOnce({ ok: false, message: `Bad code ${CODE}` });
      await connect.handleOAuthCallback(new URLSearchParams({ state: await begin(), code: CODE }), caller);
      void pageCandidate;
    } finally {
      delete throwawayGroup.describeCallbackError;
      unregisterThrowaway();
    }

    // A credential connect whose refusal echoes the app password.
    const pds = createFakePds();
    vi.stubGlobal("fetch", pds.fetch);
    pds.route("POST", "/xrpc/com.atproto.server.createSession", { status: 401, json: { error: "AuthenticationRequired", message: `no ${PASSWORD_ECHO}` } });
    await accounts.connectWithCredentials(env.scope, { providerKey: "bluesky", fields: { handle: "echo.bsky.social", appPassword: PASSWORD_ECHO, pdsUrl: "" } });
    vi.unstubAllGlobals();

    const rows = await eventsFor(env.project.id);
    // The scan covers something real: a needs-reauth and connect failures at least.
    expect(rows.map((r) => r.kind)).toEqual(expect.arrayContaining(["account_needs_reauth", "account_connect_failed"]));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const pieces: Piece[] = rows.map((r) => ({ place: `activity_events:${r.kind}`, text: `${r.message}\n${JSON.stringify(r.details)}` }));
    const echoed: Secret[] = [
      { name: "credential token", value: TOKEN },
      { name: "authorization code", value: CODE },
      { name: "app password", value: PASSWORD_ECHO },
    ];
    expect(scan(pieces, [...ENV_SECRETS, ...echoed])).toEqual([]);
  });

  it("a rendered problem email and a failing send never echo an SMTP credential (FR-001, FR-002)", async () => {
    const pieces: Piece[] = [];
    captureOutput(pieces);

    const token = mintUnsubscribeToken({ userId: "scan-user-id", projectId: "scan-project-id" }, new Date());
    const rendered = renderProblemEmail({
      cadence: "immediate",
      timeZone: "UTC",
      groups: [
        {
          name: "Scan Project",
          problems: [
            {
              outcomeLabel: "Failed",
              occurredAt: new Date(),
              platforms: [{ key: "bluesky", name: "Bluesky" }],
              accountName: "scan.bsky.social",
              message: "Could not reach the server.",
              href: "https://docket.scan.test/p/scan-project/activity",
            },
          ],
          overflow: 0,
          overflowHref: "https://docket.scan.test/p/scan-project/activity",
        },
      ],
      unsubscribeUrl: unsubscribeUrl(token),
    });
    pieces.push({ place: "rendered problem email", text: `${rendered.subject}\n${rendered.text}\n${rendered.html}` });

    const mailer = recordingMailer();
    mailer.queue({ kind: "rejected", code: 550, durationMs: 4 });
    setMailerForTests(mailer);
    try {
      const outcome = await getMailer()!.send({
        to: "scan-recipient@example.test",
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
      pieces.push({ place: "mailer send outcome", text: JSON.stringify(outcome) });
    } finally {
      setMailerForTests(undefined);
    }

    const smtpSecrets: Secret[] = [
      { name: "SMTP_HOST", value: ENV.SMTP_HOST },
      { name: "SMTP_USER", value: ENV.SMTP_USER },
      { name: "SMTP_PASSWORD", value: ENV.SMTP_PASSWORD },
      { name: "SMTP_FROM", value: ENV.SMTP_FROM },
    ];
    expect(scan(pieces, smtpSecrets)).toEqual([]);
  });
});
