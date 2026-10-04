# Review: Bluesky provider (004)

Reviewed 61 files changed across 10 commits, against `e542733...HEAD` (merge-base with `origin/main`).

**Read in full:**
- **Provider:** every source file in `src/providers/bluesky/` (`index`, `settings`, `client`, `session`, `steps`, `facets`, `publish`, `errors`, `validate`).
- **Framework diffs:** `src/providers/types.ts`, `src/providers/registry.ts`, `src/server/dal/accounts.ts`, `src/server/dal/scheduler.ts`, `src/server/scheduler/{credentials,publishing,token-refresh,index}.ts` and `src/server/services/accounts.ts`.
- **Accounts screen:** `src/app/p/[projectSlug]/accounts/{actions.ts,page.tsx,ConnectCredentialsForm.tsx}`.
- **Tests:** `tests/helpers/fake-pds.ts`, plus `tests/integration/bluesky/{sessions,publish-e2e,images,no-secrets}.test.ts` and `tests/integration/scheduler/refresh-concurrency.test.ts`.
- **Docs:** the README, `docs/decisions.md` and `docs/adding-a-provider.md` diffs.

**Sampled** (by test name and the key tables): `src/providers/bluesky/{publish,session}.test.ts`, `tests/integration/bluesky/ambiguous.test.ts` and `tests/integration/accounts-credentials-connect.test.ts`.

**Not read line by line:** `tests/integration/scheduler/{publish-refresh,step-content,refresh}.test.ts`, `tests/integration/{accounts-ui,actions-authz,compose-check-route,no-plaintext,scope-check}.test.ts`, and the remaining provider unit tests (`errors`, `facets`, `settings`, `steps`, `validate`). I ran all of them (below), but did not audit their assertions. I also did not re-review the spec, plan, research and contract documents in `specs/`; they were inputs here, not output.

**Gates I ran:**
- `pnpm typecheck`: exits 0.
- `pnpm lint`: 0 errors, 1 warning (an unused `_ctx` at `tests/integration/scheduler/publish-refresh.test.ts:28`).
- `pnpm vitest run` over `src/providers`, `tests/integration/bluesky`, `tests/integration/scheduler`, `tests/helpers` and the six extended integration files: **40 files, 318 tests, all passed**.

I did **not** re-run `pnpm build`, `pnpm db:check` or the full `pnpm test`.

**Probe:** I also ran one throwaway script, outside the repo's code, against the installed `@atproto/api` to confirm how the XRPC client reports a 404 or 405 from a host that is not a PDS (used in F1).

## Verdict

The feature substantially satisfies the spec, and the passes fit together well:

- **The framework fixes are generic, and each has one owner.**
  - G1: one `connectWithCredentials`, one action and one form.
  - G2 and G3: one `applyRefreshResult`, shared by the scheduled refresh and the publish-time refresh, plus one refresh lease.
  - G4: `contentShape` uses the same `override_text ?? base_text` and media set as `effectiveContent`.
- **The safety properties hold and are tested through the real `runTick`:**
  - `create_post` is the only `mayPublish` step.
  - Timeout, reset, unparseable 2xx and 5xx on create are `ambiguous`.
  - A refresh runs outside `advance`, and rotated tokens are persisted under the lease before use.
  - Secrets are absent on every path.
- **No schema change.** The scope matches SC-008.

**One blocking defect: MAJOR F1.** The connect flow tells the user their handle or app password was rejected when the server address is not a PDS at all. A real 404 (or 405) from an ordinary website maps to the credentials message. That partly fails FR-008, and the test table never covers it. It is a small fix in `session.ts`.

The remaining findings are minor (docs drift, two test gaps, two edge behaviours) and safe to ship. I recommend fixing F1, then merging.

## Findings

