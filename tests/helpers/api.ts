import type { ProjectScope } from "../../src/server/dal/scope";
import { postsEnv } from "./posts-env";
import { createJob } from "./factories";
import { createDraftPost, createMediaAsset, createSlots } from "./scheduling";

export type ApiPermission = "read" | "write_posts" | "generate" | "auto_approve" | "manage_jobs";

export const ALL_PERMISSIONS: readonly ApiPermission[] = ["read", "write_posts", "generate", "auto_approve", "manage_jobs"];

interface KeyOpts {
  name?: string;
  rateLimitPerMinute?: number;
  /** Days until expiry; omit for a key that never expires. */
  expiresInDays?: 30 | 90 | 365;
}

// The service and route land in later phases; loading them lazily keeps this helper typecheckable and importable until then.
const ROUTE = "../../src/app/api/v1/[[...path]]/route";
const KEYS_SERVICE = "../../src/server/services/api-keys";

/** Creates a key through the real service. `secret` is the only copy of the plaintext. */
export async function createKey(
  scope: ProjectScope,
  permissions: readonly ApiPermission[] = ["read"],
  opts: KeyOpts = {},
): Promise<{ secret: string; id: string }> {
  const svc = (await import(/* @vite-ignore */ KEYS_SERVICE)) as {
    createApiKey(
      scope: ProjectScope,
      input: { name: string; permissions: readonly ApiPermission[]; rateLimitPerMinute: number; expiry: "never" | "30" | "90" | "365" },
    ): Promise<{ key: { id: string }; secret: string }>;
  };
  const out = await svc.createApiKey(scope, {
    name: opts.name ?? `key-${Math.random().toString(36).slice(2, 8)}`,
    permissions,
    rateLimitPerMinute: opts.rateLimitPerMinute ?? 60,
    expiry: opts.expiresInDays === undefined ? "never" : (String(opts.expiresInDays) as "30" | "90" | "365"),
  });
  return { secret: out.secret, id: out.key.id };
}

export interface ApiOptions {
  /** Plaintext key; sent as a bearer token. Omit to send no credentials. */
  key?: string;
  /** Objects are sent as JSON; a FormData is sent as multipart; a string is sent raw. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Idempotency-Key header value. */
  idem?: string;
}

export interface ApiResult {
  status: number;
  headers: Headers;
  /** Parsed JSON, or null when the response has no JSON body. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests assert on arbitrary response shapes
  json: any;
  text: string;
  response: Response;
}

/** Calls the `/api/v1` route module directly with a `Request` (no listening server). */
export async function api(method: string, path: string, opts: ApiOptions = {}): Promise<ApiResult> {
  const mod = (await import(/* @vite-ignore */ ROUTE)) as Record<string, (req: Request, ctx: unknown) => Promise<Response>>;
  const handler = mod[method.toUpperCase()];
  if (!handler) throw new Error(`route module has no ${method} handler`);
  const headers = new Headers(opts.headers);
  if (opts.key) headers.set("authorization", `Bearer ${opts.key}`);
  if (opts.idem !== undefined) headers.set("idempotency-key", opts.idem);
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData || typeof opts.body === "string") body = opts.body as BodyInit;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  const url = new URL(`/api/v1${path.startsWith("/") ? path : `/${path}`}`, "http://localhost");
  const segments = url.pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean);
  const response = await handler(new Request(url, { method: method.toUpperCase(), headers, body }), {
    params: Promise.resolve({ path: segments }),
  });
  const text = await response.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see ApiResult.json
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json, text, response };
}

/** One project's fixtures: an account with a slot, an image, a draft post with a target, a job with items. */
async function oneProject() {
  const env = await postsEnv();
  const account = await env.account({}, false);
  await createSlots(env.project.id, account.id, [{ weekday: 1, localTime: "09:00" }]);
  const media = await createMediaAsset(env.project.id, { altText: "A test image" });
  const { post, targets } = await createDraftPost(env.project.id, { accountIds: [account.id], mediaIds: [media.id] });
  const { job, items } = await createJob(env.project.id, { items: 2, accountIds: [account.id] });
  const keys = {
    read: await createKey(env.scope, ["read"]),
    write: await createKey(env.scope, ["read", "write_posts"]),
    generate: await createKey(env.scope, ["read", "generate"]),
    manageJobs: await createKey(env.scope, ["read", "manage_jobs"]),
    all: await createKey(env.scope, ALL_PERMISSIONS),
  };
  return { ...env, account, media, post, targets, job, items, keys };
}

/** Two isolated projects (A and B), each fully populated, for cross-project and permission tests. */
export async function world() {
  const [a, b] = [await oneProject(), await oneProject()];
  return { a, b };
}
