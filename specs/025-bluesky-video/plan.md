# Implementation Plan: Bluesky video

**Branch**: `025-bluesky-video` | **Date**: 2026-10-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/025-bluesky-video/spec.md`

## Summary

Entry 7 of the video roadmap. Bluesky gains one-video posts (`app.bsky.embed.video`) uploaded through Bluesky's video service in parts, one part per step, then polled until processed, on the existing resumable step machine. Bluesky's video limits are declared in capabilities, so entry 6's formatter trims and encodes for it with no Bluesky formatter code. One small generic hook is added (G24: a `continue` may carry a wait message); no schema, migration, composer or engine change otherwise. Code facts F1–F18 and decisions P1–P22 are in [research.md](./research.md).

**Capabilities and validation (US3; FR-001–FR-005, FR-017–FR-019).**

- **Declaration** (`capabilities.ts`, new; P1): one video, no images with it, MP4, H.264, AAC or silent, 300,000,000 bytes, 180 s. Post types gain `video`; no choice. The provider declares `creationAllowance` 25 / 86,400 s, "Bluesky's daily video upload allowance".
- **Formatter** through those limits only: MOV rewrapped, other codecs re-encoded, cut to 3:00, oversize fitted by bitrate; two videos or a video with images refused.
- **`validateBluesky`** rewords the two refused mixes in Bluesky's words (P19); everything else is unchanged.
- **Summary and badges** follow the declaration: the video row plus two notes (about 25 a day; verified email), no "Post as".

**Publishing (US1, US2, US4; FR-006–FR-016).**

- **Steps** (P8): `resolve_mentions` (if any) → `check_upload_limits` → `start_upload` → `upload_part_1` … `upload_part_N` → `finish_upload` → `check_job`* → `create_post`. Only `create_post` may publish; text and image posts keep their steps byte for byte.
- **Tokens** (P3): every video-service step mints a method-scoped service token from the PDS (`exp` +300 s) and sends it only to `https://video.bsky.app`. Upload calls use `did:web:<PDS host>` / `com.atproto.repo.uploadBlob`. The limits and status calls use `did:web:video.bsky.app` with their own method (UNVERIFIED; both have fallbacks, P10, P13).
- **PDS host** (P4): read once per upload from `getSession`'s DID document (`#atproto_pds`), falling back to the configured server's host.
- **Video service client** (P5): a small `fetch` client whose errors subclass `XRPCError` and keep the body, so the existing classification applies and an "already processed" blob can be read (P15).
- **Parts** (P6, P7): each part is read with an HTTP `Range` request on the media's public URL; the whole file is never in memory. Sizes are checked against what was declared.
- **Limits** (P2, P9, P10, P11):
  - the allowance is reserved where an upload begins;
  - `canUpload: false` or `DailyLimitExceeded` waits an hour, showing Bluesky's message through G24, and fails 23 hours after the first refusal so Bluesky's message wins over the engine's 24-hour ceiling;
  - a refused check is skipped.
- **Polling** (P12, P16): first read at 30 s, then every minute until 10 minutes, then every 5 minutes. Fails at 30 minutes or 16 reads. A failed state wins over a blob; unknown states keep polling.
- **Errors, restarts and changes** (P14, P17, P18): every D8 code gets a plain explanation. Expiry or a lost upload restarts from the limits check at most twice. A changed post starts again. No token is ever stored.

**Not built here** (FR-028–FR-030): TikTok (entry 8). No change to the formatter (entry 6), Instagram, Facebook, Threads or X. Unowned, recorded in `docs/feature-map.md`: WebVTT captions, the GIF hint, the gallery embed, quote posts with video, a configurable video service, API video upload and generator video.

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS.

**Primary Dependencies**: all already installed; no new runtime dependency.

- **`@atproto/api` 0.22.0.** `Agent` for the PDS calls (`getSession`, `getServiceAuth`, `createRecord`, as today through `agentFor`). Its generated types are the source for the video lexicon shapes. Its `XRPCError` is the base of `VideoServiceError`.
- **zod 4.6.5.** The extended `blueskyStateSchema` and the parsing of every video-service reply.
- **Next.js 16.3.8 / React 19.2.8.** No route, component or server action changes. The summary changes only through the shared `requirementsOf`, rendered by the existing `RequirementsSummary`. Nothing in `node_modules/next/dist/docs/` needs reading, because no Next.js API is touched.
- **Vitest 5.** The fake PDS (`tests/helpers/fake-pds.ts`) also serves the video service's distinct paths. A new byte-range media stub stands in for the bucket. The clock is pinned with `atTime`.

