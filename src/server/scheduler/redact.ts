const SENSITIVE_KEY = /token|secret|password|authorization|cookie|credential|session/i;

function collect(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (value.length >= 4) out.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((v) => collect(v, out));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((v) => collect(v, out));
  }
}

/** The string leaves of a credentials object: what must never appear in a stored summary. */
export function secretValues(credentials: unknown): string[] {
  const out = new Set<string>();
  collect(credentials, out);
  return [...out];
}

/**
 * Drops keys that look sensitive and replaces any string containing a known secret with
 * `"[redacted]"` (research D16). Defence in depth on top of the provider rule.
 */
export function redact<T>(value: T, knownSecrets: readonly string[] = []): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return knownSecrets.some((s) => s && v.includes(s)) ? "[redacted]" : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) {
        if (SENSITIVE_KEY.test(k)) continue;
        out[k] = walk(inner);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
