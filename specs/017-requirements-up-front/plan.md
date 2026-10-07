# Implementation Plan: Requirements up front

**Branch**: `017-requirements-up-front` | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/017-requirements-up-front/spec.md`

## Summary

Entry 1 of the video roadmap. It shows each platform's rules before the person writes or attaches anything. It also replaces guessed limits with the values researched on 2026-10-07.

**Requirements summary (US1).**

- A pure `requirementsOf(capabilities, { uploadTypes })` in `src/providers/requirements.ts` turns a provider's declared capabilities into a `RequirementsSummary` with text, image and post parts (D10, research P1). Labels such as `JPEG`, `4:5` and `8 MB` are computed on the server (P2).
- `checkComposition` attaches the summary to every `TargetCheck` as `requirements`. The composer already calls this check as soon as an account is selected, with empty text (research F1), so no new request and no new route are needed (D1).
- A new `RequirementsSummary` component shows a one-line gist and a `<details>` list in each preview card (P9).

**Fit badges (US2).**

- A pure `fitOf(asset, provider)` in `src/server/services/media-fit.ts` reuses the gate's own `planFor` and per-image preview path (P5, P6).
- `listMedia` gains an optional `fit` selection, either the picker's selected account ids or the library's active accounts (P7, P8). It returns one `PlatformFit` per platform per image (D8, D9).
- A new `FitBadges` component renders text badges ("Instagram: will be refused") and the planner's own sentences below them.

**Researched limits (US3).**

- **Instagram.**
  - Declares `maxHashtags` 30 and `maxMentions` 20, new optional `text` capabilities. They are counted per FR-012 (P4) and enforced in the shared `validateAgainstCapabilities` (P3), so the composer, the scheduling gate and the engine's publish-time re-validation all refuse with `too_many_hashtags` / `too_many_mentions`.
  - Declares `minWidth` 320 (D6, P11).
  - Its declared publish limit becomes 50 / 86400 s (D2, P12).
- **Facebook.** Bytes per file becomes 10,000,000 (D4). Text length and photo count are relabelled UNVERIFIED (D5).
- **Docs and tests.** `docs/limits.md`, the inventory test vocabulary (`hashtags`, `mentions`), the generated limit rows and the audit notes follow (P10, P14).
- **No change needed.** Meta codes 80001 and 80002 are already in the rate-limited set (F7). The Instagram run-time quota read stays as it is (F6).

**SC-004.** A literal-scan test (P13) proves that the composer, picker and library UI hold no limit, MIME or counting-rule literal. The existing MIME label map and upload type list move to the client-safe `src/lib/media/types.ts`, with the same values (FR-023).

No video, no upload transport change, no new provider or post type, no migration, no new dependency (FR-023, FR-024, P15).

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS.

**Primary Dependencies**: all are already installed.

- **Next.js 16.3.8.** One server-component page (`media/page.tsx`) changes, and two client components (`Composer`, `MediaPicker`) gain props. There is no new route, server action, config or `proxy.ts` change. Read `node_modules/next/dist/docs/01-app/` (server and client components) before editing (AGENTS.md).
- **React 19.2.8.**
- **zod 4.6.5.** Used for the new optional `fit` input of `listMedia`.
- **sharp** is not touched: badges read stored dimensions and never decode.

**Storage**: PostgreSQL. No schema change. It reads the existing `media_assets` (`mime_type`, `width`, `height`, `byte_size`) and `social_accounts` (`provider_key`, `status`) through the scoped DAL. See [data-model.md](./data-model.md).

**Testing**: Vitest in the `node` environment against real Postgres, using run-scoped databases.

- **Unit:** `text`, `validation`, `requirements`, `media` and `registry` under `src/providers/`, plus the UI wording helpers.
- **Integration:** compose check, generated limit enforcement, limits inventory, provider guide, Instagram limits, a new `tests/integration/media/fit.test.ts`, and library.
- **Lint:** a new `tests/lint/ui-limit-literals.test.ts`.
- **Markup:** UI is checked with `renderToStaticMarkup`.
- **No live calls.** See [quickstart.md](./quickstart.md).

**Target Platform**: self-hosted Linux containers (web and worker), plus Neon. Unchanged.

**Project Type**: web application (Next.js App Router monolith with a worker).

**Performance Goals**:

- **Summary (SC-002).** It is built in microseconds from in-memory capabilities, so the check's response time is unchanged.
- **Badges.** One library page is at most 24 images × 6 providers = 144 pure `planImage` and `validate` calls, with no DB or storage I/O beyond the existing list query and one `accounts.list`/`get`.

**Constraints**:

- Every value is derived from capabilities (FR-003), and there are no literals in UI code (SC-004).
- The badge must equal the planner's decision (FR-010).
- The import boundary holds: `src/providers` imports nothing from `src/server`.
- Clients cannot import server modules at run time.

**Scale/Scope**: 6 providers (5 platforms plus mock).

- **New source files:** `providers/requirements.ts`, `services/media-fit.ts`, `lib/media/types.ts`, and 4 UI files (two components and two wording helpers).
- **Edited source files:** about 15 (types, text, validation, media, two capability files, media-variants, media service, compose service, media actions, media page, MediaCard, MediaPicker, UploadDropzone, Composer).
- **Docs:** 4 files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How this plan meets it |
|---|---|---|
| I. Verified facts over memory | PASS | Every changed value cites `docs/research/meta.md` "Limits verification, 2026-10-07" or the 2026-10-07 re-check in `docs/research/x.md`. The two values Meta does not document stay, labelled UNVERIFIED (D5). The Instagram 50-vs-100 contradiction is recorded and the safe side is chosen (D2). One spec-versus-code discrepancy (undecodable or dimensionless images, research P5) is recorded in research.md and in decisions.md. Library facts come from the installed versions, and the FR-012 regexes were probed in this phase (F12). |
| II. Nothing is "working" unless it ran | PASS | Every behaviour has an automated test (quickstart §1–§5). Provider behaviour is covered by mocked tests only and is reported as "verified with mocks only". |
| III. Project isolation in one place | PASS | Fits read accounts and media only through `ProjectScope` (`scope.accounts.get/list`, `scope.media.list`). Foreign account ids are ignored (P7). No raw DB import. `listMedia` keeps its `media: view` check. |
| IV. One service layer | PASS | The caption rule lives once in `validateAgainstCapabilities`, which serves composer, gate and engine (F2). The badge reuses the gate's `planFor` and preview helper rather than a copy (P5). The summary is one pure function. |
| V. Providers are plug-ins | PASS | The new capability fields are optional. A provider gets a summary and badges with no change outside its folder, and the scheduler and schema are untouched. `docs/adding-a-provider.md` documents the fields. |
| VI. Boring, few dependencies | PASS | No new dependency or infrastructure (P15). |
| VII. Secrets never leak | PASS | The summary and fits carry only capability values and provider names, never credentials or storage keys. |
| Engineering constraints | PASS | No `runTick` change apart from a constant read by the existing deferral. No time-zone logic. The UI follows `docket-ui`: text plus colour badges, `<details>` and `<dl>` with no tooltips, labelled lists, server-computed data. Video stays out of scope (constitution "Out of scope"; FR-023). |
| Workflow | PASS | Conventional commits, explicit paths. `docs/decisions.md` `## 017` is written in this phase. Checks run in proportion: a full pass once at the end of implement, plus `pnpm build` because a page and client props change. |

