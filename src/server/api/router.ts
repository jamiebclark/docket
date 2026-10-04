import { OPERATIONS, type AnyApiOperation } from "./operations";

export type RouteMatch =
  | { kind: "match"; op: AnyApiOperation; params: Record<string, string> }
  | { kind: "not_found" }
  | { kind: "method_not_allowed"; allow: string[] };

function matchPath(template: string, segments: string[]): Record<string, string> | null {
  const parts = template.split("/").filter(Boolean);
  if (parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const seg = segments[i]!;
    if (part.startsWith("{") && part.endsWith("}")) params[part.slice(1, -1)] = seg;
    else if (part !== seg) return null;
  }
  return params;
}

/** Matches the path template first, then the method (research D6). HEAD is served by its GET. */
export function matchOperation(method: string, segments: string[]): RouteMatch {
  const verb = method === "HEAD" ? "GET" : method;
  const allow = new Set<string>();
  for (const op of OPERATIONS) {
    const params = matchPath(op.path, segments);
    if (!params) continue;
    if (op.method === verb) return { kind: "match", op, params };
    allow.add(op.method);
    if (op.method === "GET") allow.add("HEAD");
  }
  if (allow.size === 0) return { kind: "not_found" };
  return { kind: "method_not_allowed", allow: [...allow].sort() };
}

/** Methods the path answers, for OPTIONS. Empty when no path matches. */
export function allowedMethods(segments: string[]): string[] {
  const allow = new Set<string>(["OPTIONS"]);
  let any = false;
  for (const op of OPERATIONS) {
    if (!matchPath(op.path, segments)) continue;
    any = true;
    allow.add(op.method);
    if (op.method === "GET") allow.add("HEAD");
  }
  return any ? [...allow].sort() : [];
}
