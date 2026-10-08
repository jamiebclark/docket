# Implementation Plan: Facebook Page video

**Branch**: `021-facebook-video` | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/021-facebook-video/spec.md`

## Summary

Entry 4 of the video roadmap. Facebook Pages gain two ways to publish one video, chosen per target through the existing G19 "Post as" choice, with Page video as the default (D1, D2). Decisions P1–P22 are in [research.md](./research.md).

**Page video** (US1) is one request, `POST /{page}/videos`:

- It sends `file_url`, the stored video's public address, and `description` (D6, D12).
- It is published when Facebook returns the video id, with no status polling (D11).
- Error 389 adds the public-storage guidance.

**Reel** (US2, US3) runs five steps on the existing resumable step machine:

1. **`start_reel`** (`upload_phase=start`) reserves one unit of a new 30-per-24-h creation allowance (G22, D10).
2. **`upload_reel`** first checks that the returned address is `https://rupload.facebook.com/video-upload/<video id>` (D13). It then sends one header-only request: `Authorization: OAuth <token>` and `file_url`, with no bytes (D5).
3. **`check_upload`** runs until the upload is complete. It fails at 30 min.
4. **`finish_reel`** (`video_state=PUBLISHED`) is the only step that may publish.
5. **`check_publish`** runs until Facebook confirms the Reel. It is ambiguous at 60 min.

**Polling.** Both checks are paced 1 min, then 5 min (D8). They return `continue`, never `retryable_error`, so only the ceilings end them (P11). The status reply's nesting is UNVERIFIED, so it is read by one conservative function (P9).

**Steps after publishing** (G23, P12–P13). This entry adds one generic engine change:

- A step marked `afterPublish` (`check_publish`) is never failed by the engine itself. Engine-side failures, exhausted retries and repeated interruptions become ambiguous instead.
- An `ambiguous` result may also flag the account's credentials.

Without G23, D9 ("once finish is sent, only Facebook's own error report may fail it") could be broken by paths the provider never sees.

**Validation and requirements** (US4, US5):

- **Limits.** The base `video` block holds the Page video limits (one video, no images, MP4 or MOV). `byPostType.reel` holds the Reel limits: H.264, HEVC, VP9 or AV1 with AAC or no audio; 3–90 s; at least 540 × 960; aspect 0.556–0.569; 24–60 fps (P1).
- **Wording.** `validateFacebook` names the type in every video refusal and says Docket does not adjust video yet. When a Page video would accept the file, it suggests one. A video with images, or two videos, gets one rule message (P2).
- **Summary notes.** `requirementsOf` shows `byPostType[type].notes` for every type, not only `carousel`. This generic fix leaves Instagram's output unchanged (P3).
- **Badges** follow the default, Page video, with no code change.

**Not built here** (FR-032–FR-036):

- Stories;
- video with images, or several videos, in one Facebook post;
- cropping, trimming or encoding (entry 6);
- Threads (entry 5), Bluesky (entry 7) and TikTok (entry 8), and any Instagram change;
- byte or chunked upload, Page video status checks, optional Reel or Page video fields, Facebook-side scheduling, API video upload and generator video. All are unowned and recorded in `docs/feature-map.md`.

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS.

**Primary Dependencies**: all already installed; no new runtime dependency.

- **Next.js 16.3.8 and React 19.2.8.** No route, page or component file changes. The composer's "Post as" fieldset and the summary are already declaration-driven (019). AGENTS.md's rule to read `node_modules/next/dist/docs/` applies only if a task finds it must touch a component; none is planned.
- **zod 4.6.5.** The Facebook state union (data-model §3).
- **Drizzle 0.45.3.** No schema change.
- **Vitest 5.** Unit and integration suites.

**Storage**: PostgreSQL, with no migration. The generic storage from 019 is reused:

- `post_targets.chosen_post_type` holds the choice;
- `allowance_uses` holds the Reel start reservations;
- `post_targets.step_state` holds the Reel state (JSON).

Videos are fetched by Facebook from the existing public bucket (018), so there is no storage change.

**Testing**: Vitest against real Postgres with run-scoped databases.

