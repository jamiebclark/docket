# Tasks: Requirements up front

**Input**: Design documents in `specs/017-requirements-up-front/` (spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md)

**Prerequisites**: plan.md, spec.md. No schema change, no new dependency, no route (research P15).

**Tests**: Included. The plan and quickstart require them (Vitest, node environment, real Postgres, `renderToStaticMarkup` for UI). No browser, dev server or `curl` is needed or allowed in implement: every check below is a Vitest run, `pnpm lint`, `pnpm typecheck` or `pnpm build`.

**Organization**: By user story. The plan's implementation order puts US3 (values and rules) before US1 and US2, because it changes what the summary and badges show. So US3 is Phase 3, US1 Phase 4, US2 Phase 5, although US1 is the P1 story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: different files, no dependency on an incomplete task
- Read `node_modules/next/dist/docs/01-app/` (server and client components) before editing any page or client component (AGENTS.md). Follow the `docket-ui` skill for UI files.

---

## Phase 1: Setup

- [x] T001 Read `node_modules/next/dist/docs/01-app/` pages on server and client components, and the `docket-ui` skill, so later UI tasks follow current conventions. Nothing is written.
- [X] T002 (baseline green 2026-10-07: 48 files, 666 tests) UNBLOCKED 2026-10-07 (Postgres now available via DATABASE_URL; run it now). Earlier note: no Postgres or DATABASE_URL in this sandbox (vitest global setup throws). Run the baseline `pnpm vitest run src/providers tests/integration/docs/limits-inventory.test.ts tests/integration/limits/enforcement.test.ts` and record that it is green before changes.

---

## Phase 2: Foundational (blocks all stories)

**Purpose**: behaviour-preserving moves the stories build on.

- [X] T003 Create `src/lib/media/types.ts` (client-safe) exporting `UPLOAD_MIME_TYPES = ["image/jpeg","image/png","image/webp"] as const` and `MIME_LABEL` (`JPEG`, `PNG`, `WebP`). Values are unchanged (data-model §8).
- [X] T004 Make `src/server/services/media.ts` re-export `UPLOAD_MIME_TYPES` from `src/lib/media/types.ts`. Make `src/providers/media.ts` and `src/components/media/MediaCard.tsx` use `MIME_LABEL` from the lib instead of their private maps. Make `src/app/p/[projectSlug]/media/UploadDropzone.tsx` and `src/components/media/MediaPicker.tsx` take `accept` from `UPLOAD_MIME_TYPES.join(",")`. Same values (FR-023).
- [X] T005 [P] Add an optional `label?: string` to the `ctx` of `planImage` in `src/providers/media.ts`. It defaults to `` `Image ${ctx.index + 1}` ``, so messages and decisions are unchanged without it (contracts/providers.md). Add a case to `src/providers/media.test.ts` that `label: "This image"` rewords the messages and leaves decisions identical.
- [X] T006 UNBLOCKED 2026-10-07 (Postgres now available via DATABASE_URL; run it now). Earlier note: tests/integration/media needs a Postgres DB (none here); typecheck and unit tests pass. Run `pnpm typecheck && pnpm vitest run src/providers/media.test.ts src/components/media tests/integration/media` and confirm the foundation changed no behaviour.

**Checkpoint**: foundation ready.

---

## Phase 3: User Story 3 — Limits match what the platforms document (Priority: P3, built first)

**Goal**: researched values enforced, caption rules added, docs sourced.

**Independent Test**: `pnpm vitest run tests/integration/docs/limits-inventory.test.ts tests/integration/limits/enforcement.test.ts tests/integration/docs/provider-guide.test.ts tests/integration/instagram/limits.test.ts src/providers`.

### Tests