**Storage**: PostgreSQL, unchanged; no migration.

- Upload progress is JSON in the existing `post_targets.step_state`; the new member is optional (data-model §2).
- Reservations use the existing `allowance_uses` ledger.
- Video bytes are read from the existing public bucket by HTTP range (P6); there is no `Storage` interface change.

**Testing**: Vitest against real Postgres with run-scoped databases.

- Unit tests for the pure state, step, host, client, error and handler functions.
- Integration tests through `runTick` with a fake PDS, a fake video service and a byte-range media server.
- Video rows come from `createVideoAsset` facts, so no ffmpeg is needed.
- New test files, plus two edited ones: `requirements.test.ts` (P20) and `record.test.ts` (G24). No file under `src/providers/bluesky/*.test.ts` or `tests/integration/bluesky/` that exists today changes. See [quickstart.md](./quickstart.md).

**Target Platform**: self-hosted Linux containers (`web` and `worker` from one image) on Docker Compose, Unraid or Neon. Publishing runs in `runTick`.

**Project Type**: web application (Next.js App Router monolith with a worker process).

**Performance Goals**:

- **Fast publish (SC-004).** A video processed within 5 minutes posts within one or two ticks of the read that carries its blob.
- **Slow processing (SC-005).** At most 16 reads; failure by about 31 minutes plus tick lag, inside 35 minutes.
- **Bounded steps (SC-006).** Every step makes at most four short calls (session or storage probe, token, one video call, or one part) inside `SCHEDULER_PROVIDER_TIMEOUT_SECONDS`. No step sends more than one part.

**Constraints**:

