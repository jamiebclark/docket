# Review: Bluesky provider (004), re-review after remediation

**This is the scoped re-review that constitution v1.4.0 calls for** ("Review is exhaustive once, then scoped", `.specify/memory/constitution.md:115-128`). It checks only two things:

- that the one blocking finding from the first review (MAJOR F1) is fixed;
- that the files the remediation changed introduced no regression.

It opens no new lines of inquiry. Anything new it noticed is recorded as MINOR, for the hardening entry.

The first review's full text is in git at `b48bed0`. Its file list, the gates it ran and the probe it used for F1 are there. Its findings are kept below unchanged, with a `re-review:` line added to F1.

**What I reviewed.** The feature merged to `main` as PR #9 (`7c15677`), from base `e542733`. It has 13 commits, `a8ce8b0`…`6ef87b0`. The remediation is two commits, and neither touched any other file:

- `3626a24`: `src/providers/bluesky/session.ts` and `tests/integration/accounts-credentials-connect.test.ts`;
- `6ef87b0`: the same two files, plus `src/providers/bluesky/session.test.ts`.

`git log 6ef87b0..HEAD` shows no later commit to any of those three files, so the present state on `main` (HEAD `69cff5d`) is the remediated code.

**Read in full:**

- `git show 3626a24 6ef87b0`;
- `src/providers/bluesky/session.ts:1-125`;
- `tests/integration/accounts-credentials-connect.test.ts:82-112`;
- `src/providers/bluesky/session.test.ts:64-95`;
- `src/app/p/[projectSlug]/accounts/ConnectCredentialsForm.tsx:9-61`, to see how a failure with no field is shown.

**Not re-reviewed:**

- MINOR F2–F6 and NOTE F7–F8: out of scope for a re-review.
- Code that later entries (005–010) added elsewhere in the provider, for example `10a4ff1`.

**Run:** following the constitution, I did not re-run the full suite, lint, typecheck or build. I ran only the affected tests: `pnpm vitest run src/providers/bluesky/session.test.ts tests/integration/accounts-credentials-connect.test.ts`, 2 files, 48 tests, all passed.

## Verdict

**F1 is fixed and nothing regressed. The feature satisfies the spec and is clear to stay merged; no remediation tasks were added.**

`connectAccount` now separates the three failure shapes:

- A 401 is the only status still blamed on the credentials (`src/providers/bluesky/session.ts:75`).
- A 404 or other non-400 4xx says the address "did not answer as a Bluesky server (PDS)" and marks `pdsUrl` (`src/providers/bluesky/session.ts:83`).
- An ambiguous 400 `InvalidRequest` names handle, password and server, with no field (`src/providers/bluesky/session.ts:80`).

The more specific branches still run first: sign-in code, takedown (a 400) and 429 (`src/providers/bluesky/session.ts:65-69`). So no earlier mapping changed.

Both new shapes are in both failure tables:

- unit: `src/providers/bluesky/session.test.ts:68-69`;
- integration: `tests/integration/accounts-credentials-connect.test.ts:92-93`.

Each row asserts the field (or no field), that the password never appears in the result, and that no account row was written.

The form already handles a failure with no field: it moves focus to the alert (`src/app/p/[projectSlug]/accounts/ConnectCredentialsForm.tsx:38-43`).

**Two new MINOR bookkeeping items (F9, F10).** Both are safe to ship.

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
      re-review: **fixed** in `3626a24` and `6ef87b0`; see `src/providers/bluesky/session.ts:75-85`.
              - The 404 shape maps to `pdsUrl` as owed. The message is "did not answer as a Bluesky server (PDS)" rather than "Could not reach", which fits FR-008's "not a PDS" better.
              - The 400 shape departs from what was owed, deliberately. A real PDS also answers 400 `InvalidRequest` to a malformed sign-in, so the code names all three places to look and marks no field, rather than blaming the address. That still meets FR-008: the credentials are no longer the only suspect, and the server address is named. See F10 for the record of this choice.
              - Both shapes are tested: `src/providers/bluesky/session.test.ts:68-69` and `tests/integration/accounts-credentials-connect.test.ts:92-93`. Both pass.

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

- [ ] MINOR F9 — `tasks.md` still shows the F1 remediation task as open, though the fix has merged.
      where:  specs/004-bluesky-provider/tasks.md:201
      why:    T055 is unchecked. `review.md` marks F1 resolved, and the code landed in `3626a24` and `6ef87b0`, both in PR #9. Anyone reading `tasks.md` alone would think a MAJOR was still owed. This phase may not re-tick existing tasks, so it is left for a human or the next implement pass.

              T055's own text also still asks for the 400/405 shape to map to `pdsUrl`, which the code deliberately does not do (F1 re-review line).
      owed:   Tick T055. A one-line note that the 400 case became the "check all three" message would keep the task and the code consistent.
      traces: F1, FR-008

