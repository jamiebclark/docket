# Specification Quality Checklist: Video groundwork

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-07
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

- Validation pass 1 (2026-10-07): two items were fixed in the spec. FR-029 said a post "MUST be refusable", which is not testable; it now says queueing, scheduling or publishing is refused with a named issue. SC-010's "at most five announcements" clashed with FR-003, which also announces errors and the final state; it now counts progress milestones only. Every item passes after those fixes.
- Named tools are deliberate, not leaked implementation detail. ffmpeg/ffprobe, Debian's package, presigned multipart, the browser-facing endpoint setting and ListParts are **operator decisions** made before this entry. The roadmap requires them to be recorded, and `NOTICE` and `docs/storage.md` must name them. The functional requirements still describe behaviour (where processing runs, what the browser checks, what Retry resumes) and leave the mechanism to the plan, except where the operator fixed it.
- No clarification markers were needed. The open points in the roadmap were settled as logged decisions: the larger limits are quantified in D3, resume-vs-chunked in D6/D7, and API and generator scope in D10/D11. Planning records them in `docs/decisions.md`.
- Unowned follow-ups are listed in Out of scope with "not owned by any entry on this roadmap": API video upload, the generator using posters, and resuming after a reload. This meets the roadmap rule that every entry says who owns what it leaves out.
