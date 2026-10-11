# Specification Quality Checklist: Per-kind and per-platform notification preferences

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-11
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

- Iteration 1 found three issues, all fixed in the spec before this checklist was marked complete:
  1. **FR-025 named a decision that this entry does not touch.** It listed N9 (the "99+" cap) among the
     decisions the new ones sit next to; the cap is unchanged, so N9 was removed from that list and left
     where it is stated as standing (Context, FR-010).
  2. **US5 scenario 2 was not testable as written** ("the caller's own are unchanged or the request is
     refused — never the other way round" described two outcomes without saying which). It now asserts the
     one invariant a test can check: the other person's preferences are unchanged and only the caller's own
     state can ever be what changed.
  3. **The Independent Test for US2 asserted a reversal it did not describe.** It ended with "turn it back
     on and check the switch disappears from nothing and the preference is gone", which is ambiguous about
     what is observed; the sentence was dropped, since US3 covers turning a platform back on and its
     fresh-start consequence precisely.
- Naming conventions carried deliberately from the house style of `specs/022-problem-notifications/` and
  `specs/042-per-event-read-snooze/`: file paths and identifiers appear in the "Context and sources" and
  "Decisions made while specifying" sections, which exist so planning knows exactly which shipped
  behaviour and which prior decision each requirement sits against. They are sources and reversals, not
  implementation choices; every FR and SC is stated in behaviour the roadmap's own terms.
- The entry deliberately records a decision the roadmap demanded of the spec phase rather than the plan
  phase: the fate of `muted` (N26 — dropped, with every `muted = true` row migrated to all-kinds-off).
- Ready for `/speckit-plan`. No clarification questions are outstanding.