- [ ] MINOR F10 — The judgement call on the ambiguous 400 is recorded only in a code comment, not in `docs/decisions.md`.
      where:  src/providers/bluesky/session.ts:78-82, docs/decisions.md
      why:    The constitution says each entry "appends any judgement call to `docs/decisions.md`". The remediation chose not to do what the review asked for one of its two shapes. That choice and its reason sit only in the comment at `src/providers/bluesky/session.ts:78-79`.

              A grep of `docs/decisions.md` for `InvalidRequest`, "ambiguous 400" or "not a PDS" finds nothing.
      owed:   Add a decisions entry, written as *What / Why / Reverse*. A 400 `InvalidRequest` on `createSession` names handle, password and server, with no field, because a PDS and a non-PDS host can both send it. *Reverse:* map it to `pdsUrl`.
      traces: F1, constitution "Docs"

- NOTE F7 — Rate-limit timing reads only `Retry-After` (`src/providers/bluesky/errors.ts:22-33`). Reading Bluesky's own `ratelimit-*` headers is deferred as NEEDS RESEARCH U1 and recorded at `docs/decisions.md:242`. Until U1 is closed:
  - a 429 on publish falls back to engine backoff, which the spec allows;
  - the connect form may show "try again later" with no time (US1-AS4 says "when the platform states one").

- NOTE F8 — Two pairs of passes each wrote the same helper:
  - `withTimeout` exists in both `src/server/scheduler/credentials.ts:63` and `src/server/scheduler/publishing.ts:204`.
  - `isUniqueViolation` exists in both `src/server/services/accounts.ts` (connect, G1) and `src/server/dal/targets.ts:64`.

  The copies are identical in behaviour today. Worth folding together when either is next touched.

## Coverage

These are the first review's counts, updated only where the remediation changed a verdict: FR-008, FR-027 (its F1 half) and US1-AS3.

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Earlier blocking findings (F1) | 1 | 1 fixed | 0 | 0 | 0 |
| Functional requirements (FR-001–FR-030) | 30 | 27 | 3 | 0 | 0 |
| Success criteria (SC-001–SC-009) | 9 | 8 | 1 | 0 | 0 |
| User-story acceptance scenarios (US1–US6) | 32 | 31 | 1 | 0 | 0 |
| Constitution principles (I–VII) | 7 | 7 | 0 | 0 | 0 |
| Plan framework gaps (G1–G4) | 4 | 4 | 0 | 0 | 0 |

**Still partial,** none of them blocking:
- FR-015 (F2).
- FR-027 (F6 only; its F1 half is now covered).
- FR-029 (F5).
- SC-009: the first review did not re-run build or `db:check`. CI ran the full gates on PR #9 before it merged.
- US3-AS4 (F6).

**Newly satisfied:** FR-008 and US1-AS3 (F1 fixed).

## What I could not check

- **Live Bluesky.** No real PDS, handle or app password was available. Everything is verified with mocks only, as the spec and `docs/decisions.md` say. T054 (the owner's live check, quickstart §7) is still open and correctly marked blocked.
- **The real platform's response shapes:** `createSession` errors, `ExpiredToken` versus `InvalidToken` on refresh, 429 headers (U1), and whether `uploadBlob` returns the blob JSON shape the fake PDS returns. The fake PDS encodes the plan's reading of the installed library. I confirmed that only for the 404 and 405 shapes used in F1.
- **The browser flow.** I read the form code but did not run it in a browser: focus moving to the first invalid field, password managers not autofilling, the screen-reader live region, and the `<details>` Reconnect disclosure.
- **The build gates.** I did not re-run `pnpm build`, the worker bundle or `pnpm db:check`. The esbuild worker bundle with `@atproto/api` is attested only by `docs/decisions.md`.
- **Grapheme parity.** The tests show the shared validator and `RichText.graphemeLength` agree on the test strings. I did not show they agree on every Unicode version the server and the platform may run.
- **Concurrency across processes.** The refresh race is tested with separate pool connections in one process, 20 iterations. It was not tested across real worker processes.
- **The re-review's limits.** I did not re-check whether later entries (005–010) fixed MINOR F2–F6, and I did not re-run the probe from the first review. The 404 and 400 shapes in the new test rows match what that probe recorded.
