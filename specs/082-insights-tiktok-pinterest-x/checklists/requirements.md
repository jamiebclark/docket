# Specification Quality Checklist: TikTok and Pinterest numbers, and a priced opt-in for X

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-18
**Feature**: [spec.md](../spec.md)

## Content Quality

- [ ] No implementation details (languages, frameworks, APIs) — **deliberate deviation, see Notes 1**
- [x] Focused on user value and business needs
- [ ] Written for non-technical stakeholders — **deliberate deviation, see Notes 1**
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [ ] Success criteria are technology-agnostic (no implementation details) — **partial, see Notes 2**
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [ ] No implementation details leak into specification — **deliberate deviation, see Notes 1**

## Notes

1. **The three "no implementation details / non-technical stakeholders" items are deliberately not
   met, and the spec was not rewritten to meet them** — the same deviation, for the same reasons,
   recorded on `specs/080-insights-core-bluesky/` and `specs/081-insights-reconnect-and-meta/`:
   - Constitution principle I ("Verified facts over memory", NON-NEGOTIABLE) requires every platform
     fact to cite `docs/research/*.md` by name. A spec that said "ask TikTok for the numbers" instead
     of naming `video.list`, `publicaly_available_post_id`, `pins:read`,
     `PINNER_DATA_ACCESS_DENIED` and the $0.001 Owned Read rate would be unverifiable and would
     invite the next phase to guess — which here would mean guessing with the operator's money.
   - `.specify/roadmaps/social-insights.md` §3 names the files, scopes, line numbers and prices this
     entry must build against, and its "Rules for every entry" require the spec to say what it does
     not do and which later entry owns it.
   - Repo precedent: 077, 078, 080 and 081 are all written this way. Docket is a self-hosted product
     whose spec audience is the engineer-operator running it.

   The requirements themselves stay behavioural ("MUST be absent, never zero", "MUST never be
   claimed, leased, decrypted or called", "MUST defer rather than fail", "MUST NOT infer a grant it
   did not observe"); the file, endpoint and price references sit in Overview, Context and Assumptions
   where they are evidence rather than instruction.

2. **Success criteria are outcome-shaped but several name a mechanism**, because the outcome is only
   checkable through it: SC-004 and SC-005 are measured as "no request is recorded", SC-006 counts
   calls and payloads, SC-008 names the existing security scan, and SC-012 names the repo's gates.
   SC-001, SC-002, SC-003, SC-007, SC-009, SC-010 and SC-011 are technology-agnostic.

3. **Three research gaps are recorded rather than guessed** (FR-001 to FR-003: TikTok's video-query
   endpoint and `video.list` scope, Pinterest's `metric_types` enum and analytics response shape, and
   X's metrics endpoint), each with the Threads posture as the fallback (FR-004: declare the surface
   unavailable with the reason, never guess). They are not `[NEEDS CLARIFICATION]` markers because
   they are not questions for the user — they are research tasks with a defined, already-specified
   failure mode.

4. **Five parked human tasks** (live consent screen, live Pinterest connect, funded X key) are listed
   in their own section and must land at the very end of the task list, per the roadmap's rule and
   the repeated experience that a judgement task in an early phase starves the implement loop.

5. **Three generic provider-contract changes** are required (G35 the stored identifier a post reader
   needs, G36 the public post id on a successful publish result, G37 post-vs-account required
   scopes), each to be recorded in both `docs/adding-a-provider.md`'s "Generic hooks index" and
   `docs/decisions.md`. The index currently runs to G34.
