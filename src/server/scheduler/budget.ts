// Shared between the batch job runner and the standing-series producer (S36): one definition of
// "this call cannot finish before the tick's deadline" and one redacted log line.
import { redact } from "./redact";

export class Overran extends Error {}

export function withinBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Overran()), Math.max(ms, 0));
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function logLine(parts: string, resolvedKey: string | null): void {
  console.log(redact(parts, resolvedKey ? [resolvedKey] : []));
}
