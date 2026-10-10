# Specification Quality Checklist: Auto-growing, monospace prompt and instruction fields

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

Validation run 2026-10-10, two iterations.

**Iteration 1 findings, all fixed:**

- Counts in Context, FR-021, FR-026, SC-006 and SC-008 were stated from the roadmap's description rather than
  from the tree. Re-verified every one of the thirteen sites: `RegenerateDialog` and `RejectDialog` do carry an
  `aria-describedby` (a counter id), and `SeriesPlanEditor` does not. Corrected to 7-of-13 wired today, six
  fields gaining wiring, and eight counters (six beside monospace fields).
- Two field names in the FR-018 / FR-019 tables did not match their rendered labels
  ("Regeneration instructions" → "Extra instruction (optional)"; "Variant text" → the visually hidden
  per-account label). Corrected, since FR-020 makes the label the identifier and the line number only a
  locator.

**Judgement calls recorded in the spec's Assumptions rather than raised as clarifications**, because a
defensible default exists for each and a blocking question would stall the pipeline for no gain:

1. *`aria-describedby` gains the error id everywhere.* The input asks both for `Field`'s contract exactly and
   for `voice.test.tsx:160` to keep passing; those conflict. `Field` wins and FR-041 records that the one
   assertion is updated.
2. *Scope of the supporting-copy pass* is bounded to the twelve files holding the thirteen fields plus
   `voice/` in full, rather than an app-wide typography sweep.
3. *`TryItPanel`'s Brief stays proportional* while the generation form's Brief becomes monospace. The
   classification tables are the authority; the reason is recorded so review treats it as a decision, not an
   oversight.

**Deliberate notes on "no implementation details":** the spec names existing files, line numbers, component
names and the two repo facts that constrain the solution (`Dialog` mounts closed children;
`vitest.config.ts` runs in `environment: "node"` with no DOM library, per `docs/decisions.md` P10). These are
not a chosen implementation — they are the state of the codebase a reader needs in order to judge whether a
requirement is satisfiable, and the house style in `specs/033-accounts-first-post/spec.md` does the same. The
requirements themselves state outcomes, not techniques; FR-014 and FR-016 are the only two that constrain
approach, and both do so because the alternatives are known not to work here.

**Not re-validated here:** nothing. All items pass.
