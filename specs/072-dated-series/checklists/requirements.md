# Specification Quality Checklist: Date-pegged series — content that fires on an anniversary, from a spreadsheet

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-14
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
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

## Notes

- **On "no implementation details"**: the *Context and sources* section names existing modules
  (`src/server/services/jobs/sources/csv.ts`, `src/lib/series/cadence.ts`,
  `src/server/db/schema/projects.ts`) and the existing permission statements. That is deliberate and
  required by this project's constitution (principle I, "verified facts over memory" — behaviour on
  `main` must be stated with its source rather than recalled) and by the roadmap entry, which names
  the files to reuse. The requirements, scenarios and success criteria themselves are stated as
  behaviour, not as code: FR-019/FR-020 say "reuse the existing CSV ingestion, extended" and "the jobs
  source's behaviour must remain exactly as it is today" without prescribing how.
- **Leap day and missed window are decided, not deferred**: A24 (29 February fires on 28 February in a
  non-leap year) and A26 (the window closes at the end of the target date's local day; after that the
  occurrence is missed and never fires). Both are recorded as decisions and both have acceptance
  scenarios (US3 #3 and US3 #4/#5) and requirements (FR-031, FR-034, FR-035).
- **Three decisions a reviewer may want to revisit at plan time**, all defaulted here rather than left
  open: the row identity key (A10, date plus the first non-reserved column), the 10-rows-per-date cap
  (A11), and the 30-day/50-per-pass bound on recording missed occurrences (A27). Each is stated with
  its reason, and changing any of them would not alter the feature's shape.
- Validated in one pass; no items failed.