- [x] MAJOR F1 — Connecting to a server that is not a PDS says "handle or app password not accepted", not "server not reachable / not a PDS".
      where:  src/providers/bluesky/session.ts:72, tests/integration/accounts-credentials-connect.test.ts:91
      why:    `connectAccount` maps every 4xx except 429 to "Bluesky did not accept that handle or app password." (field `appPassword`).
              I probed the installed client with a host answering `POST /xrpc/com.atproto.server.createSession`:
              - an HTML 404 surfaces as `XRPCError` status 404, error `XRPCNotSupported`;
              - an empty 405 surfaces as status 400, error `InvalidRequest`.

              Both are what an ordinary website (a mistyped PDS address) returns. So the most common "not a PDS" case tells the owner their password is wrong, and points them at the wrong field. FR-008 requires a distinct "PDS unreachable or not a PDS" message.

              The ticked task T022 ("each failure row") only tests "not a PDS" as a 2xx with a junk JSON body. The 404 and 405 shapes are untested.
      owed:   Map 404 / `XRPCNotSupported` to the `pdsUrl` "Could not reach a Bluesky server at …" message. Do the same for a 400 / 405 that carries no platform error body (the client's synthetic `InvalidRequest` whose message equals its name). Keep 401 / `AuthenticationRequired` as the credentials message. Add both shapes to the connect failure tables in `src/providers/bluesky/session.test.ts` and `tests/integration/accounts-credentials-connect.test.ts:87-92`.
      traces: FR-008, US1-AS3, FR-027 ("connect success and each connect failure")

- [ ] MINOR F2 — The upload step does not check that the fetched image matches its recorded size or type.
      where:  src/providers/bluesky/publish.ts:105-116
      why:    The type and the 2,000,000-byte cap are checked against the media row's metadata before the fetch. After the fetch, only the cap is re-checked. The fetched byte count is never compared with `item.bytes`, and the response `content-type` is never compared with `item.mimeType`. The edge case "a fetched image no longer matches its recorded size or type → fail before upload" is therefore only partly met.

              It is safe to ship: the size cap, the half that protects the platform, holds, and the bytes are still uploaded with the declared encoding.
      owed:   Fail the step (fatal, with a clear message) when `bytes.byteLength !== item.bytes` or the response content-type disagrees with `item.mimeType`.
      traces: spec Edge Cases ("A fetched image no longer matches…"), FR-015

- [ ] MINOR F3 — The scheduled refresh ignores `retryAt` after a transient failure and tries again on every tick.
      where:  src/server/scheduler/token-refresh.ts:64-67, src/server/scheduler/credentials.ts:42-48, src/server/dal/accounts.ts:208
      why:    `applyRefreshResult` records a transient failure by calling `recordRefresh`, which clears the refresh lease. `credentials_expires_at` stays unchanged, so the next tick claims the account again at once. A 429 on `refreshSession` with `Retry-After` is then retried every minute until the window closes. Only the publish-time path passes `retryAt` on, as `notBefore`.
      owed:   On a transient result, hold the refresh lease (`refresh_lease_until`) until `retryAt`, or until a short backoff when there is none, instead of clearing it.
      traces: FR-024, G3

- [ ] MINOR F4 — The Reconnect form pre-fills the PDS address with `https://bsky.social`, not the account's stored PDS.
      where:  src/app/p/[projectSlug]/accounts/page.tsx:101-108, src/app/p/[projectSlug]/accounts/ConnectCredentialsForm.tsx:9-10
      why:    `initialValues` uses each field's `defaultValue`. On reconnect it ignores the account's `settings.pdsUrl`. A self-hosted owner who submits without retyping the address sends their app password to `bsky.social` and is told it was not accepted.

              The field is visible and editable, so this is a usability and least-exposure issue, not a silent one. It does cut against US1-AS2: "every later call for that account go to that address".
      owed:   Pass the account's non-secret settings into the reconnect form as initial values for the matching non-secret fields.
      traces: US1-AS2, FR-009

- [ ] MINOR F5 — `docs/adding-a-provider.md` contradicts the code in several places.
      where:  docs/adding-a-provider.md:30, docs/adding-a-provider.md:82, docs/adding-a-provider.md:170, docs/adding-a-provider.md:173
      why:    The doc is wrong in four places:
              - The contract table at line 30 still lists `stepFor(state, settings)`. It omits `connectAccount?` and `needsRefresh?`.
              - §6, line 82, still states the two-argument form before the added paragraph.
              - §13 says that after `ExpiredToken` "the next tick refreshes". The engine actually refreshes in the same tick, after recording the result (`src/server/scheduler/publishing.ts:376-379`).
              - §13 says the state holds `blob.ipld()` refs. The code stores `BlobRef#toJSON()` (`src/providers/bluesky/publish.ts:120`), and the comment at `src/providers/bluesky/settings.ts:21` makes the same mismatch.

              The next provider author reads this file as the contract.
      owed:   Update the table, §6 and §13 to match the code.
      traces: FR-029

- [ ] MINOR F6 — Two FR-027 paths are not exercised as written.
      where:  src/providers/bluesky/publish.test.ts:238-254, tests/integration/bluesky/images.test.ts:111-121
      why:    The two gaps:
              - **No upload timeout test.** FR-027 lists "timeout on upload" as a retryable path, but the upload failure table has no `{ mode: "hang" }` row. It covers reset, 503, 429, pre-send and 400.
              - **A test that does less than its name.** The integration test named "re-uploads only the image whose upload timed out" injects a 503, not a timeout. It stops after the failed tick, so it never shows the retry uploading image 2 and not image 1 again (US3-AS4).

              The behaviour holds by construction (`stepForContent` keys off `blobs.length`, and the engine's timeout on a non-`mayPublish` step is retryable). The tests just do not prove it.
      owed:   Add a `hang` row to the upload table. Extend the integration test with a third tick that asserts exactly one more upload, then a successful `createRecord` that embeds both blobs.
      traces: FR-027, US3-AS4

- NOTE F7 — Rate-limit timing reads only `Retry-After` (`src/providers/bluesky/errors.ts:22-33`). Reading Bluesky's own `ratelimit-*` headers is deferred as NEEDS RESEARCH U1 and recorded at `docs/decisions.md:242`. Until U1 is closed:
  - a 429 on publish falls back to engine backoff, which the spec allows;
  - the connect form may show "try again later" with no time (US1-AS4 says "when the platform states one").

- NOTE F8 — Two pairs of passes each wrote the same helper:
  - `withTimeout` exists in both `src/server/scheduler/credentials.ts:63` and `src/server/scheduler/publishing.ts:204`.
  - `isUniqueViolation` exists in both `src/server/services/accounts.ts` (connect, G1) and `src/server/dal/targets.ts:64`.

  The copies are identical in behaviour today. Worth folding together when either is next touched.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-030) | 30 | 26 | 4 | 0 | 0 |
| Success criteria (SC-001–SC-009) | 9 | 8 | 1 | 0 | 0 |
| User-story acceptance scenarios (US1–US6) | 32 | 30 | 2 | 0 | 0 |
| Constitution principles (I–VII) | 7 | 7 | 0 | 0 | 0 |
| Plan framework gaps (G1–G4) | 4 | 4 | 0 | 0 | 0 |

**Partial items:**
- FR-008 (F1).
- FR-015 (F2).
- FR-027 (F1 and F6).
- FR-029 (F5).
- SC-009: lint, typecheck and the tests I ran pass. I did not re-run build or `db:check`; `docs/decisions.md` records them as passing at T051.
- US1-AS3 (F1).
- US3-AS4: the test gap in F6.

**Notes on specific items:**
- **FR-024 / G3:** I count it satisfied for publishing. F3 is a scheduled-section refinement.
- **Constitution V:** the deviation is the documented, generic one in the plan's Complexity Tracking. Outside the provider folder, the diff has no Bluesky-specific branch; `page.tsx` excludes only the mock, by key.

## What I could not check

- **Live Bluesky.** No real PDS, handle or app password was available. Everything is verified with mocks only, as the spec and `docs/decisions.md` say. T054 (the owner's live check, quickstart §7) is still open and correctly marked blocked.
- **The real platform's response shapes:** `createSession` errors, `ExpiredToken` versus `InvalidToken` on refresh, 429 headers (U1), and whether `uploadBlob` returns the blob JSON shape the fake PDS returns. The fake PDS encodes the plan's reading of the installed library. I confirmed that only for the 404 and 405 shapes used in F1.
- **The browser flow.** I read the form code but did not run it in a browser: focus moving to the first invalid field, password managers not autofilling, the screen-reader live region, and the `<details>` Reconnect disclosure.
- **The build gates.** I did not re-run `pnpm build`, the worker bundle or `pnpm db:check`. The esbuild worker bundle with `@atproto/api` is attested only by `docs/decisions.md`.
- **Grapheme parity.** The tests show the shared validator and `RichText.graphemeLength` agree on the test strings. I did not show they agree on every Unicode version the server and the platform may run.
- **Concurrency across processes.** The refresh race is tested with separate pool connections in one process, 20 iterations. It was not tested across real worker processes.
