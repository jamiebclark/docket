import { vi } from "vitest";

/** One scripted reply (contracts/tiktok-connect.md, tiktok-publishing.md). */
export type TikTokReply =
  | { kind: "ok"; body: unknown; status?: number; headers?: Record<string, string> }
  /** An error code in the body, `{ data: {}, error: { code, message } }`, at `status` (default 200). */
  | { kind: "error"; code: string; message?: string; status?: number; headers?: Record<string, string> }
  /** The OAuth token endpoint's `{ error, error_description }`. */
  | { kind: "oauth_error"; status: number; error: string; error_description?: string }
  | { kind: "http"; status: number; body?: string; headers?: Record<string, string> }
  /** A 2xx with a non-JSON body. */
  | { kind: "unparseable"; status?: number }
  /** Settles only when the request's signal aborts. */
  | { kind: "hang" }
  | { kind: "reset_mid_body" }
  /** `fetch` rejects before anything is sent. */
  | { kind: "pre_send_failure" };

export interface TikTokRequest {
  method: string;
  host: string;
  /** Path only. */
  path: string;
  query: Record<string, string>;
  contentType: string;
  /** Form and JSON fields, a field equal to a known secret replaced by `[redacted]`. */
  fields: Record<string, unknown>;
  auth: "bearer" | "none";
  /** For a chunk PUT: the byte count and the range headers. */
  upload?: { bytes: number; contentRange: string | null; contentLength: string | null };
}

type Script = TikTokReply | TikTokReply[] | ((req: TikTokRequest) => TikTokReply);

export interface FakeTikTok {
  /** `METHOD /path` on any host. A list is consumed in order; the last repeats. */
  on(method: string, path: string, script: Script): FakeTikTok;
  /** Strings that must never be logged; they are redacted in `requests`. */
  secrets(...values: string[]): FakeTikTok;
  readonly requests: TikTokRequest[];
  callsTo(method: string, path: string): TikTokRequest[];
  reset(): void;
  install(): FakeTikTok;
  uninstall(): void;
}

/** Token endpoint success body (research: `open_id` plus the OAuth fields). */
export const tokenReply = (overrides: Record<string, unknown> = {}) => ({
  access_token: "ACCESS-TOKEN-1",
  expires_in: 86_400,
  open_id: "open-id-1",
  refresh_token: "REFRESH-TOKEN-1",
  refresh_expires_in: 31_536_000,
  scope: "user.info.basic,video.publish",
  token_type: "Bearer",
  ...overrides,
});

/** Creator info success body. */
export const creatorReply = (overrides: Record<string, unknown> = {}) => ({
  data: {
    creator_avatar_url: "https://example.test/avatar.jpg",
    creator_username: "ada",
    creator_nickname: "Ada",
    privacy_level_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
    comment_disabled: false,
    duet_disabled: false,
    stitch_disabled: false,
    max_video_post_duration_sec: 300,
    ...overrides,
  },
  error: { code: "ok", message: "", log_id: "log-1" },
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

function render(reply: TikTokReply, signal: AbortSignal | undefined): Promise<Response> {
  switch (reply.kind) {
    case "ok":
      return Promise.resolve(json(reply.body, reply.status ?? 200, reply.headers));
    case "error":
      return Promise.resolve(
        json({ data: {}, error: { code: reply.code, message: reply.message ?? "", log_id: "log-err" } }, reply.status ?? 200, reply.headers),
      );
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
          controller.enqueue(new TextEncoder().encode('{"data":'));
          controller.error(new TypeError("terminated", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) }));
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "application/json" } }));
    }
    case "pre_send_failure":
      return Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) }));
  }
}

/** Routes `www.tiktok.com`, `open.tiktokapis.com` and any upload host by method and path. */
export function createFakeTikTok(): FakeTikTok {
  const routes = new Map<string, { script: Script; used: number }>();
  const requests: TikTokRequest[] = [];
  let known: string[] = [];

  const redact = (v: unknown): unknown => (typeof v === "string" && known.includes(v) ? "[redacted]" : v);

  async function record(url: URL, init: RequestInit | undefined, method: string): Promise<TikTokRequest> {
    const headers = new Headers(init?.headers);
    const entry: TikTokRequest = {
      method,
      host: url.host,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      contentType: headers.get("content-type") ?? "",
      fields: {},
      auth: (headers.get("authorization") ?? "").startsWith("Bearer ") ? "bearer" : "none",
    };
    const body = init?.body;
    if (typeof body === "string" && body) {
      if (entry.contentType.includes("json")) {
        for (const [k, v] of Object.entries(JSON.parse(body) as Record<string, unknown>)) entry.fields[k] = redact(v);
      } else {
        for (const [k, v] of new URLSearchParams(body)) entry.fields[k] = redact(v);
      }
    } else if (body && method === "PUT") {
      const bytes = body instanceof Blob ? body.size : (body as ArrayBufferView).byteLength;
      entry.upload = { bytes, contentRange: headers.get("content-range"), contentLength: headers.get("content-length") };
    }
    return entry;
  }

  const fake: FakeTikTok = {
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
        let reply: TikTokReply = { kind: "error", status: 404, code: "not_found", message: "Unscripted path" };
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
