import { availableParallelism } from "node:os";

/** How many Vitest workers (and therefore database clones) a run uses. */
export function testWorkerCount(): number {
  const fromEnv = Number(process.env.DOCKET_TEST_WORKERS);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

/** `…/docket_test` → `…/docket_w3_test`: keeps the `_test` suffix the safety check needs. */
export function workerDatabaseUrl(baseUrl: string, workerId: number): string {
  const url = new URL(baseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  url.pathname = `/${name.replace(/_test$/, "")}_w${workerId}_test`;
  return url.toString();
}
