export interface MetaApp {
  graphBase: string;
  version: string;
}

export interface GraphError {
  code: number | null;
  subcode: number | null;
  type: string | null;
  message: string;
  traceId: string | null;
  transient: boolean;
}

export type GraphOutcome =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "graph_error"; status: number; error: GraphError }
  | { kind: "http_error"; status: number }
  | { kind: "unparseable"; status: number }
  | { kind: "network"; phase: "before_send" | "after_send" };

export interface GraphRequestInput {
  method: "GET" | "POST";
  /** "/{id}/feed", no version. */
  path: string;
  params?: Record<string, string>;
  /** Sent as `access_token`. */
  token?: string;
  signal: AbortSignal;
}

const PATH_ID = /^\d{1,40}(_\d{1,40})?$/;
const PRE_SEND_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

export const DEFAULT_GRAPH_BASE = "https://graph.facebook.com";

/** A path is a fixed word (`me`, `oauth`) or segments that are numeric ids or lowercase words. */
function validPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  const segments = path.slice(1).split("/");
  return segments.every((s) => PATH_ID.test(s) || /^[a-z_][a-z0-9_]{0,40}$/.test(s));
}

function causeChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

function networkPhase(err: unknown): "before_send" | "after_send" {
  for (const e of causeChain(err)) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && PRE_SEND_CODES.has(code)) return "before_send";
  }
  return "after_send";
}

function asInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function parseGraphError(body: unknown): GraphError | null {
  const e = (body as { error?: unknown } | null)?.error;
  if (!e || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  return {
    code: asInt(o.code),
    subcode: asInt(o.error_subcode),
    type: typeof o.type === "string" ? o.type : null,
    message: typeof o.message === "string" ? o.message : "Unknown error",
    traceId: typeof o.fbtrace_id === "string" ? o.fbtrace_id : null,
    transient: o.is_transient === true,
  };
}

async function send(url: string, init: RequestInit): Promise<GraphOutcome> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    return { kind: "network", phase: networkPhase(err) };
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { kind: "network", phase: "after_send" };
  }
  let body: unknown;
  let parsed = true;
  try {
    body = JSON.parse(text);
  } catch {
    parsed = false;
  }
  if (res.ok) return parsed ? { kind: "ok", status: res.status, body } : { kind: "unparseable", status: res.status };
  if (parsed) {
    const error = parseGraphError(body);
    if (error) return { kind: "graph_error", status: res.status, error };
  }
  return { kind: "http_error", status: res.status };
}

/** One fetch. POST sends a form-urlencoded body (token included); GET sends a query. Never exposes the URL or body. */
export function graphRequest(app: MetaApp, req: GraphRequestInput): Promise<GraphOutcome> {
  if (!validPath(req.path)) throw new Error("Invalid Graph path");
  const params = new URLSearchParams(req.params ?? {});
  if (req.token) params.set("access_token", req.token);
  const base = `${app.graphBase}/${app.version}${req.path}`;
  if (req.method === "GET") return send(`${base}?${params.toString()}`, { method: "GET", signal: req.signal });
  return send(base, {
    method: "POST",
    signal: req.signal,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
}

/** Follows `paging.next` only on the Graph origin, at most `pages` pages in total. */
export async function graphList(
  app: MetaApp,
  first: GraphRequestInput,
  pages: number,
): Promise<{ kind: "ok"; items: unknown[]; truncated: boolean } | Exclude<GraphOutcome, { kind: "ok" }>> {
  const items: unknown[] = [];
  let outcome = await graphRequest(app, first);
  for (let page = 1; ; page++) {
    if (outcome.kind !== "ok") return outcome;
    const body = outcome.body as { data?: unknown; paging?: { next?: unknown } } | null;
    if (!body || !Array.isArray(body.data)) return { kind: "unparseable", status: outcome.status };
    items.push(...body.data);
    const next = typeof body.paging?.next === "string" ? body.paging.next : null;
    if (!next) return { kind: "ok", items, truncated: false };
    if (page >= pages) return { kind: "ok", items, truncated: true };
    let url: URL;
    try {
      url = new URL(next);
    } catch {
      return { kind: "ok", items, truncated: true };
    }
    if (url.origin !== new URL(app.graphBase).origin) return { kind: "ok", items, truncated: true };
    outcome = await send(url.toString(), { method: "GET", signal: first.signal });
  }
}