- **Mocked Graph and rupload.** `tests/helpers/fake-graph.ts` stubs `fetch` globally. It gains recorded `headers` (with `authorization` redacted) and `bodyBytes` (P21).
- **Clock.** Pinned by `atTime`; no sleeping and no live calls (constitution II).
- **Fixtures.** Video rows come from `createVideoAsset`, through a new `facebookVideoSetup` (P22).
- **Unchanged files.** The existing Facebook and Instagram suites stay unchanged (SC-008).

See [quickstart.md](./quickstart.md).

**Target Platform**: self-hosted Linux containers (`web` and `worker` from one image) on Docker Compose, Unraid or Neon. Publishing runs in `runTick` wherever the scheduler runs. No ffmpeg is used by this entry.

**Project Type**: web application (Next.js App Router monolith with a worker process).

**Performance Goals**:

- **SC-004.** A Reel whose upload or processing completes within 5 min advances within 2 ticks.
- **SC-005.** At most 10 upload checks and 16 publish checks per Reel.
- **Page video.** One Graph call.
- **Allowance cost.** One indexed range query per `start_reel` lease (existing G22 code).

**Constraints**:

- One request per step, with every wait expressed as `notBefore` (FR-011).
- No provider call inside a held transaction.
- DB clock everywhere.
- The Page token goes only to the Graph base and the checked upload address. It is never logged (FR-015, VII).
- Image and text requests are unchanged (FR-019).
- No limit literals in UI code (FR-021).

**Scale/Scope**: 1 provider changed (Facebook), plus 1 generic engine change (G23) and 1 generic summary fix (G20 notes).

- **New source files:** about 2: `src/providers/facebook/requests.ts` and `src/providers/facebook/state.ts` (the pace constants and `validReelState`; the schema stays in `settings.ts`).
- **Edited source files:** about 12:
  - the Facebook capabilities, index, settings, steps, publish and validate files;
  - `meta/graph.ts`;
  - `types.ts` and `requirements.ts`;
  - the scheduler's `publishing.ts`, `record.ts` and `recovery.ts`.
- **Tests:** about 7 new files and about 10 extended.
- **Docs:** 6 files (`limits`, `adding-a-provider`, `feature-map`, `meta-setup` and `decisions` under `docs/`, plus the README feature list if it names Facebook formats).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How this plan meets it |
|---|---|---|
| I. Verified facts over memory | PASS | Every Facebook fact comes from `docs/research/meta-video.md` (Facebook Pages) or `meta.md`: edges, phases, headers, the `file_url` rules, Reel specs and errors, the 30-per-24-h cap, `graph.facebook.com` for video, and permissions. Three facts are UNVERIFIED in the research: the status nesting, the upload reply and the per-phase status values. Each is read conservatively in one named function, so an unknown value never means complete, published or failed (P7, P9). They are covered by mocked tests and listed as owed live checks. Code facts F1–F15 were read from the repository in this phase. There is no conflict between request and research (spec "Request vs research"). |
| II. Nothing is "working" unless it ran | PASS | Every behaviour has an automated test with mocked replies (quickstart §1–§3). Real Facebook publishing is reported as "verified with mocks only", and four live checks are owed (quickstart §6, `docs/meta-setup.md`). |
| III. Project isolation | PASS | No new table or query. The allowance reuses `allowance_uses` through the claim context (019, already project-scoped). G23's extra `contentShape` call in the recovery branch uses the same scoped claim context. Roles are unchanged: choosing a type needs `post: edit`, as for Instagram. |
| IV. One service layer | PASS | The one shared validator (`validateResolvedContent` → `validateFacebook`) serves the composer check, the scheduling gate and the engine re-check. The one resolver (`resolvePostType`) serves every caller. The allowance has one implementation (the engine). G23 is one rule in the engine, not per caller. |
| V. Providers are plug-ins | JUSTIFIED | Facebook's behaviour lives in `src/providers/facebook/` plus a Meta-shared `ruploadRequest` in `src/providers/meta/`. The composer, the schema and the API get no Facebook code: G19–G22 are reused as designed. One **generic** engine change, G23 `afterPublish` plus `ambiguous.credentialsInvalid`, is optional and inert for providers that do not set it. It is recorded in `docs/decisions.md` and `docs/adding-a-provider.md` (Complexity Tracking below). The one generic summary fix (notes for any type) is in `src/providers/`, not the composer. `advance` keeps its five result kinds, only `finish_reel` and `publish_video` may publish, and an unknown publish outcome stays ambiguous and is never retried. |
| VI. Boring, few dependencies | PASS | No new package and no infrastructure. The upload uses the platform `fetch` through the existing `send`. |
| VII. Secrets never leak | PASS | The token is in the `Authorization` header only for the checked rupload address, and in `access_token` only for Graph. Status details and messages pass through `scrub` with the token. Summaries record the upload host, never the address or header. `no-secrets.test.ts` gains a Reel and a Page video flow whose replies echo the token. No new env var. |
| Engineering constraints | PASS | `runTick` stays bounded at one request per step, with waits as `nextAttemptAt` and no sleeping. Claims keep `FOR UPDATE SKIP LOCKED` and the lease, and no provider call happens in a held transaction. Times are UTC on the DB clock. There is no UI change; the existing "Post as" fieldset already meets `docket-ui` (labelled, keyboard, focus, polite announcement). Video and reels are out of scope "until a spec says otherwise"; this spec says otherwise for Facebook Page video and Page Reels only. Stories stay out. |
| Workflow | PASS | Conventional commits with explicit paths. The `## 021` section of `docs/decisions.md` (D1–D15, G23, plan decisions) is written in this phase. Checks run in proportion: targeted tests per task, then one full pass at the end of implement (`lint`, `typecheck`, `test`, `db:check`, `build`). |

