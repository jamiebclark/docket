# Specification Quality Checklist: Comment and message engagement

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-15
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

## Validation record

Three iterations were run. Iteration 1 drafted the spec; iteration 2 fixed the issues below; iteration 3 re-checked every item and found none outstanding.

Fixed in iteration 2:

- **FR-007** said the tick must stay "well under its existing time bound" — unverifiable as written. Now names the 30-second bound.
- **SC-007** said reading "adds no measurable delay" — not measurable. Now states the two outcomes that can be measured: every scheduled post still goes out at its time, and the tick completes inside 30 seconds.
- **FR-039** prescribed "a durable ledger entry written in the same transaction" — a mechanism, not a requirement. Now states the property (no second send is possible across a crash, a restart or a concurrent attempt) and leaves the mechanism to planning.
- **FR-050** prescribed `kind::text` comparisons in constraints. Now states the behaviour that matters — an upgrade from an already-installed schema keeps working, not just a fresh install — and requires a test rather than care.
- **FR-051** prescribed widening a database CHECK. Now states the behaviour: existing switch settings keep their meaning.

## Notes

- **Deliberate deviation on "no implementation details", scoped to three sections.** `Context and sources`, `Constraints found while specifying` and `Decisions made while specifying` name files, tables, verified platform limits and a specific past production failure. This is the house style set by `specs/074-mcp-server/spec.md` and it is required by constitution I (external facts must come from `docs/research/` or an installed package, never from memory) and by the constitution's review bar (every requirement traceable). The mandatory template sections — User Scenarios, Requirements, Key Entities, Success Criteria, Assumptions — are stated behaviourally and are readable without the code.
- **Two platform limits are quoted as facts rather than implementation choices**: Bluesky's 300-grapheme / 3,000-byte post limit and its 5,000-points-per-hour shared write budget. Both are cited from `docs/research/bluesky.md`. They are inputs to the design, not decisions this spec makes.
- **One unresolved external dependency, by design.** `NEEDS RESEARCH: docs/research/engagement.md` (constraint 1). User Story 1 is that research; US2 and US3 do not depend on its Meta half, US4 depends on it entirely, and US5 is blocked on it. Planning must not fix any platform shape before it lands.
- **One assumption worth a human's attention rather than a clarification question.** "The existing Review queue and approval policy" and "nothing is ever sent unreviewed" cannot both be read literally, because the existing policy includes `auto_approve`. The spec resolves it by sharing the mechanism and pinning the policy (FR-029), and records the resolution as the first entry in Assumptions. If that reading is wrong, FR-029 is the single requirement to change.
- **Task ordering carries a hard constraint.** User Story 1's Meta spike needs live credentials, real accounts and a browser, so it is a human task. It must be scheduled last despite being first in risk order (constraint 2), or every other task stalls behind it.
