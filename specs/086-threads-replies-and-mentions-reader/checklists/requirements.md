# Specification Quality Checklist: Threads replies and mentions land in the inbox

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-19
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

### Validation record

Three iterations were run against the spec as written.

**Iteration 1 — content quality.** Two issues found and fixed:

- The Context section's verdict table named permission strings (`threads_manage_replies`,
  `threads_manage_mentions`). Kept deliberately: these are the *facts under dispute* that the
  entry's scope turns on, and the Context section exists to record what the research settled.
  They are quoted evidence, not a design instruction, and they appear nowhere in the
  requirements, which refer to "the confirmed Threads reply and mention permission names"
  without naming them.
- Early drafts of FR-009 named an endpoint-shaped concept. Rewritten to state the behaviour
  ("make no outbound request under any circumstances") and the prohibition, with no endpoint,
  field or path named anywhere in the requirements.

**Iteration 2 — requirement testability.** All 35 functional requirements were checked for a
falsifiable outcome. Two were strengthened:

- FR-015 originally said the unavailability should be "clear". Now states the precedence rule
  and its purpose (nobody asked to reconnect when reconnecting cannot help), which is testable
  against a Threads account that is both unavailable and missing the permissions.
- FR-024 was added, because FR-017 to FR-022 would otherwise read as properties of the Threads
  provider when they are properties of the shared ingest and inbox — which is what makes them
  provable at all, given Threads reads nothing.

**Iteration 3 — scope honesty.** The spec's central risk is that it reads as if it delivers the
entry's headline feature. Confirmed that it does not:

- The Context section states the no-reader outcome in its own heading and body, with the
  research's own words quoted as the reason.
- Out of Scope names the absent reader first, and names the deferred "two surfaces, one cursor"
  budget design explicitly rather than letting it vanish.
- Assumptions records the re-verification attempt made during specification, so the verdict is
  auditable rather than inherited.

### Standing notes for the planning phase

- **The blocked deliverable is the point of the entry, and is deferred by the feature
  description's own rule.** Both Threads surfaces' read endpoints, author identity shapes and
  pagination shapes are `unverified` in `docs/research/engagement.md` §2, which records "must
  ship declared-but-`unavailable`" as its own consequence for each. The description's rule —
  declare an unverified surface unavailable and ship the other — applied to both surfaces
  yields no reader. This is a stated-rule outcome, not an open question, so it is recorded as
  an assumption rather than as a clarification marker.
- **Do not let planning reintroduce the reader.** Any plan task that names a Threads replies or
  mentions endpoint path, response field or cursor parameter is drawing on memory, not on
  `docs/research/engagement.md`, and violates constitution principle I.
- **FR-005 and FR-003 are jointly constrained by an existing startup assertion**: a declaration
  may not both mark a surface unavailable and name read permissions. The confirmed permissions
  stay where the connect dialog requests them (FR-006), which is unchanged by this entry.
- **FR-017 to FR-023 may well pass on first run.** The parentless-item behaviour appears correct
  by construction in the current ingest, first-engagement and same-post count. The deliverable
  there is coverage plus the member-facing statement (FR-023), not a rewrite — and per the
  project's standing practice, any defect the coverage exposes is fixed in this entry rather
  than reported and left.
