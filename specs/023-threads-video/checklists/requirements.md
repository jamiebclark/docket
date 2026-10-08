# Specification Quality Checklist: Threads video

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-08
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

- Validation pass 1 (2026-10-08): all items pass. Checked the read count in D6, FR-011, US3 scenario 4 and SC-005 against the pace: reads at 0.5, 1.5, 2.5, 3.5, 4.5 and 5.5 minutes, then 10.5 to 55.5 every five minutes, and the failing read at 60.5 make 17, ending within 65 minutes.
- **Platform names in the spec are deliberate.** Threads' fields and values (`media_type=VIDEO`, `video_url`, `is_carousel_item`, `children`, `fields=status,error_message`, the status values and the video error codes, including Threads' own spelling `INVALID_ASPEC_RATIO`) appear because the constitution (principle I) requires external facts to be cited from `docs/research/`, and the request names them. They describe Threads' contract, not Docket's implementation; no language, framework, module or schema is prescribed. This follows the convention of specs 017 to 021.
- **No clarification questions.** The open choices were decided and logged as D1 to D12 (no post type choice, the declared limits and what is left to Threads, no alt text for video, item checks before the carousel, the polling pace and 60-minute ceiling, error explanations, fetch by address, unchanged outcomes, restart on change, no new rate or creation limit, one set of limits for badges). The runner is headless, and the owner's standing instruction is to decide and log rather than ask (`docs/decisions.md`).
- **UNVERIFIED facts carried into the spec** (from `docs/research/meta-video.md`): whether video carousel items must finish before the parent is created, typical processing time, and resumable upload for Threads. The first two are handled conservatively (D5, D6); the third is out of scope (D8, FR-030). All are in the operator's owed live checks (FR-027).
- Out of scope, with owners: cropping, padding, trimming and encoding (entry 6), Bluesky video (entry 7), TikTok (entry 8), Instagram and Facebook (entries 3 and 4, done), resumable upload, covers, alt text for video, API video upload and generator video (unowned, feature map), other Threads post kinds (not on the roadmap).
