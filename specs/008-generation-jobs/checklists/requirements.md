# Specification Quality Checklist: Generation jobs, batch mode and item sources

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-04
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

- Validation pass 1 (2026-10-04): every item passes.
- The spec names some mechanisms on purpose:
  - `runTick()`, skip-locked claims with a lease, a database guarantee against double reservation, scoped data-access, `.env.example`, `docs/generator.md` and `docs/decisions.md`.
  - The feature description and the constitution require these (constitution III, IV and the Engineering Constraints).
  - They match how earlier specs (002, 007) were written.
  - No language, library or schema shape is prescribed.
- Planning must resolve one tension, recorded under "Context and sources": the model timeout (default 90 s) against the tick budget (at most 25 s). FR-020 and FR-021 set the required outcome. The mechanism is the planner's choice.
- Planning makes, and logs, the series-onto-jobs decision, under the constraint stated in "Decisions made while specifying".
- Interim limits (500 items, 1 MB / 500-row CSV, 2 items per tick, 3 automatic attempts) are assumptions to log in `docs/decisions.md`. They are not open questions.
