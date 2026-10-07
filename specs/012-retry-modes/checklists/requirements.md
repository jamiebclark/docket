# Specification Quality Checklist: Retry a failed target now, into the next free slot, or at a picked time

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-06
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

- Validation pass 1: all items pass.
- The `Input` line quotes the roadmap entry verbatim, so it names code symbols. "Context and sources" also names existing behaviour, which other Docket specs do too (see `specs/011-*`). The user stories, success criteria and most requirements stay behavioural. A few domain terms are kept on purpose because the later roadmap entries depend on them: the mode names (`now` / `requeue` / `at`), the attempt outcomes (`retry_requested`, `requeued`), "same transaction" in FR-006 (atomicity as a guarantee) and ISO-8601 instants. These describe contract behaviour, not frameworks or code layout.
- No clarifications were needed. The open judgement calls are D1–D6 in the spec, and planning logs each one in `docs/decisions.md`.
- Found in the code while specifying: today every held occurrence counts as taken, including the failed target's own. FR-007 and D2 change that for the target itself, in both the preview and the allocation.
