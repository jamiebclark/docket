import { vi } from "vitest";

/** One scripted reply (contracts/pinterest-connect.md, pinterest-publishing.md). */
export type PinterestReply =
  | { kind: "ok"; body: unknown; status?: number; headers?: Record<string, string> }
  /** `{ message }` at `status` (default 400). Pinterest's plain API error shape. */
  | { kind: "error"; message?: string; status?: number; headers?: Record<string, string> }
  /** The OAuth token endpoint's `{ error, error_description }`. */
  | { kind: "oauth_error"; status: number; error: string; error_description?: string }
  | { kind: "http"; status: number; body?: string; headers?: Record<string, string> }
  /** A 2xx with a non-JSON body. */
  | { kind: "unparseable"; status?: number }
  /** Settles only when the request's signal aborts (a lost connection, past the point of no return). */
  | { kind: "hang" }
  | { kind: "reset_mid_body" }
  /** `fetch` rejects before anything is sent (not_sent). */
  | { kind: "pre_send_failure" };

export interface PinterestRequest {
  method: string;
  host: string;
  /** Path only. */
  path: string;
  query: Record<string, string>;
  contentType: string;
  /** Form and JSON fields, a field equal to a known secret replaced by `[redacted]`. */
  fields: Record<string, unknown>;
  auth: "bearer" | "basic" | "none";
}

type Script = PinterestReply | PinterestReply[] | ((req: PinterestRequest) => PinterestReply);

export interface FakePinterest {
  /** `METHOD /path` on any host. A list is consumed in order; the last repeats. */
  on(method: string, path: string, script: Script): FakePinterest;
  /** Strings that must never be logged; they are redacted in `requests`. */
  secrets(...values: string[]): FakePinterest;
  readonly requests: PinterestRequest[];
  callsTo(method: string, path: string): PinterestRequest[];
  reset(): void;
  install(): FakePinterest;
  uninstall(): void;
}

/** Token endpoint success body. */
export const tokenReply = (overrides: Record<string, unknown> = {}) => ({
  access_token: "pina-access-token",
  token_type: "bearer",
  expires_in: 2_592_000,
  refresh_token: "pinr-refresh-token",
  refresh_token_expires_in: 5_184_000,
  scope: "user_accounts:read,boards:read,pins:write",
  ...overrides,
});

/** `GET /v5/user_account` success body. */
export const userAccountReply = (overrides: Record<string, unknown> = {}) => ({
  id: "pinterest-user-1",
  username: "ada",
  business_name: "Ada's Studio",
  ...overrides,
});

/** One `GET /v5/boards` page. */
export const boardsPage = (boards: readonly { id: string; name: string }[], bookmark: string | null = null) => ({
  items: boards,
  bookmark,
});

/** `POST /v5/pins` success body. */
export const pinReply = (overrides: Record<string, unknown> = {}) => ({
  id: "pin-1",
  ...overrides,
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

function render(reply: PinterestReply, signal: AbortSignal | undefined): Promise<Response> {
  switch (reply.kind) {
    case "ok":
      return Promise.resolve(json(reply.body, reply.status ?? 200, reply.headers));
    case "error":
      return Promise.resolve(json({ message: reply.message ?? "Refused" }, reply.status ?? 400, reply.headers));
    case "oauth_error":
      return Promise.resolve(json({ error: reply.error, ...(reply.error_description ? { error_description: reply.error_description } : {}) }, reply.status));
    case "http":
      return Promise.resolve(new Response(reply.body || null, { status: reply.status, headers: reply.headers }));
    case "unparseable":
      return Promise.resolve(new Response("<html>not json</html>", { status: reply.status ?? 200 }));
    case "hang":
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason ?? abortError());
        signal?.addEventListener("abort", () => reject(signal.reason ?? abortError()), { once: true });
      });
    case "reset_mid_body": {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":'));
          controller.error(new TypeError("terminated", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) }));
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "application/json" } }));
    }
    case "pre_send_failure":
      return Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) }));
  }
}

/** Routes `api.pinterest.com`. Never routes `api-sandbox.pinterest.com` (there is no script for it). */
export function createFakePinterest(): FakePinterest {
  const routes = new Map<string, { script: Script; used: number }>();
  const requests: PinterestRequest[] = [];
  let known: string[] = [];

  const redact = (v: unknown): unknown => (typeof v === "string" && known.includes(v) ? "[redacted]" : v);

  async function record(url: URL, init: RequestInit | undefined, method: string): Promise<PinterestRequest> {
    const headers = new Headers(init?.headers);
    const authHeader = headers.get("authorization") ?? "";
    const entry: PinterestRequest = {
      method,
      host: url.host,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      contentType: headers.get("content-type") ?? "",
      fields: {},
      auth: authHeader.startsWith("Bearer ") ? "bearer" : authHeader.startsWith("Basic ") ? "basic" : "none",
    };
    const body = init?.body;
    if (typeof body === "string" && body) {
      if (entry.contentType.includes("json")) {
        for (const [k, v] of Object.entries(JSON.parse(body) as Record<string, unknown>)) entry.fields[k] = redact(v);
      } else {
        for (const [k, v] of new URLSearchParams(body)) entry.fields[k] = redact(v);
      }
    }
    return entry;
  }

  const fake: FakePinterest = {
    requests,
    on(method, path, script) {
      routes.set(`${method.toUpperCase()} ${path}`, { script, used: 0 });
      return fake;
    },
    secrets(...values) {
      known = values;
      return fake;
    },
    callsTo(method, path) {
      return requests.filter((r) => r.method === method.toUpperCase() && r.path === path);
    },
    reset() {
      routes.clear();
      requests.length = 0;
      known = [];
    },
    install() {
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        const entry = await record(url, init, method);
        requests.push(entry);
        const route = routes.get(`${method} ${url.pathname}`);
        let reply: PinterestReply = { kind: "error", status: 404, message: "Unscripted path" };
        if (route) {
          const { script } = route;
          if (typeof script === "function") reply = script(entry);
          else if (Array.isArray(script)) reply = script[Math.min(route.used, script.length - 1)]!;
          else reply = script;
          route.used++;
        }
        return render(reply, init?.signal ?? undefined);
      });
      return fake;
    },
    uninstall() {
      vi.unstubAllGlobals();
    },
  };
  return fake;
}
