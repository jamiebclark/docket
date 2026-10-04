# Quickstart verification (T088)

| Section | Status | Notes |
|---|---|---|
| 1. Quality gates | verified | `pnpm lint`, `typecheck`, `db:check`, `build` (incl. `storage-init.mjs`) pass. `pnpm test`: 823 passed, 1 skipped, 1 failed — `scheduler/concurrency.test.ts` hit a 10 s `afterEach` hook timeout under full parallel load; it passes alone (42 s). |
| 2. Targeted suites | verified-with-mocks | All listed suites ran inside the full run and passed. Storage uses an in-memory request handler / memory `Storage`; providers are mocks. |
| 3. Offline stack with MinIO | not verified | `S3_TEST_ENDPOINT` unset, so `tests/integration/storage-minio.test.ts` is **skipped**. `storage-init.mjs` is covered by `storage-init.test.ts` with a mocked client; no `docker compose --profile offline` run. |
| 4. Manual browser walk-through (steps 1–7) | not verified (needs a browser) | Server behaviour behind each step is covered by integration tests (accounts-ui, media/*, compose/*, posts/*, calendar, queue/*, actions-authz). Rendering, drag and drop, focus and screen-reader behaviour are unchecked (T089). |