- [X] T007 [P] [US3] Add unit cases to `src/providers/text.test.ts` for `countHashtags` and `countMentions` per FR-012 and research P4/F12: repeats count; `#` in a URL, lone `#`, `#123` and `C#` count 0; an email `@` counts 0; start of text and after whitespace or punctuation count.
- [X] T008 [P] [US3] Add cases to `src/providers/validation.test.ts`: with `maxHashtags: 30` and `maxMentions: 20`, 31 hashtags gives a `too_many_hashtags` error and 21 mentions a `too_many_mentions` error (field `text`, with `count` and `limit`). Exactly 30 and 20 give neither. Absent caps give neither.
- [X] T009 [P] [US3] In `src/providers/registry.test.ts`, assert every declared `text.maxHashtags` and `text.maxMentions` is an integer ≥ 1.
- [X] T010 [P] [US3] In `tests/integration/instagram/limits.test.ts`, change the Docket publish-limit expectation from 100 to 50 per 86,400 s while the fake `quota_total` stays 100 (quickstart §2).

### Implementation

- [X] T011 [US3] In `src/providers/types.ts`, add optional `maxHashtags?: number` and `maxMentions?: number` to `ProviderCapabilities.text`, with doc comments per contracts/providers.md.
- [X] T012 [US3] In `src/providers/text.ts`, implement pure, total `countHashtags(text)` and `countMentions(text)` per FR-012 and research P4 (make T007 pass).
- [X] T013 [US3] In `src/providers/validation.ts` `validateAgainstCapabilities`, after `text_too_long`, push `too_many_hashtags` / `too_many_mentions` errors with messages "The caption has {count} hashtags; the limit is {limit}." and "The caption has {count} @mentions; the limit is {limit}." (make T008 pass).
- [X] T014 [P] [US3] Edit `src/providers/instagram/capabilities.ts`: `maxHashtags: 30`, `maxMentions: 20`, `minWidth: 320`, publish limit count 50 / 86400 s. Comments cite `docs/research/meta.md` "Limits verification, 2026-10-07". Leave the run-time quota read untouched (FR-013).
- [X] T015 [P] [US3] Edit `src/providers/facebook/capabilities.ts`: `FACEBOOK_MAX_BYTES_PER_FILE = 10_000_000`. Relabel the text-length and photo-count comments "UNVERIFIED (not documented by Meta, checked 2026-10-07)". The formats comment cites the research (D3).
- [X] T016 [US3] In `tests/helpers/limit-rows.ts`, make `coreRows` generate `<key>: hashtags` and `<key>: mentions` rows when the provider declares them, and include both categories in `textRows`.
- [X] T017 [US3] In `tests/integration/docs/limits-inventory.test.ts`, extend `declared()` with `hashtags` and `mentions`, and add an assertion that the only rows whose source contains `UNVERIFIED` are Facebook `text length` and `images`.
- [X] T018 [US3] Update `docs/limits.md` to the rows in contracts/providers.md ("Rows after this entry"): Facebook bytes 10000000, formats, media required / text only, text length and images UNVERIFIED; Instagram text length, hashtags, mentions, min width, max width (drop "scaled outside"), publish limit 50 / 86400 s; X publish limit confirmed. Add `hashtags` and `mentions` to "How to read a row", with counting "per occurrence (FR-012)". Update the audit notes per FR-020 (Facebook bytes and formats; Instagram 50 versus 100 and why 50; 400 containers not modelled; Meta 80001 and 80002 already in the rate-limited set; Bluesky alt text has no documented maximum; Instagram min width now declared).
- [X] T019 [P] [US3] Document `text.maxHashtags` and `text.maxMentions` in `docs/adding-a-provider.md`, so `tests/integration/docs/provider-guide.test.ts` passes (update that test if it lists documented fields).
- [X] T020 [US3] Run `pnpm vitest run src/providers tests/integration/docs tests/integration/limits tests/integration/instagram tests/integration/facebook` and fix any failure. The generated enforcement suite must show `instagram: hashtags`, `instagram: mentions`, `instagram: min width` and `facebook: bytes per file` passing at addToQueue and at publish time.

**Checkpoint**: US3 complete. SC-005 and SC-006 hold.

---

