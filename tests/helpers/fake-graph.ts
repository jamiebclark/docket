import { vi } from "vitest";

/** One scripted response. */
export type GraphReply =
  | { kind: "ok"; body: unknown; status?: number }
  /** A Graph error body: `{ error: { message, type, code, error_subcode? } }`. */
  | { kind: "graph_error"; code: number; message?: string; subcode?: number; type?: string; status?: number }
  | { kind: "http"; status: number; body?: string }
  /** A 2xx whose body is not JSON. */
  | { kind: "unparseable"; status?: number; body?: string }
  /** A 2xx JSON body without the `id` the caller needs. */
  | { kind: "missing_id" }
  /** Never answers; settles only when the request's signal aborts. */
  | { kind: "hang" }
  /** A 2xx whose body stream errors mid-read. */
  | { kind: "reset_mid_body" }
  /** `fetch` rejects before anything is sent. */
  | { kind: "pre_send_failure" };

export interface GraphRequest {
  method: string;
  /** Path only, e.g. `/v21.0/123/feed`. Never carries the query string or token. */
  path: string;
  /** Query and form params with `access_token` replaced by `[redacted]`. */
  params: Record<string, string>;
  /** Whether an access token was sent (header, query or body). */
  hadToken: boolean;
}

type Script = GraphReply | GraphReply[] | ((req: GraphRequest) => GraphReply);

export interface FakeGraph {
  /** Scripts `METHOD /path` (path without query). A list is consumed in order; the last entry repeats. */
  on(method: string, path: string, script: Script): FakeGraph;
  /** Replies to any unscripted request (default: a 404 Graph error). */
  fallback(reply: GraphReply): FakeGraph;
  readonly requests: GraphRequest[];
  /** Clears scripts and the request log. */
  reset(): void;
  /** Installs `fetch` through `vi.stubGlobal`. */
  install(): FakeGraph;
  /** Restores the real `fetch`. */
  uninstall(): void;
}

const TOKEN_PARAM = "access_token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

function render(reply: GraphReply, signal: AbortSignal | undefined): Promise<Response> {
  switch (reply.kind) {
    case "ok":
      return Promise.resolve(jsonResponse(reply.body, reply.status ?? 200));
    case "graph_error":
      return Promise.resolve(
        jsonResponse(
          {
            error: {
              message: reply.message ?? "Graph error",
              type: reply.type ?? "OAuthException",
              code: reply.code,
              ...(reply.subcode !== undefined ? { error_subcode: reply.subcode } : {}),
              fbtrace_id: "TRACE",
            },
          },
          reply.status ?? 400,
        ),
      );
    case "http":
      return Promise.resolve(new Response(reply.body ?? "", { status: reply.status }));
    case "unparseable":
      return Promise.resolve(new Response(reply.body ?? "<html>not json</html>", { status: reply.status ?? 200 }));
    case "missing_id":
      return Promise.resolve(jsonResponse({ success: true }));
    case "hang":
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason ?? abortError());
        signal?.addEventListener("abort", () => reject(signal.reason ?? abortError()), { once: true });
      });
    case "reset_mid_body": {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":"'));
          controller.error(new TypeError("terminated", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) }));
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "application/json" } }));
    }
    case "pre_send_failure":
      return Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) }));
  }
}

async function readParams(url: URL, init: RequestInit | undefined): Promise<{ params: Record<string, string>; token: boolean }> {
  const raw = new Map<string, string>(url.searchParams);
  const body = init?.body;
  if (body instanceof URLSearchParams) for (const [k, v] of body) raw.set(k, v);
  else if (body instanceof FormData) {
    for (const [k, v] of body) if (typeof v === "string") raw.set(k, v);
  } else if (typeof body === "string") {
    try {
      const json = JSON.parse(body) as Record<string, unknown>;
      for (const [k, v] of Object.entries(json)) raw.set(k, typeof v === "string" ? v : JSON.stringify(v));
    } catch {
      for (const [k, v] of new URLSearchParams(body)) raw.set(k, v);
    }
  }
  const headers = new Headers(init?.headers);
  const token = raw.has(TOKEN_PARAM) || headers.has("authorization");
  const params: Record<string, string> = {};
  for (const [k, v] of raw) params[k] = k === TOKEN_PARAM ? "[redacted]" : v;
  return { params, token };
}

export function createFakeGraph(): FakeGraph {
  const routes = new Map<string, { script: Script; used: number }>();
  let fallbackReply: GraphReply = { kind: "graph_error", code: 803, message: "Unknown path", status: 404 };
  const requests: GraphRequest[] = [];

  const fake: FakeGraph = {
    requests,
    on(method, path, script) {
      routes.set(`${method.toUpperCase()} ${path}`, { script, used: 0 });
      return fake;
    },
    fallback(reply) {
      fallbackReply = reply;
      return fake;
    },
    reset() {
      routes.clear();
      requests.length = 0;
      fallbackReply = { kind: "graph_error", code: 803, message: "Unknown path", status: 404 };
    },
    install() {
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : undefined;
        const url = new URL(request ? request.url : String(input));
        const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
        const { params, token } = await readParams(url, init);
        const entry: GraphRequest = { method, path: url.pathname, params, hadToken: token };
        requests.push(entry);
        const route = routes.get(`${method} ${url.pathname}`);
        let reply = fallbackReply;
        if (route) {
          const { script } = route;
          if (typeof script === "function") reply = script(entry);
          else if (Array.isArray(script)) reply = script[Math.min(route.used, script.length - 1)]!;
          else reply = script;
          route.used++;
        }
        const signal = init?.signal ?? request?.signal ?? undefined;
        return render(reply, signal ?? undefined);
      });
      return fake;
    },
    uninstall() {
      vi.unstubAllGlobals();
    },
  };
  return fake;
}
