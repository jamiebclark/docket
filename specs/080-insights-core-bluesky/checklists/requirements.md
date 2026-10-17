# Specification Quality Checklist: Post and account insights, with Bluesky as the pilot platform

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-17
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
   met, and the spec was not rewritten to meet them.** Three project rules require the opposite, and
   they win over generic spec-kit guidance:
   - The constitution's principle I ("Verified facts over memory, NON-NEGOTIABLE") requires every
     platform and library fact to cite `docs/research/*.md` or the installed package's own types, by
     name. A spec that said "read the platform's counts" instead of naming
     `app.bsky.feed.getPosts`, its 25-URI lexicon limit and the confirmed absence of any views field
     would be unverifiable and would invite the next phase to guess.
   - `.specify/roadmaps/social-insights.md` §1 names the files, tables, line numbers and constraints
     this entry must build against, and its "Rules for every entry" require the spec to say what it
     does not do and which later entry owns it. Dropping those references would discard the
     instruction.
   - The repo's own precedent: `specs/077-engagement-inbox/spec.md` and
     `specs/078-instagram-stories/spec.md` are written the same way, with a "Context and sources"
     section of file-level references and a "Constraints found while specifying" list. Docket is a
     self-hosted product whose spec audience is the engineer-operator running it.

   The requirements themselves are still written as behaviour ("MUST be absent, never zero", "MUST be
   skipped and counted as skipped"), not as code; the file references sit in Context, Constraints,
   Decisions and the research table, where they are evidence rather than instruction.

2. **Success criteria are outcome-shaped but a few name a mechanism**, because the outcome is only
   checkable through it: SC-007 names the tick summary and the heartbeat (the roadmap's whole reason
   for requiring them is that a starved section is otherwise invisible), SC-011 names the existing
   secret-scan suite, and SC-012 names the repo's own quality gates, which the constitution makes a
   merge condition. SC-001 to SC-006 and SC-008 to SC-010 are technology-agnostic.

3. **One open research item is recorded rather than guessed** (`NEEDS RESEARCH` in constraint 1):
   whether Bluesky's public AppView answers `app.bsky.feed.getPosts` and `app.bsky.actor.getProfile`
   without authentication, and at what read limit. It is **not** a `[NEEDS CLARIFICATION]` for the
   user, because it is a fact about a third party that no answer from the user could settle, and the
   spec's design deliberately does not depend on it (reads go through the session the account already
   holds — see Decisions). It must be written into `docs/research/bluesky.md` by FR-081 before the
   reader is built.

4. **Two live-verification items are parked at the end of the task list by FR-058 and the
   "Task ordering note for planning"**, per the roadmap rule and the standing lesson from 077: a
   judgement task needing a real platform account or a browser in an early phase starves the
   implement loop.