## Phase 4: User Story 1 — See each account's rules before writing (Priority: P1) 🎯 MVP

**Goal**: every selected account shows its requirements summary from the existing check, with no text or media.

**Independent Test**: `pnpm vitest run src/providers/requirements.test.ts tests/integration/compose-check-route.test.ts tests/integration/compose/check.test.ts "src/app/p/[projectSlug]/compose/Composer.test.ts" src/components/compose`.

### Tests

- [X] T021 [P] [US1] Create `src/providers/requirements.test.ts`: for every registered provider, `requirementsOf(caps, { uploadTypes })` equals the capabilities field by field (SC-001) with `null` where nothing is declared (D11). Check the expected table in data-model §3 (Instagram, Facebook, Threads, Bluesky, X). Check that changing a value in a test-double capability changes the summary (FR-003). Check the helpers `aspectLabel` (`4:5`, `1.91:1`, `1:10`, `10:1`) and `bytesLabel` (`8 MB`, `2 MB`). Check that no `video` key exists (FR-005).
- [X] T022 [P] [US1] In `tests/integration/compose-check-route.test.ts`, add: an empty `baseText`, no media and one Instagram target returns `requirements` matching contracts/compose-check.md. A Bluesky target gives 300 graphemes, 4 images, JPEG and PNG, and `aspectRatio` and `maxAltTextLength` both `null`. An unregistered-provider account gives `requirements: null`. For every target, `requirements.text.maxLength === limit` and `requirements.text.countingRule === countingRule`, including over-limit text (FR-004).
- [X] T023 [P] [US1] In `tests/integration/compose/check.test.ts`, add the caption-rule cases: 31 hashtags gives `canSchedule: false`, and 30 hashtags with 20 mentions raises neither issue.
- [X] T024 [P] [US1] Create `src/components/compose/requirements-ui.test.ts` for the pure wording helper: the visible line ("2,200 characters · up to 10 images · JPEG"; "no images" when `maxImages` is 0), the details rows, "No limit checked" and "No limit documented" for `null`, and the "{convertedFrom} uploads are converted to {convertedTo}" sentence.
- [X] T025 [P] [US1] In `src/app/p/[projectSlug]/compose/Composer.test.ts`, add `renderToStaticMarkup` cases: one summary per selected account with every US1 AS1/AS2 field, and no summary while "Checking…" or when `requirements` is `null`. Deselecting removes the summary (AS3), and the counter and issues still render (AS5, FR-007).

### Implementation

- [X] T026 [US1] Create `src/providers/requirements.ts` with the `RequirementsSummary` types and `requirementsOf(caps, { uploadTypes })`, plus `mimeLabel`, `aspectLabel` and `bytesLabel`. It is pure and JSON-safe, imports nothing from `src/server`, and follows data-model §3 (make T021 pass).
- [X] T027 [US1] In `src/server/services/posts/compose.ts`, add `requirements: RequirementsSummary | null` to `TargetCheck`. `checkComposition` fills it with `requirementsOf(caps, { uploadTypes: UPLOAD_MIME_TYPES })` for registered providers, and `null` when `limit` is `null` (make T022 and T023 pass).
- [X] T028 [P] [US1] Create `src/components/compose/requirements-ui.ts`, the pure wording helper per contracts/compose-check.md. No limit, MIME or rule literal (make T024 pass).
- [X] T029 [US1] Create `src/components/compose/RequirementsSummary.tsx`: a visible one-line gist plus a `<details>` titled "What {providerName} accepts" holding a `<dl>`. It starts open only when exactly one account is selected on first render. It renders nothing for a `null` summary. It follows `docket-ui` and has no tooltips.
- [X] T030 [US1] In `src/app/p/[projectSlug]/compose/Composer.tsx`, render `RequirementsSummary` in each preview card below the counter and above the effective text, outside the `aria-live` region. The existing counter, text, images and issues are unchanged (make T025 pass).
- [X] T031 [US1] UNBLOCKED 2026-10-07 (Postgres now available via DATABASE_URL; run it now). Earlier note: tests/integration need Postgres (none here); unit tests (providers, Composer, requirements-ui), typecheck and lint pass. Run the Independent Test command above and `pnpm typecheck`, and fix failures.

