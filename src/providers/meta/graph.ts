// Stub (T002): see contracts/meta.md.
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
