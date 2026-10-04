/**
 * A scripted `fetch` standing in for a Bluesky PDS. No network: routes are matched on method + pathname and answer
 * with a canned response or one of the failure modes real calls exhibit. Every request is logged.
 */

export interface RecordedRequest {
  url: string;
  path: string;
  method: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** Parsed JSON when the body is JSON, the raw bytes for binary uploads, otherwise the text; `null` when empty. */
  body: unknown;
}

export interface PlainResponse {
  status?: number;
  headers?: Record<string, string>;
  /** Serialised as JSON (content-type set) unless `text` or `bytes` is given. */
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
}

export type FakeResponse =
  | PlainResponse
  /** Never answers; rejects with the abort reason once the request's signal aborts. */
  | { mode: "hang" }
  /** Answers 200 and the first part of the body, then the stream errors (connection reset). */
  | { mode: "reset-mid-body"; partial?: string }
  /** Fails before anything is sent: `TypeError("fetch failed", { cause: { code } })`. */
  | { mode: "pre-send-failure"; code?: string }
  /** Waits for `latch` to resolve (or reject), then answers as `then`. */
  | { mode: "delayed"; latch: Promise<unknown>; then: FakeResponse };

export type RouteScript = FakeResponse | readonly FakeResponse[] | ((req: RecordedRequest, call: number) => FakeResponse);

export interface FakePds {
  /** Pass as `fetch` (or stub the global). */
  fetch: typeof fetch;
  requests: RecordedRequest[];
  /** Answers `METHOD path`. An array is consumed in order and its last entry repeats. */
  route(method: string, path: string, script: RouteScript): FakePds;
  /** Requests received for `METHOD path`. */
  callsTo(method: string, path: string): RecordedRequest[];
  reset(): void;
}

/** A latch to hold a response open: `release()` lets `delayed` responses through. */
export function latch(): { promise: Promise<void>; release: () => void; fail: (e: unknown) => void } {
  let release!: () => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

const headerRecord = (h: Headers): Record<string, string> => Object.fromEntries([...h.entries()].map(([k, v]) => [k.toLowerCase(), v]));

async function readBody(init: RequestInit | undefined, headers: Record<string, string>): Promise<unknown> {
  const raw = init?.body;
  if (raw === undefined || raw === null) return null;
  const bytes =
    typeof raw === "string"
      ? new TextEncoder().encode(raw)
      : raw instanceof Uint8Array
        ? raw
        : raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : new Uint8Array(await new Response(raw as BodyInit).arrayBuffer());
  const type = headers["content-type"] ?? "";
  if (type.includes("json")) {
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return new TextDecoder().decode(bytes);
    }
  }
  return type.startsWith("text/") ? new TextDecoder().decode(bytes) : bytes;
}

function build(res: PlainResponse): Response {
  const headers = new Headers(res.headers);
  let body: BodyInit | null = null;
  if (res.bytes) body = res.bytes as unknown as BodyInit;
  else if (res.text !== undefined) body = res.text;
  else if (res.json !== undefined) {
    body = JSON.stringify(res.json);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  return new Response(body, { status: res.status ?? 200, headers });
}

export function createFakePds(): FakePds {
  const requests: RecordedRequest[] = [];
  const routes = new Map<string, { script: RouteScript; calls: number }>();
  const key = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

  async function respond(res: FakeResponse, signal: AbortSignal | null | undefined): Promise<Response> {
    if (!("mode" in res)) return build(res);
    switch (res.mode) {
      case "pre-send-failure":
        throw new TypeError("fetch failed", { cause: { code: res.code ?? "ECONNREFUSED" } });
      case "hang":
        return new Promise<Response>((_, reject) => {
          const abort = () => reject(signal?.reason ?? new DOMException("This operation was aborted", "AbortError"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      case "reset-mid-body": {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(res.partial ?? '{"uri":"at://did:plc:fake/app.bsky'));
            controller.error(new TypeError("terminated", { cause: { code: "ECONNRESET" } }));
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
      }
      case "delayed":
        await res.latch;
        return respond(res.then, signal);
    }
  }

  const pds: FakePds = {
    requests,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request ? request.url : String(input));
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
      const headers = headerRecord(new Headers(init?.headers ?? request?.headers));
      const effectiveInit = request && init?.body === undefined ? { ...init, body: await request.clone().arrayBuffer() } : init;
      const recorded: RecordedRequest = { url: url.href, path: url.pathname, method, headers, body: await readBody(effectiveInit, headers) };
      requests.push(recorded);
      const entry = routes.get(key(method, url.pathname));
      if (!entry) throw new Error(`fake-pds: no route for ${method} ${url.pathname}`);
      const call = entry.calls++;
      const { script } = entry;
      const res = typeof script === "function" ? script(recorded, call) : Array.isArray(script) ? script[Math.min(call, script.length - 1)]! : (script as FakeResponse);
      return respond(res, init?.signal ?? request?.signal);
    }) as typeof fetch,
    route(method, path, script) {
      routes.set(key(method, path), { script, calls: 0 });
      return pds;
    },
    callsTo: (method, path) => requests.filter((r) => r.method === method.toUpperCase() && r.path === path),
    reset() {
      requests.length = 0;
      routes.clear();
    },
  };
  return pds;
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** An unsigned JWT with the given `exp` (a Date, or seconds since the epoch). */
export function mintJwt(exp: Date | number, claims: Record<string, unknown> = {}): string {
  const seconds = exp instanceof Date ? Math.floor(exp.getTime() / 1000) : exp;
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ exp: seconds, ...claims })}.fake-signature`;
}