**Checkpoint**: US1 works alone (MVP).

---

## Phase 5: User Story 2 — Know whether an image fits each platform (Priority: P2)

**Goal**: per-platform fit badges from the planner's own decision, in the picker and the library.

**Independent Test**: `pnpm vitest run tests/integration/media/fit.test.ts tests/integration/media/library.test.ts src/components/media`.

### Tests

- [x] T032 [P] [US2] Create `tests/integration/media/fit.test.ts`: for every registered provider over the fixed set (1080×1350 JPEG, WebP, 3000×1000 PNG, 200 px-wide JPEG, oversize JPEG, 1:20 aspect, a row without dimensions), `fitOf` state and steps equal the planner's decision (SC-003). Cover US2 AS1–AS4 (Instagram and Facebook fit; WebP converted for Instagram and Facebook and fits X; the 3:1 panorama refused for Instagram; the 200 px image refused for Instagram as `image_too_small`). Cover scoping: `listMedia` with `{ active: true }` gives two platforms per item for Instagram plus Bluesky (AS5), none without active accounts (AS6), one Instagram entry for two Instagram `accountIds` (AS7), and a foreign project's account id is ignored.
- [x] T033 [P] [US2] Create `src/components/media/fit-ui.test.ts` for the wording ("{providerName}: fits", "…: will be converted", "…: will be refused", the note line) and the tone per state.
- [x] T034 [P] [US2] Extend `src/components/media/MediaPicker.test.ts` with markup cases: badges render under each image with the `aria-describedby` link, none when no account is selected, and `accept` is unchanged.

### Implementation

- [x] T035 [US2] In `src/server/services/media-variants.ts`, export `planFor(asset, c, index, platform, label?)` and extract the pure helper that turns a plan into the item to validate. The gate's preview branch uses it (behaviour unchanged).
- [x] T036 [US2] Create `src/server/services/media-fit.ts` with `PlatformFit`, pure `fitOf(asset, provider)` per the data-model §5 table, and `fitPlatforms(scope, fit)` per research P7 (through `ProjectScope` only, with foreign ids ignored). Make T032 pass.
- [x] T037 [US2] In `src/server/services/media.ts`, add the optional zod `fit` input (`{ accountIds: uuid[] ≤ 50 }` or `{ active: true }`) to `listMedia`. Return `platforms` (deduplicated per provider, sorted by name) and `item.fit`. Add `fit?: PlatformFit[]` to `MediaView`. Keep the `media: view` check, and read no storage and decode nothing.
- [x] T038 [US2] In `src/app/p/[projectSlug]/media/actions.ts`, make `listMediaAction` forward `fit?: { accountIds }`.
- [x] T039 [P] [US2] Create `src/components/media/fit-ui.ts` (pure wording) and `src/components/media/FitBadges.tsx`: one `Badge` per entry (success / info / danger), plus a `<ul aria-label="Platform notes">` listing the notes of non-fitting entries. It renders nothing for an empty array and has no tooltip (make T033 pass).
- [x] T040 [US2] In `src/components/media/MediaCard.tsx`, add an optional `fit` prop and render `<FitBadges>` after the existing badges. In `src/app/p/[projectSlug]/media/page.tsx`, call `listMedia(scope, { ...filter, fit: { active: true } })` and pass `fit` down.
- [x] T041 [US2] In `src/components/media/MediaPicker.tsx`, add an `accountIds: string[]` prop. `PickerDialog` passes `fit: { accountIds }` to `listMediaAction` and lists `accountIds` in the effect dependencies. Each grid item renders `FitBadges` under the file name, wired by `aria-describedby`. In `Composer.tsx`, pass `selected` as `accountIds` (make T034 pass).
- [x] T042 [US2] Run the Independent Test command above and `pnpm typecheck`, and fix failures.