**Post-design re-check (after Phase 1)**: PASS, with the justified generic change below.

- **Every new member is optional:** `StepInfo.afterPublish`, `ambiguous.credentialsInvalid`, `MetaApp.uploadHost`, and the new `GraphRequest` fields in tests.
- **No migration.** Old Facebook photo states still parse; the union keeps the v1 photo shape, and a test pins it.
- **One reading stricter than the spec's letter.** FR-008 says "upload complete (or any later state)". The plan counts `upload_complete`, `processing` and `ready` as complete, but not unknown values (P9). That is safe, because an unknown value is checked again until the ceiling.
- **One judgement call on wording.** FR-014 asks the wait message to name "how many are used". The existing G22 message does ("30 of 30 used in the last 24 hours"), so no engine wording change is needed (P4).

## Project Structure

### Documentation (this feature)

```text
specs/021-facebook-video/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0: code facts F1–F15, decisions P1–P22
├── data-model.md        # Phase 1: G23 contract types, capabilities, Reel state, requests module, summary values
├── quickstart.md        # Phase 1: validation runs and owed live checks
├── contracts/
│   ├── facebook-capabilities.md   # declaration, validation wording, summary, badges, tests
│   ├── facebook-publishing.md     # Page video and the five Reel steps: requests, outcomes, pace, tests
│   └── after-publish-steps.md     # G23: engine rule, ambiguous with credentialsInvalid, tests
├── checklists/
└── tasks.md             # Phase 2 (/speckit-tasks), not created here
```

### Source Code (repository root)

```text
src/
├── providers/
│   ├── types.ts                         # StepInfo.afterPublish; ambiguous.credentialsInvalid (G23)
│   ├── requirements.ts                  # video.notes from byPostType[shown] (+ test)
│   ├── meta/graph.ts                    # MetaApp.uploadHost; ruploadRequest (+ test)
│   └── facebook/
│       ├── capabilities.ts              # FACEBOOK_PAGE_VIDEO, FACEBOOK_REEL_VIDEO, byPostType, postTypes, postTypeChoices
│       ├── index.ts                     # creationAllowance; stepFor passes kinds/postType
│       ├── settings.ts                  # facebookStateSchema = photo | reel union
│       ├── state.ts                     # NEW: pace constants, checkDelayMs, validReelState (+ test)
│       ├── requests.ts                  # NEW: param builders, checkUploadUrl, readReelStatus, uploadState, publishState (+ test)
│       ├── steps.ts                     # video and reel derivation, afterPublish (+ test)
│       ├── publish.ts                   # publish_video and the five Reel steps (+ test)
│       └── validate.ts                  # Facebook video wording, Page video suggestion (+ test)
└── server/scheduler/
    ├── publishing.ts                    # lease.afterPublish; engine-side fatal → ambiguous; ambiguous credential flagging; recovery re-derive
    ├── record.ts                        # applyStepResult afterPublish input (+ test)
    └── recovery.ts                      # opts.afterPublish (+ test)

tests/
├── helpers/{fake-graph,facebook-publish}.ts                          # headers/bodyBytes; facebookVideoSetup
├── integration/facebook/{page-video,reels,reel-failures,reels-allowance}.test.ts   # NEW
├── integration/scheduler/after-publish.test.ts                       # NEW
└── integration/{compose/post-type-choice,api/post-type,limits/enforcement,docs/limits-inventory,docs/provider-guide,meta/no-secrets}.test.ts   # extended

docs/{limits,adding-a-provider,feature-map,meta-setup,decisions}.md
```