No violations, so Complexity Tracking stays empty.

**Post-design re-check (after Phase 1)**: PASS. The design adds two pure modules and one service module. It changes no table, adds no route and leaves the boundary rules intact. The one non-obvious coupling, `fitOf` importing the gate's planning helper, is the point of constitution IV rather than a breach of it.

## Project Structure

### Documentation (this feature)

```text
specs/017-requirements-up-front/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0: facts F1–F12, decisions P1–P15
├── data-model.md        # Phase 1: shapes (no schema change)
├── quickstart.md        # Phase 1: validation runs
├── contracts/
│   ├── compose-check.md # check response `requirements`, new issue codes, composer UI
│   ├── media-fit.md     # listMedia `fit`, PlatformFit, FitBadges, picker and library UI
│   └── providers.md     # capability fields, counting, validation, limits.md rows
├── checklists/
└── tasks.md             # Phase 2 (/speckit-tasks), not created here
```

### Source Code (repository root)

```text
src/
├── lib/media/types.ts                    # NEW: UPLOAD_MIME_TYPES, MIME_LABEL (client-safe)
├── providers/
│   ├── types.ts                          # text.maxHashtags?, text.maxMentions?
│   ├── text.ts                           # countHashtags, countMentions (+ text.test.ts)
│   ├── validation.ts                     # too_many_hashtags / too_many_mentions (+ test)
│   ├── requirements.ts                   # NEW: requirementsOf, aspectLabel, bytesLabel (+ requirements.test.ts)
│   ├── media.ts                          # ctx.label?; MIME_LABEL from lib (+ test)
│   ├── registry.test.ts                  # caption caps are integers ≥ 1
│   ├── instagram/capabilities.ts         # 30 / 20 / minWidth 320 / publish 50; comments
│   └── facebook/capabilities.ts          # 10_000_000; UNVERIFIED comments
├── server/services/
│   ├── media-variants.ts                 # export planFor (+label); extract the preview-item helper
│   ├── media-fit.ts                      # NEW: fitOf, fitPlatforms, PlatformFit
│   ├── media.ts                          # listMedia `fit` → platforms + item.fit; re-export UPLOAD_MIME_TYPES
│   └── posts/compose.ts                  # TargetCheck.requirements
├── components/
│   ├── compose/RequirementsSummary.tsx   # NEW
│   ├── compose/requirements-ui.ts        # NEW: pure wording (+ test)
│   └── media/
│       ├── FitBadges.tsx                 # NEW
│       ├── fit-ui.ts                     # NEW: pure wording (+ test)
│       ├── MediaCard.tsx                 # fit prop; MIME_LABEL from lib
│       └── MediaPicker.tsx               # accountIds prop; badges in grid; accept from lib
└── app/p/[projectSlug]/
    ├── compose/Composer.tsx              # render summary; pass selected to MediaPicker (+ Composer.test.ts)
    └── media/
        ├── page.tsx                      # listMedia(..., fit: { active: true })
        ├── actions.ts                    # listMediaAction forwards fit
        └── UploadDropzone.tsx            # accept from lib (same value)

tests/
├── helpers/limit-rows.ts                 # hashtags / mentions rows in coreRows and textRows
├── integration/
│   ├── docs/limits-inventory.test.ts     # declared(): hashtags, mentions; UNVERIFIED allow-list
│   ├── limits/enforcement.test.ts        # unchanged code; new rows are generated
│   ├── instagram/limits.test.ts          # 100 → 50
│   ├── compose-check-route.test.ts       # requirements on empty composer; FR-004 equality
│   ├── compose/check.test.ts             # caption rules at check; 30/20 boundary
│   └── media/fit.test.ts                 # NEW: SC-003 matrix, US2 AS1–AS7, scoping
└── lint/ui-limit-literals.test.ts        # NEW: SC-004

docs/limits.md, docs/adding-a-provider.md, docs/decisions.md (## 017 + 005 R1/R2 pointer), docs/feature-map.md (if it lists these screens)
```

