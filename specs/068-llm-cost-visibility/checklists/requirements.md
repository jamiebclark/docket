# Specification Quality Checklist: LLM cost visibility — show a project what it used

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

- **"No implementation details" is read as this repo reads it.** Docket's specs deliberately cite the
  behaviour on `main` they build on, with file and line references, because the constitution requires
  verified facts over memory and every prior entry (`specs/043-llm-credit-hold`,
  `specs/065-per-project-llm`) does the same. Those citations live in "Context and sources" and
  "Decisions made while specifying"; the Requirements, Success Criteria and User Scenarios sections
  name no language, framework, library or schema, and no functional requirement prescribes a table
  shape, column type, route or component.
- **Decisions are recorded, not deferred.** The roadmap asked this spec to decide two things —
  where rates live (**M8–M11**: operator-supplied install configuration, empty by default, no prices
  shipped, computed at render time) and how an unpriced model is displayed (**M13–M14**: calls and
  tokens with an explicit "no rate configured" marker, excluded from totals that say so, with money
  absent entirely when no rate exists). Both are decided, so no `[NEEDS CLARIFICATION]` marker is
  needed and none is present.
- **Money wording is a testable requirement, not a tone note** (FR-020, SC-005): the fixed upper-bound
  sentence must accompany every money figure, and the words "spend", "cost", "charged" and "billed"
  are forbidden as labels for one.
- **SC-008 carries a timing number** ("under 2 seconds for a project with 50,000 recorded calls").
  It is user-facing (how long a person waits for the screen), not a database or framework metric.
- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`. None are
  incomplete.
