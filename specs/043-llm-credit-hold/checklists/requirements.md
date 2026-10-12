# Specification Quality Checklist: Credit hold — stop mass-failing generation jobs when the provider refuses on billing

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-11
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — *see Notes: existing-code references are deliberate and required by the roadmap; no new implementation is prescribed*
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders — *the user stories, success criteria and out-of-scope list read without code knowledge; the context section is for the planner*
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details) — *SC-001…SC-010 measure failed items, calls per hour, time to resume, operator comprehension and secret leakage, not internals*
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification — *as above: what exists is named, what to build is not designed*

## Roadmap and constitution obligations

- [x] Roadmap preamble read in full, and its "Behaviour on `main`" bullets reflected (provider layer, `LlmFailureKind` and both pgEnums, `TEMPORARY`/`retryLater`/`fail`, the env-only invariant, usage captured but unpersisted)
- [x] `docs/generator.md` ("Configuring a provider", "Jobs") and `docs/security.md` read in full
- [x] Roadmap rule: says what it does **not** do and names the later entry that owns each thing (Out of Scope, FR-037)
- [x] Roadmap rule: no secret reaches a log, a response or the UI, and the secret-scan suite is **extended, not exempted** (FR-032, FR-033)
- [x] Roadmap design constraint: the hold is scoped by credential owner from day one, with entry 2's widening costed as a function change (C7, FR-011, FR-012, SC-010)
- [x] Roadmap exclusion honoured: no per-project keys or settings, no persisted usage or cost, and the already-landed `bad_request` message is not re-spec'd (C4, FR-005, Out of Scope)
- [x] Constitution I: external facts are cited to installed SDK types or marked as the author's verification; `docs/research/llm-and-storage.md`'s own "not confirmed" note is quoted, and detection is required to degrade safely rather than guess
- [x] Constitution II: every provider behaviour is required to be tested with mocked HTTP only (FR-038)
- [x] Constitution VI/engineering constraints: no new dependency, no new infrastructure, no new env var, no session-level Postgres feature (C10, FR-015, Assumptions)
- [x] Constitution: docs obligations stated (`docs/generator.md`, `docs/decisions.md` C1–C14, `docs/n8n.md`, `docs/security.md`)

## Notes

- **On "no implementation details"**: this spec names existing files, enums, functions and line numbers. That is deliberate and is how every prior spec in this repo is written (compare `specs/042-per-event-read-snooze/spec.md`): the roadmap preamble requires the entry to build on specific named behaviour on `main`, and the constitution requires verified facts to be traceable. No new module, schema shape, column list or algorithm is prescribed — the hold's storage shape, the predicate's exact phrase and the probe's wiring are left to `/speckit-plan`.
- **Judgement calls that planning must record** as C1–C14 in `docs/decisions.md`: the kind's name, the narrow detection predicates, never failing an item on billing, the hold rather than `TEMPORARY`, credential-owner scoping before there are two owners, the 5-minute single-flight probe, interactive calls staying unblocked as free probes, no give-up timeout, no stored credential fingerprint, and the two notices.
- **Deliberately decided rather than asked**: whether interactive generation is blocked while held (it is not — C11), the probe interval (5 minutes, a documented constant, not an env var — C9), and whether a hold ever gives up (it does not — C12). Each has a stated rationale and a reversible cost, so none was worth blocking the pipeline on.
- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`. Nothing is incomplete.
