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

import { eq } from "drizzle-orm";
import AccountsPage from "../../../src/app/p/[projectSlug]/accounts/page";
import ApiKeysPage from "../../../src/app/p/[projectSlug]/settings/api-keys/page";
import MembersPage from "../../../src/app/p/[projectSlug]/settings/members/page";
import WebhooksPage from "../../../src/app/p/[projectSlug]/settings/webhooks/page";
import FailuresPage from "../../../src/app/p/[projectSlug]/failures/page";
import { POST as composeCheck } from "../../../src/app/p/[projectSlug]/compose/check/route";
import { POST as authPost } from "../../../src/app/api/auth/[...all]/route";
import { GET as health } from "../../../src/app/api/health/route";
import { POST as tickPost } from "../../../src/app/api/internal/tick/route";
import { membershipAuditLog } from "../../../src/server/db/schema";
import { publishAttempts } from "../../../src/server/db/schema/attempts";
import { postTargets } from "../../../src/server/db/schema/posts";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import * as invitations from "../../../src/server/services/invitations";
import { createApiKey } from "../../../src/server/services/api-keys";
import { setStorageForTests } from "../../../src/server/storage";
import { api } from "../../helpers/api";
import { closeDb, testDb } from "../../helpers/db";
import { createFakePds, mintJwt } from "../../helpers/fake-pds";
import { createDueTarget, parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage } from "../../helpers/storage";
import { deliverAt, webhookEnv } from "../../helpers/webhooks";

afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});
afterEach(() => vi.restoreAllMocks());
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
];

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
    const env = await webhookEnv(["post.published", "post.failed"]);
    const pieces: Piece[] = [];
    captureOutput(pieces);

    // Credentials: a Bluesky account connected through the fake PDS (app password, access and refresh tokens).
    const pds = createFakePds();
    pds.route("POST", "/xrpc/com.atproto.server.createSession", { json: { accessJwt: ACCESS, refreshJwt: REFRESH, did: DID, handle: "me.bsky.social" } });
    pds.route("POST", "/xrpc/com.atproto.server.refreshSession", { json: { accessJwt: NEW_ACCESS, refreshJwt: NEW_REFRESH, did: DID, handle: "me.bsky.social" } });
    vi.stubGlobal("fetch", pds.fetch);
    const connected = await accounts.connectWithCredentials(env.scope, {
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
      text: JSON.stringify(await accounts.connectWithCredentials(env.scope, { providerKey: "bluesky", fields: { handle: "me.bsky.social", appPassword: APP_PASSWORD, pdsUrl: "" } })),
    });
    vi.stubGlobal("fetch", pds.fetch);

    // Publishing: a success and a rejection whose message echoes a token.
    for (const script of [{ json: { uri: `at://${DID}/app.bsky.feed.post/3k`, cid: "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgzmq2vz2m" } }, { status: 400, json: { error: "InvalidRequest", message: `bad ${NEW_ACCESS}` } }]) {
      pds.route("POST", "/xrpc/com.atproto.repo.createRecord", script);
      await createDueTarget(env.project.id, connected.account.id, { baseText: "hello" });
      await runTick({ config: {} });
    }

    // One-time secrets: asserted here, then kept out of the corpus by never adding these responses to it.
    const apiKey = await createApiKey(env.scope, { name: "scan", permissions: ["read"], rateLimitPerMinute: 60, expiry: "never" });
    expect(apiKey.secret.length).toBeGreaterThan(20);
    expect(env.secret.startsWith("whsec_")).toBe(true);
    const oneTime: Secret[] = [
      { name: "api key", value: apiKey.secret },
      { name: "webhook secret", value: env.secret },
    ];
    let inviteToken = "";
    await invitations.create(env.scope, { email: "scan-invitee@example.com", role: "editor" }, {
      async deliver(input) {
        inviteToken = new URL(input.acceptUrl).searchParams.get("token") ?? input.acceptUrl;
        return { kind: "manual_link", url: input.acceptUrl, expiresAt: input.invitation.expiresAt };
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

    // Route handlers.
    session.current = { user: { id: env.owner.id }, session: { id: "00000000-0000-4000-8000-000000000000" } };
    const slug = env.project.slug;
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
        "POST /api/auth/sign-in/email",
        async () =>
          authPost(
            new Request("http://localhost:3000/api/auth/sign-in/email", {
              method: "POST",
              headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-forwarded-for": "192.0.2.201" },
              body: JSON.stringify({ email: "nobody@example.com", password: "long-enough-password" }),
            }),
          ),
      ],
    ];
    for (const [place, call] of routeCalls) pieces.push(await responsePiece(place, await call()));

    // Rendered pages.
    const params = { params: Promise.resolve({ projectSlug: slug }) };
    const pages: [string, () => Promise<unknown>][] = [
      ["page: accounts", () => AccountsPage(params)],
      ["page: api keys", () => ApiKeysPage(params)],
      ["page: webhooks", () => WebhooksPage(params)],
      ["page: members", () => MembersPage(params)],
      ["page: failures", () => FailuresPage({ ...params, searchParams: Promise.resolve({}) })],
    ];
    for (const [place, render] of pages) {
      pieces.push({ place, text: renderToStaticMarkup((await render()) as never) });
    }

    // Stored rows.
    const db = testDb();
    pieces.push({ place: "publish_attempts", text: JSON.stringify(await db.select().from(publishAttempts).where(eq(publishAttempts.projectId, env.project.id))) });
    pieces.push({ place: "post_targets", text: JSON.stringify(await db.select().from(postTargets).where(eq(postTargets.projectId, env.project.id))) });
    pieces.push({ place: "membership_audit_log", text: JSON.stringify(await db.select().from(membershipAuditLog).where(eq(membershipAuditLog.projectId, env.project.id))) });
    const accountRows = await db.select().from(socialAccounts).where(eq(socialAccounts.projectId, env.project.id));
    pieces.push({ place: "social_accounts", text: JSON.stringify(accountRows.map((r) => ({ ...r, credentialsEncrypted: undefined }))) });
    for (const delivery of await env.scope.webhooks.listDeliveries(env.endpoint.id, { limit: 50 })) {
      pieces.push({ place: "webhook delivery", text: JSON.stringify(delivery) });
      pieces.push({ place: "webhook attempts", text: JSON.stringify(await env.scope.webhooks.listAttempts([delivery.id])) });
    }

    const credentials: Secret[] = [
      { name: "bluesky app password", value: APP_PASSWORD },
      ...[ACCESS, REFRESH, NEW_ACCESS, NEW_REFRESH].map((value, i) => ({ name: `bluesky token ${i + 1}`, value })),
    ];
    // Something was captured from every kind of place, so an empty corpus cannot pass.
    expect(new Set(pieces.map((p) => p.place.split(":")[0])).size).toBeGreaterThan(6);
    expect(scan(pieces, [...ENV_SECRETS, ...credentials, ...oneTime])).toEqual([]);
  });
});
