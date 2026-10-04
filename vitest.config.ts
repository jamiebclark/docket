import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { testWorkerCount } from "./tests/setup/worker-databases";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
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