**Checkpoint**: US1, US2 and US3 all work.

---

## Phase 6: Polish & Cross-Cutting

- [x] T043 [P] Create `tests/lint/ui-limit-literals.test.ts` (SC-004, research P13): scan the composer, picker and media-library UI files (`Composer.tsx`, `RequirementsSummary.tsx`, `requirements-ui.ts`, `FitBadges.tsx`, `fit-ui.ts`, `MediaPicker.tsx`, `MediaCard.tsx`, the media page and `UploadDropzone.tsx`) and fail on any MIME string, counting-rule name or declared limit (≥ 100) used as a literal. Run it with `tests/lint/import-boundaries.test.ts` and `"src/app/p/[projectSlug]/ui-conventions.test.ts"`.
- [x] T044 [P] Write `## 017` in `docs/decisions.md` recording D1–D11 and the research P5 discrepancy (undecodable or dimensionless images). Add pointers from the 005 R1/R2 entries to the research (FR-022).
- [x] T045 [P] Update `docs/feature-map.md` if it lists the composer, media library or picker screens.
- [x] T046 UNBLOCKED 2026-10-07 (Postgres now available via DATABASE_URL; run it now). Earlier note: no Postgres in this sandbox, so `pnpm test` cannot run its DB-backed suites (lint, typecheck and build pass; DB-free unit and lint tests pass). Final pass, once: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` (FR-025, SC-007). Fix every failure and report any that cannot be fixed. Provider behaviour is "verified with mocks only".

---

## Dependencies & Execution Order

- Phase 1, then Phase 2, then Phase 3 (US3), then Phase 4 (US1), then Phase 5 (US2), then Phase 6.
- US1 depends on US3's capability fields (T011) for its Instagram expectations. US2 depends on US3's `minWidth` (T014) and the foundation `label` (T005). US2 and US1 touch `Composer.tsx` (T030, T041), so run them in that order.
- Within a story: tests, then types, then pure functions, then services, then UI.

### Parallel opportunities

- Phase 3: T007–T010 together; T014, T015 and T019 together.
- Phase 4: T021–T025 together; T028 alongside T026.
- Phase 5: T032–T034 together; T039 alongside T036.
- Phase 6: T043–T045 together.

## Implementation Strategy

- **MVP**: Phases 1–2, the T011 capability fields from US3 (the Instagram numbers shown depend on it), then Phase 4. Stop and validate with the US1 Independent Test.
- **Incremental**: finish US3, then US1, then US2, running each story's Independent Test before moving on.
- **No human-owned tasks**: every check is automated, and nothing needs a browser, device or deployed surface.

## Notes

- No video, upload-transport, new provider or post-type work (FR-023, FR-024).
- Commit by logical group with conventional messages and explicit paths.

---

## Phase 7: Review remediation

- [x] T047 Show the counting rule's name next to its unit in the requirements summary: read it from `requirements.text.countingRule`, never from a literal, so the details read e.g. "2,200 characters (code points)" or "280 characters (x-weighted)", omitting the name only where it equals the unit. Assert it for Instagram, Bluesky, Threads and X in `src/components/compose/requirements-ui.test.ts` and for one account in `src/app/p/[projectSlug]/compose/Composer.test.ts` — review F1 (MAJOR), src/components/compose/requirements-ui.ts:42
- [x] T048 Move the pure `fitOf` cases (the SC-003 matrix and US2 AS1–AS4) out of the DB-backed `tests/integration/media/fit.test.ts` into a DB-free `src/server/services/media-fit.test.ts`, and make the matrix strict for every asset with dimensions: `state` equals `{ original: "fits", derive: "converted", refuse: "refused" }[plan.kind]`, `steps` equals `plan.steps`, and `details` equals the planner's messages, with the dimensionless row as its own explicit expectation. Keep the `listMedia` scoping cases in the integration file. Run the new file — review F2 (MAJOR), tests/integration/media/fit.test.ts:41