**Structure Decision**: the existing single Next.js app, with code beside its peers.

- **Facebook's behaviour in its own folder.** A new pure `requests.ts` holds the param builders, the address check and the status reader, all tested without a DB.
- **Meta-shared HTTP in `meta/graph.ts`.** `ruploadRequest` sits beside `graphRequest` and reuses `send`.
- **The engine owns G23,** next to the `mayPublish` handling it extends.

## Implementation order (for /speckit-tasks)

1. **Generic G23 (engine).**
   - The `types.ts` members.
   - The `afterPublish` input to `applyStepResult` and the option to `recoverExpiredLease`.
   - In `publishing.ts`: the lease flag, the catch mapping, ambiguous credential flagging, and the recovery re-derive branch.
   - `record.test.ts`, the recovery unit test, and `after-publish.test.ts` with a test provider.
   - `docs/adding-a-provider.md` G23 section, so `provider-guide.test.ts` stays green.
   - Every existing scheduler suite stays green.
2. **Generic summary notes.** The `requirements.ts` fix; `requirements.test.ts` pins Instagram unchanged and covers notes on a non-carousel type.
3. **Facebook capabilities and validation (US4, US5).**
   - The declaration and `creationAllowance`.
   - The `validateFacebook` wording.
   - Unit tests.
   - `docs/limits.md` rows; run `enforcement.test.ts` and `limits-inventory.test.ts`.
   - Compose and API post-type tests for Facebook.
4. **Facebook requests and state.**
   - `requests.ts`, `state.ts`, the `settings.ts` union, `ruploadRequest` and `MetaApp.uploadHost`.
   - The fake-graph `headers`/`bodyBytes`.
   - Unit tests.
5. **Page video (US1).**
   - `steps.ts` `publish_video` and the `publish.ts` branch.
   - Unit tests, `facebookVideoSetup` and `page-video.test.ts`.
   - Confirm the untouched photo suites pass.
6. **Reels (US2, US3).**
   - The `steps.ts` Reel derivation and the five `publish.ts` branches.
   - Unit tests, `reels.test.ts`, `reel-failures.test.ts` and `reels-allowance.test.ts`.
   - The `no-secrets.test.ts` extension.
7. **Docs.**
   - `docs/adding-a-provider.md`: the Facebook worked example, and that it reuses G19–G22.
   - `docs/feature-map.md`: Built, and the unowned items from FR-025.
   - `docs/meta-setup.md`: no new permission, mocks only, the owed live checks.
   - `docs/decisions.md`: implementation outcome.
   - The compose note "no change" (FR-028).
8. **Final pass.** `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build`, once.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Generic engine change G23: `StepInfo.afterPublish` changes how `execute`, `applyStepResult` and stale-lease recovery settle a lease, and `ambiguous` may carry `credentialsInvalid` (constitution V: "no changes to the scheduler" for a provider) | D9, FR-010 and SC-003 require that once `finish_reel` is sent, a target ends failed only when Facebook reports an error. Today the engine fails a non-publishing lease on its own in several cases (F7): missing media, unreadable credentials or settings, 8 exhausted retries, 8 interruptions. The edge cases also require a token rejected after finish to flag the account while the target stays ambiguous, and the engine flags only on `fatal_error` (F8). Facebook is the first provider with a step after its publishing step. | Marking `check_publish` as `mayPublish: true` would make a killed worker settle it ambiguous instead of resuming (US3-8), and would contradict FR-005 ("only finish"). Having the provider return `continue` for everything cannot cover engine-side paths, which never reach the provider. A new lease column needs a migration, for a flag used only in a rare recovery branch, so re-deriving it there is enough. Returning `fatal_error` with `credentialsInvalid` after finish would fail a Reel that may be live. |
