# Specification Quality Checklist: Terminology, page descriptions and nav order

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-09
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

- The spec names existing UI primitives (`PageHeader`, `StatusBadge`, `SegmentedControl` cards) and cites file:line
  locations. The roadmap's rules require reusing named primitives, and the audit re-check must cite current lines, so
  these references are deliberate. They constrain reuse, not design. No new technology is introduced.
- Copy marked *(audit)* is the audit's exact wording. Other descriptions are new and may be adjusted in planning only
  to stay accurate (FR-012).
- One intentional test change: `tests/integration/failures/nav.test.ts:27` (Activity after Failures), because
  Activity moves to Project. The Review-above-Failures and Failures-label assertions stay. `roles/routes.test.tsx:176`'s
  absence check moves to the new "New batch job from CSV" label so it doesn't pass vacuously.
- Validation passed on the first iteration.
