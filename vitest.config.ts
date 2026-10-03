import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    passWithNoTests: true,
    globalSetup: "tests/setup/global-setup.ts",
    setupFiles: ["tests/setup/scope-recorder.ts"],
    // Integration files share one test database; run them serially.
    fileParallelism: false,
    env: {
      BETTER_AUTH_SECRET: "test-secret-not-real-0123456789abcdef0123456789",
      CREDENTIALS_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      BETTER_AUTH_URL: "http://localhost:3000",
    },
  },
});
