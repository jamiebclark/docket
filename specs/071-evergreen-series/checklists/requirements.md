# Specification Quality Checklist: Standing content series that keep producing posts on a cadence

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-13
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

Validated in one pass; no spec revisions were needed.

Two items deserve a word, both resolved rather than waived:

- **"No implementation details."** The spec names artefacts the project's constitution governs — a committed SQL migration and `pnpm db:check`, the worker tick's sections, `docs/generator.md`, `docs/decisions.md`, `.env.example` — and describes claiming as skip-locked with a lease, because the constitution mandates those mechanisms by name and forbids alternatives (no advisory locks, no queue or broker, no second process). These are constraints on the outcome, not a chosen design, and the same convention is used by every prior spec in `specs/`. No language, framework, library, table name, column name, file path or function name is prescribed anywhere in the requirements.
- **"Technology-agnostic success criteria."** SC-001 to SC-012 are stated as user-observable outcomes (posts appear, nothing duplicates, nothing invalid is queued, no slot is shared, no human intervention needed after a billing hold). SC-011 and SC-012 are regression and extensibility outcomes, phrased as "existing behaviour unchanged" and "a second occurrence rule needs no change here", which are verifiable without knowing the implementation.

All 34 decisions recorded in the spec (W1–W34) were made here rather than deferred, so no clarification round is needed. The three judgement calls most worth a second look during planning are flagged deliberately rather than hidden:

- **W28, the media-required skip skips the whole post**, not just the target that requires media. This follows the brief literally and keeps "never emit something that cannot publish" in one place, at the cost of a mixed-target series stopping entirely when its pool runs dry. FR-038 and SC-006 make the behaviour explicit and the interface must surface it.
- **W16/FR-018 adds prior-run angle titles to the planning prompt.** This is the one prompt change in the entry and it touches the golden prompt tests. It is included because a standing series that repeats itself weekly is not worth running, and this is the smallest change that prevents it.
- **W31/FR-045 gives the new worker section its own per-tick budget** rather than sharing the batch budget, which raises an install's total concurrent model calls. The requirement pairs it with a documentation obligation so operators are not surprised.