**Structure Decision**: the existing single Next.js app with `src/providers` (pure, plug-in), `src/server/services` (one service layer), `src/components` and `src/app`. New code goes where its peers already are. The summary is pure and per provider, so it sits in `src/providers/`. The fit needs the project scope and the gate's planning helper, so it sits in `src/server/services/`. Both new components sit under `src/components/`, and the wording helpers are pure, following the `retry-ui.ts` pattern.

## Implementation order (for /speckit-tasks)

1. **Foundation.** `src/lib/media/types.ts` (move constants, re-export) and `planImage` `ctx.label`. Behaviour is unchanged, which the existing tests prove.
2. **US3 values and rules** (they change what the summary and badges show, so they come first):
   - capability fields and the counting functions;
   - the validator issues;
   - Instagram and Facebook constants;
   - `limit-rows.ts`, the inventory test, `docs/limits.md`;
   - the Instagram limits test;
   - `docs/adding-a-provider.md`.
3. **US1 summary.**
   - `requirementsOf` with its tests, then `TargetCheck.requirements` with the route and check tests;
   - the wording helper, `RequirementsSummary` and the composer wiring.
4. **US2 badges.**
   - export `planFor` and extract the preview helper, then `fitOf` and `fitPlatforms` with `fit.test.ts`;
   - `listMedia`/`listMediaAction`, then `FitBadges` with its wording helper;
   - `MediaCard`, the library page, `MediaPicker` and the composer prop.
5. **SC-004 scan, docs, final pass.** The literal-scan test; the `docs/decisions.md` 005 R1/R2 pointers and audit notes; `docs/feature-map.md`; then `pnpm lint && pnpm typecheck && pnpm test && pnpm build` once.

## Complexity Tracking

No constitution violations to justify.
