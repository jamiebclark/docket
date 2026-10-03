// Worker entry, bundled to `.next/standalone/worker.mjs` by `build:worker`. It must not import `next/*`.
import { closeDb, schemaIsReady } from "./server/dal";
import { formatEnvIssues, getEnv, parseEnv } from "./server/env";
import { runTick } from "./server/scheduler";
import { runLoop } from "./server/scheduler/loop";
import { waitForSchema } from "./server/scheduler/schema-wait";

async function main(): Promise<void> {
  const parsed = parseEnv(process.env);
  if (!parsed.ok) {
    console.error(formatEnvIssues(parsed.issues));
    process.exit(1);
  }

  const controller = new AbortController();
  let signalled = false;
  const onSignal = () => {
    if (signalled) process.exit(1);
    signalled = true;
    console.log("Docket scheduler: shutting down…");
    controller.abort();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  if (await waitForSchema({ ready: schemaIsReady, signal: controller.signal })) {
    await runLoop({
      tick: () => runTick(),
      intervalMs: getEnv().WORKER_INTERVAL_SECONDS * 1000,
      signal: controller.signal,
    });
  }
  await closeDb();
  process.exit(0);
}

main().catch((error) => {
  console.error("Docket scheduler: fatal:", error instanceof Error ? error.message : "unknown error");
  process.exit(1);
});
