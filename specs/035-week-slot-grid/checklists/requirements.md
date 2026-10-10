# Specification Quality Checklist: Reusable week grid for posting slots

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-10
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

Validation run 2026-10-10, one iteration. All items pass. Details and the
judgement calls behind two of them:

- **"No implementation details"** passes with a deliberate, bounded exception.
  The Context section names real files, line numbers and identifiers
  (`src/server/services/slots.ts`, `posting_slots_account_time_uq`,
  `SlotEditor.tsx`, `slot: ["manage"]`). That is required by constitution
  principle I ("verified facts over memory") and matches the house style of
  every other spec in `specs/`, including the immediately preceding entry
  `034-prompt-text-fields`. The requirement and success-criteria sections
  themselves stay behavioural: they say what must happen, not which component,
  library or API does it. Two requirements name a capability string
  (`slot: ["manage"]`, FR-037/FR-039/FR-040) because *which* permission gates
  the grid is the requirement, and one names the `HH:MM` wire format
  (FR-005/FR-019) because the displayed and announced format is user-visible.
- **"Requirements are testable"**: the spec records in Assumptions that this
  repository has no browser DOM testing library, and states how the interactive
  requirements are expected to be verified (pure logic modules plus
  rendered-markup assertions, as the calendar's drag already is), with an
  instruction to mark `NEEDS DEPENDENCY` rather than leave a requirement
  unverified. Without that note, FR-042 and FR-015 would read as testable but
  have no available harness.

Three corrections to the roadmap entry's premises, carried into the spec so
planning does not rediscover them:

1. The roadmap says duplicate rejection comes from `addSlotSchema`. It does
   not — `addSlotSchema` validates shape only; the rule is the unique
   constraint `posting_slots_account_time_uq` translated to a `ConflictError`
   in `src/server/dal/slots.ts`. FR-031 points at the real rule.
2. The roadmap says the accounts page shows an "active/paused summary". It
   shows "Connected accounts (N)" and a per-slot status badge; the active and
   paused counts live on the project overview via `listSlotCounts`. FR-051
   covers both.
3. Deleting `SlotEditor` breaks `ConnectLanding`'s focus selector
   (`input[name="slot-day-${id}"]:checked`), which nothing in the roadmap
   mentions and which `tests/integration/accounts-landing.test.ts` covers.
   FR-050 covers it.

One deliberate deviation from `docs/design-system.md` is recorded in the spec
rather than left implicit: FR-022 removes the confirmation step for deleting a
slot, against the design system's rule that `danger` actions always confirm in
a dialog. The rationale and the requirement to document the exception are both
in FR-022.
