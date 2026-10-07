import { vi } from "vitest";

/** One scripted reply (contracts/x-api.md). */
export type XReply =
  | { kind: "ok"; body: unknown; status?: number; headers?: Record<string, string> }
  | { kind: "problem"; status: number; title?: string; detail?: string; headers?: Record<string, string> }
  | { kind: "oauth_error"; status: number; error: string; error_description?: string }
  | { kind: "http"; status: number; body?: string; headers?: Record<string, string> }
  /** A 2xx with a non-JSON body. */
  | { kind: "unparseable"; status?: number }
  /** Settles only when the request's signal aborts. */
  | { kind: "hang" }
  | { kind: "reset_mid_body" }
  /** `fetch` rejects before anything is sent. */
  | { kind: "pre_send_failure" };

export interface XRequest {
  method: string;
  host: string;
  /** Path only. */
  path: string;
  query: Record<string, string>;
  /** Form and JSON fields, a field equal to a known secret replaced by `[redacted]`. */
  fields: Record<string, unknown>;
  auth: "basic" | "bearer" | "none";
  /** The client id decoded from Basic auth, never the secret. */
  basicUser?: string;
  multipart?: { fields: string[]; mediaBytes: number; mediaType: string };
}

type Script = XReply | XReply[] | ((req: XRequest) => XReply);

export interface FakeX {
  /** `METHOD /path`, or `GET /2/media/upload?command=STATUS` for STATUS. A list is consumed in order; the last repeats. */
  on(method: string, path: string, script: Script): FakeX;
  /** Strings that must never be logged; they are redacted in `requests`. */
  secrets(...values: string[]): FakeX;
  readonly requests: XRequest[];
  callsTo(method: string, path: string): XRequest[];
  reset(): void;
  install(): FakeX;
  uninstall(): void;
}

export const rateLimited = ({ remaining, reset, limit = 100 }: { remaining: number; reset: number; limit?: number }) => ({
  "x-rate-limit-limit": String(limit),
  "x-rate-limit-remaining": String(remaining),
  "x-rate-limit-reset": String(reset),
});

export const tokenReply = (overrides: Record<string, unknown> = {}) => ({
  token_type: "bearer",
  expires_in: 7200,
  access_token: "ACCESS-TOKEN-1",
  refresh_token: "REFRESH-TOKEN-1",
  scope: "tweet.read tweet.write users.read media.write offline.access",
  ...overrides,
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

function render(reply: XReply, signal: AbortSignal | undefined): Promise<Response> {
  switch (reply.kind) {
    case "ok":
      return Promise.resolve(json(reply.body, reply.status ?? 200, reply.headers));
    case "problem":
      return Promise.resolve(
        json(
          { type: "about:blank", title: reply.title ?? "Error", status: reply.status, ...(reply.detail ? { detail: reply.detail } : {}) },
          reply.status,
          reply.headers,
        ),
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

export function createFakeX(): FakeX {
  const routes = new Map<string, { script: Script; used: number }>();
  const requests: XRequest[] = [];
  let known: string[] = [];

  const redact = (v: unknown): unknown => (typeof v === "string" && known.includes(v) ? "[redacted]" : v);

  async function record(url: URL, init: RequestInit | undefined, method: string): Promise<XRequest> {
    const headers = new Headers(init?.headers);
    const authz = headers.get("authorization") ?? "";
    const entry: XRequest = {
      method,
      host: url.host,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      fields: {},
      auth: authz.startsWith("Basic ") ? "basic" : authz.startsWith("Bearer ") ? "bearer" : "none",
    };
    if (entry.auth === "basic") entry.basicUser = Buffer.from(authz.slice(6), "base64").toString().split(":")[0];
    const body = init?.body;
    if (body instanceof FormData) {
      const fieldNames: string[] = [];
      let mediaBytes = 0;
      let mediaType = "";
      for (const [k, v] of body) {
        fieldNames.push(k);
        if (typeof v === "string") entry.fields[k] = redact(v);
        else {
          mediaBytes = v.size;
          mediaType = v.type;
        }
      }
      entry.multipart = { fields: fieldNames, mediaBytes, mediaType };
    } else if (typeof body === "string" && body) {
      const ct = headers.get("content-type") ?? "";
      if (ct.includes("json")) {
        for (const [k, v] of Object.entries(JSON.parse(body) as Record<string, unknown>)) entry.fields[k] = redact(v);
      } else {
        for (const [k, v] of new URLSearchParams(body)) entry.fields[k] = redact(v);
      }
    }
    return entry;
  }

  const fake: FakeX = {
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
        const command = url.searchParams.get("command");
        const route = routes.get(`${method} ${url.pathname}${command ? `?command=${command}` : ""}`) ?? routes.get(`${method} ${url.pathname}`);
        let reply: XReply = { kind: "problem", status: 404, title: "Not Found", detail: "Unscripted path" };
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
