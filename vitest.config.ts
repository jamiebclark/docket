import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import { testWorkerCount } from "./tests/setup/worker-databases";

// CI runs the timing-budget tests in a step of their own (see .github/workflows/ci.yml): beside thousands of
// parallel tests they measure contention, not the query. A plain `pnpm test` still runs them.
const PERF_TESTS = "tests/**/performance.test.ts";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    exclude: process.env.DOCKET_SKIP_PERF_TESTS === "1" ? [...configDefaults.exclude, PERF_TESTS] : configDefaults.exclude,
    passWithNoTests: true,
    globalSetup: "tests/setup/global-setup.ts",
    // worker-db.ts must stay first: it points each worker at its own database clone.
    setupFiles: ["tests/setup/worker-db.ts", "tests/setup/scope-recorder.ts", "tests/setup/webhook-loopback.ts"],
    // Files run in parallel, one database clone per worker (see global-setup.ts).
    maxWorkers: testWorkerCount(),
    // Parallel workers share CPU with password hashing and DB work; 5 s is too tight.
    testTimeout: 20_000,
    env: {
      BETTER_AUTH_SECRET: "test-secret-not-real-0123456789abcdef0123456789",
      CREDENTIALS_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      BETTER_AUTH_URL: "http://localhost:3000",
    },
  },
});
