# Specification Quality Checklist: Persist what a platform granted, then read Instagram, Facebook Page and Threads numbers

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
   met, and the spec was not rewritten to meet them** — the same deviation, for the same three
   reasons, recorded on `specs/080-insights-core-bluesky/checklists/requirements.md`:
   - Constitution principle I ("Verified facts over memory", NON-NEGOTIABLE) requires every platform
     and library fact to cite `docs/research/*.md` or the installed package's own types, by name. A
     spec that said "ask Meta for the numbers" instead of naming `instagram_manage_insights`, the
     April-2025 removal of `impressions`, `X-Business-Use-Case-Usage` and Graph codes 80001/80002
     would be unverifiable and would invite the next phase to guess.
   - `.specify/roadmaps/social-insights.md` §2 names the files, scopes, constraints and line numbers
     this entry must build against, and its "Rules for every entry" require the spec to say what it
     does not do and which later entry owns it.
   - Repo precedent: `specs/077-engagement-inbox/spec.md`, `specs/078-instagram-stories/spec.md` and
     `specs/080-insights-core-bluesky/spec.md` are all written this way. Docket is a self-hosted
     product whose spec audience is the engineer-operator running it.

   The requirements themselves remain behavioural ("MUST be absent, never zero", "MUST never be
   claimed, leased, decrypted or called", "MUST leave the stored value unchanged"); the file and
   endpoint references sit in Context, Constraints, Decisions and the research table, where they are
   evidence rather than instruction.

2. **Success criteria are outcome-shaped but a few name a mechanism**, because the outcome is only
   checkable through it: SC-003 and SC-007 are measured as "no request is recorded", SC-009 is
   measured against rows in `docs/research/meta.md`, and SC-010 names the existing security scan.
   SC-001, SC-002, SC-004, SC-005, SC-006, SC-008 and SC-011 are technology-agnostic.

3. **Five open research items are recorded rather than guessed** (see "Facts recorded against the
   research notes"), four against `docs/research/meta.md` and one against
   `docs/research/pinterest.md`. None is a `[NEEDS CLARIFICATION]` for the user: each is a fact about
   a third-party platform that no answer from the user could settle, and the spec states for each
   whether it blocks (only item 1 blocks, and only the three readers — never the first half of the
   entry) and what the conservative fallback is. FR-001 to FR-005 make the research a precondition of
   the readers, exactly as the roadmap orders.

4. **Two disagreements with the roadmap are recorded rather than silently resolved** (items 6 and 7
   of the same section): `optionalScopes` is specified on the OAuth connect group rather than on the
   provider, because the group builds the authorization URL and one group serves providers with
   different needs; and Facebook Reel targets are declared unqueryable, because they publish a video
   id rather than a Page post id, which the roadmap does not mention.

5. **Every task needing a live consent screen, a real platform account or a browser is parked at the
   end of the task list** by the "Task ordering note for planning", per the roadmap rule and the
   standing lesson from 077 and 080: a judgement task in an early phase starves the implement loop.
   This entry's headline journey *is* a consent screen, so the note enumerates the parked tasks
   explicitly and states that everything else is reachable with mocked HTTP alone.

6. **Items marked incomplete above require no spec update** before `/speckit-plan`; they are recorded
   deviations, not gaps.
