# Specification Quality Checklist: the comparisons only Docket can make

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-18
**Feature**: [spec.md](../spec.md)

## Content Quality

- [~] No implementation details (languages, frameworks, APIs) — **deliberate deviation**, see Notes
- [x] Focused on user value and business needs
- [~] Written for non-technical stakeholders — user-facing behaviour is in plain language; the cited
      code paths are for the plan phase, see Notes
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Roadmap rules for every entry (`.specify/roadmaps/social-insights.md`)

- [x] Says what it does **not** do, and that no later entry owns the deferrals (this is section 4, the last)
- [x] Never sums or averages a metric across platforms; one series per platform with that platform's own word (FR-011, FR-012, FR-034, SC-001)
- [x] A metric the platform does not provide is absent, never zero (FR-015, FR-023, FR-004, SC-007)
- [x] Snapshots are immutable and every figure states its "as of" (FR-016, FR-022, FR-043, SC-007)
- [x] Tasks needing a live consent screen, real account or browser are required to land last (FR-085)
- [x] No secret, token or credential in a row, log line or response; secret scan extended not exempted (FR-064, FR-084)
- [x] Schema changes ship as a committed migration with `pnpm db:check` green (FR-083)
- [x] Tick-section rule addressed: the fold joins housekeeping, and if it cannot, it needs its own `SectionResult`, `Promise.all` entry and heartbeat (FR-055, "What this entry does not do")
- [x] Repo left working (FR-086, SC-010)
- [x] Generic provider change recorded in the hooks index and `docs/decisions.md` (FR-003, G38)
- [x] No provider reader, no new scope, no new platform (FR-005, SC-011, "What this entry does not do")

## Notes

**On the two `[~]` items.** This spec names tables, columns, provider declarations, config knobs,
scripts and line numbers. By the letter of the generic checklist that is an implementation detail; in
this repo it is the house style, matching 080, 081 and 082, and the feature description for this entry
names those paths itself and requires them honoured. Every user-visible behaviour, every acceptance
scenario and every success criterion is stated in plain language and is verifiable without reading the
code; the citations sit beside them so the plan phase does not have to re-derive facts that were
checked here. Stripping them would make the spec less accurate and inconsistent with the rest of the
roadmap, so they stay and the deviation is recorded rather than hidden.

Validated 2026-10-18. Three decisions were resolved in-spec rather than left as markers (see
**Clarifications**): the sample-size floor (8 / 4-7 / below 4), the home for the new screens (a new
project Insights page), and the treatment of a metric whose window cannot be confirmed (classified
`unknown`, absent from trends).

Two facts worth the plan phase's attention, both verified against the code and research during
specification:

1. `MetricKeyDeclaration` (`src/providers/types.ts:623`) carries only `key` and `label`. Nothing
   distinguishes Bluesky's cumulative `followersCount` from Instagram's one-day-window
   `follower_count` (`period=day`, `docs/research/meta.md:467`), which is read four times a day
   (`accountPollIntervalMs` 6 h, `src/server/scheduler/config.ts:185`). A trend cannot be drawn
   honestly without closing that gap, which is why FR-001 to FR-005 exist and why this entry carries
   one generic change (G38).
2. Retention already prunes. `INSIGHTS_RETENTION_DAYS` and both prune passes shipped in 080
   (`src/server/scheduler/housekeeping.ts:166-167`); what does not exist is anything that survives
   them. FR-050 to FR-057 are the fold-before-prune work the roadmap asks for.

The project has no chart primitive, no chart library and no chart conventions in
`docs/design-system.md` today. FR-070 to FR-073 establish them; the constitution's "Boring, few
dependencies" and the design system's "no UI framework, no icon package" make server-rendered inline
SVG the only admissible answer, and FR-073 requires writing the conventions down.

The constitution's out-of-scope line still says charts, trends and comparisons are out of scope
(`.specify/memory/constitution.md`). FR-081 requires amending it in this entry.