- No sleeping in a tick; every wait is `notBefore` (FR-012).
- No provider call inside a held transaction (unchanged engine).
- DB clock everywhere.
- Text and image requests, outcomes and messages unchanged (US1 #9).
- No limit literals in UI code (FR-018).
- Session tokens and service tokens never reach state, `lastError`, attempts, summaries, activity, logs or snapshots (VII, FR-007).
- Summary keys avoid the words the engine's redactor drops (F6).

**Scale/Scope**: 1 provider changed (Bluesky), plus one generic hook (G24).

- **New source files (7)** under `src/providers/bluesky/`: `capabilities.ts`, `video-state.ts`, `pds-host.ts`, `video-service.ts`, `media-range.ts`, `video-errors.ts`, `video-publish.ts`.
- **Edited source files (7):**
  - Bluesky `index.ts`, `settings.ts`, `steps.ts`, `publish.ts` and `validate.ts`;
  - `src/providers/types.ts` and `src/server/scheduler/record.ts` (G24).
- **Tests:**
  - 14 new files: 8 unit, 5 integration, 1 compose;
  - one new helper, `tests/helpers/bluesky-video.ts`;
  - 2 edited: `requirements.test.ts` and `record.test.ts`.
- **Docs:** 5 files (`limits`, `adding-a-provider`, `feature-map`, `accounts`, `decisions`).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How this plan meets it |
|---|---|---|
| I. Verified facts over memory | PASS | Every Bluesky fact comes from `docs/research/bluesky-video.md` and `bluesky.md`. Every library shape (lexicon inputs, outputs and error names, `didDoc`, `getPdsEndpoint`, `XRPCError`) was read from the installed packages in this phase (research "Research check"). The `uploadPart` and `finishUpload` error names are in the installed types but not in the research; they are used as named there. UNVERIFIED facts (parts host and auth, limits and status token audience, `getSession` for an app password, the already-processed shape, pace, duration, codecs) are each decided conservatively with a fallback (P4, P10, P13, P15). Each lives in one named constant or function, is covered by mocked tests only, and is listed as an owed live check. Nothing is marked NEEDS RESEARCH. |
| II. Nothing is "working" unless it ran | PASS | Every behaviour has an automated test with mocked HTTP (quickstart §1–§6). Real Bluesky video publishing is reported as "verified with mocks only", with live checks owed (quickstart §7, `docs/accounts.md`). |
| III. Project isolation | PASS | No new table, query or DAL code. The state lives on the project-owned `post_targets` row behind the existing scheduler repo; reservations go through the existing scoped allowance ledger. |
| IV. One service layer | PASS | One validator (`validateResolvedContent` → `validateBluesky`) serves the composer, the gate, the engine's re-check and the badges. One `requirementsOf` serves the summary. One planner and one `resolvePublishMedia` decide the file. Publishing has one implementation (`advance`). |
| V. Providers are plug-ins | PASS | Bluesky's behaviour lives in `src/providers/bluesky/`. G24 is a generic, optional member of `StepResult`'s `continue`. It follows G19–G23: inert for every existing provider (a test pins it), documented in the generic hooks index and recorded in `docs/decisions.md`. `advance` keeps the five result kinds, `create_post` stays the only step that may publish, and an unknown create outcome stays ambiguous. |
| VI. Boring, few dependencies | PASS | No new package and no infrastructure. `@atproto/common-web` is not imported (not a direct dependency); the ten-line DID document read in `pds-host.ts` reads data and replaces no package API (P4). |
| VII. Secrets never leak | PASS | The service token is one local per step, sent only in the `Authorization` header to the video service, and scrubbed from every message built from a reply (P17). It is never stored or logged. A new no-secrets suite drives every step with a fake service that echoes the token. Summary keys are chosen so the redactor keeps them (F6). There is no new env var. |
| Engineering constraints | PASS | `runTick` stays bounded: one part and a few short calls per step, waits as `nextAttemptAt`, never sleeping. Times are UTC on the DB clock. There is no UI component change, so `docket-ui` rules are untouched. Video: "out of scope until a spec says otherwise"; this spec says otherwise for Bluesky video posts. |
| Workflow | PASS | Conventional commits with explicit paths. `docs/decisions.md` `## 025` is written in this phase (spec D1–D13, plan P1–P22). Checks run in proportion: targeted tests per task, then one final pass (`lint`, `typecheck`, `test`, `build`; no `db:check`, because there is no schema change). |

**Post-design re-check (after Phase 1)**: PASS.

- **Old state still parses.** `video` is an optional member and `v` stays `1`, so every Bluesky state saved before this entry parses and drives the same steps (data-model §2). `fitState` only replaces a state whose media no longer match.
- **G24 is inert.** No existing provider sets `wait`, and `applyStepResult` still writes `lastError: null` for a `continue` without one (test pinned).
- **Three judgement calls against the letter of the spec**, each recorded in decisions:
  - *P2:* FR-005 says the start step reserves the allowance. It is reserved at the limits check, the first step of an upload, with one more unit on a retried start. Only this satisfies US4 #6's "no Bluesky call" and keeps D6's count.
  - *P9:* D5's 24-hour wait ends at the refusal 23 hours after the first, because the engine's default 24-hour ceiling from the first step would otherwise always fire first with a generic message.
  - *P20:* one generic assertion in `requirements.test.ts` that pins Bluesky's empty video notes drops Bluesky, because FR-018 requires the notes. No Bluesky test file changes.

## Project Structure

### Documentation (this feature)

```text
specs/025-bluesky-video/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0: research check, code facts F1–F18, decisions P1–P22
├── data-model.md        # Phase 1: capabilities, state and phases, step derivation, pace, summaries, limits rows
├── quickstart.md        # Phase 1: validation runs and owed live checks
├── contracts/
│   ├── bluesky-video-capabilities.md   # declaration, validateBluesky, formatter fit, summary, badges, tests
│   └── bluesky-video-publishing.md     # tokens, PDS host, steps, exact requests, outcomes, pace, restarts, messages, G24, secrets, tests
├── checklists/
└── tasks.md             # Phase 2 (/speckit-tasks), not created here
```

### Source Code (repository root)

```text
src/
├── providers/
│   ├── types.ts                             # G24: continue.wait?
│   └── bluesky/
│       ├── capabilities.ts                  # NEW: BLUESKY_VIDEO, notes, allowance, blueskyCapabilities (+ capabilities.test.ts)
│       ├── index.ts                         # uses capabilities.ts; creationAllowance
│       ├── settings.ts                      # blueskyStateSchema gains video?
│       ├── video-state.ts                   # NEW: videoUploadSchema, constants, fitState, partRange, nextReadAt (+ test)
│       ├── steps.ts                         # stepForContent: kinds, phases, allowance (+ new video-steps.test.ts)
│       ├── pds-host.ts                      # NEW: pdsHostOf(didDoc) (+ test)
│       ├── video-service.ts                 # NEW: serviceToken, video service calls, VideoServiceError (+ test)
│       ├── media-range.ts                   # NEW: readRange, storedSize (+ covered by video-publish.test.ts)
│       ├── video-errors.ts                  # NEW: explanations, sanitiseMessage (+ test)
│       ├── video-publish.ts                 # NEW: the five video step handlers (+ video-publish.test.ts)
│       ├── publish.ts                       # dispatch video steps; video embed in createPost
│       └── validate.ts                      # Bluesky wording for too_many_videos, video_with_images (+ new video-validate.test.ts)
└── server/scheduler/record.ts               # G24: lastError from continue.wait (+ record.test.ts cases)

tests/
├── helpers/bluesky-video.ts                 # NEW: blueskyVideoSetup, routeVideoService, rangeFetch
└── integration/
    ├── bluesky/{video,video-failures,video-limits,video-fit,video-no-secrets}.test.ts   # NEW
    └── compose/bluesky-video-summary.test.ts                                            # NEW

src/providers/requirements.test.ts           # P20: "unchanged" loop without bluesky; Bluesky video summary case
docs/{limits,adding-a-provider,feature-map,accounts,decisions}.md
```

**Structure Decision**: the existing single Next.js app, with code beside its peers.

- **Pure logic in `src/providers/bluesky/`**, split like Threads' `requests.ts` / `state.ts` / `steps.ts`, so every step and request is unit-tested without a DB.
- **The only generic edit is G24** (`types.ts`, `record.ts`).
- **Engine, schema, services, API and UI components are untouched.**

## Implementation order (for /speckit-tasks)

1. **G24 first, with its tests.** `continue.wait` in `types.ts` and `record.ts`, plus the two `record.test.ts` cases. Every existing test stays green, since no provider sets it yet.
2. **Capabilities and validation (US3).**
   - `capabilities.ts`, `index.ts`, `validate.ts` (P19).
   - `capabilities.test.ts`, `video-validate.test.ts`, and `requirements.test.ts` (P20).
   - `docs/limits.md` rows, then the generated enforcement and inventory tests.
   - The compose summary test and `video-fit.test.ts`. The formatter path needs no code, only proof.
3. **State and steps.** `video-state.ts`; `settings.ts` (`video?`); `steps.ts`. Then `video-state.test.ts` and `video-steps.test.ts`. Confirm that `steps.test.ts` passes untouched.
4. **Clients.** `pds-host.ts`, `video-service.ts`, `media-range.ts` and `video-errors.ts`, each with its unit test. Add `tests/helpers/bluesky-video.ts`.
5. **One video end to end (US1).** `video-publish.ts` (limits, start, parts, finish, job) and `publish.ts` (dispatch, embed); `video-publish.test.ts`; `tests/integration/bluesky/video.test.ts`. Confirm that the existing Bluesky suites pass untouched.
6. **Failures (US2).** Restarts, early blob, failed-state precedence, status-auth fallback, part timeouts; `video-failures.test.ts`.
7. **Daily limits (US4).** The limit wait with G24, the 23-hour rule, skip, and allowance reservations; `video-limits.test.ts`.
8. **Secrets.** `video-no-secrets.test.ts`.
9. **Docs.**
   - `docs/adding-a-provider.md`:
     - §13 video steps: per-step service tokens for a second host, the upload in parts as the pattern for large files within bounded steps, the limits check and its fallback, job polling and the error explanations;
     - G24 in the hooks index and §7.
   - `docs/feature-map.md`: Bluesky video built. Unowned: WebVTT captions, the GIF hint, the gallery embed, quote posts with video, more than one video or video with images (Bluesky does not allow them), and another video service.
   - `docs/accounts.md` (Bluesky): no new connection step, verified email, about 25 a day, and the owed live checks of quickstart §7.
   - `docs/decisions.md`: the implementation outcome.
   - FR-025: no `docker-compose.yml` or `.env.example` change.
10. **Final pass.** `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, once.

## Complexity Tracking

No constitution violation needs justifying. G24 is a new optional generic member, like G19–G23, not a Bluesky-specific engine path. Without it a provider wait cannot show its reason without spending an attempt per check (F7, P11). It is inert for every existing provider and recorded in `docs/decisions.md`.
