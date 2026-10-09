# Specification Quality Checklist: TikTok provider

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

- Validation pass 1 (2026-10-08): one issue was found and fixed before the pass was recorded. The first draft rounded the chunk size up, which would have made the final chunk nearly twice the size of the others, risking the step time limit. D9 now rounds down, and SC-006 has exact figures. The draft also promised a TikTok post link with no link format in the research; D11 now builds no link. After both fixes, all items pass.
- Platform endpoint, field and error names (`creator_info/query`, `privacy_level_options`, `FILE_UPLOAD`, `Content-Range`, `publish_id`, `url_ownership_unverified` …) appear on purpose. They are TikTok's contract, not Docket's implementation, and earlier provider specs (019, 021, 023, 025) name them the same way, so the mocked tests can check the exact requests. Operator variable names and doc file names are deliverables the roadmap requires. Generic hook references (G10, G19, G23, G24) point at the existing framework that `docs/adding-a-provider.md` documents; the spec prescribes no code structure.
- Constitution V (providers are plug-ins): TikTok needs three generic additions (D3 posting fields, D4 live account details, D5 consent), each inert for other providers and recorded with how to reverse it (FR-012 to FR-015). Planning should check this against G19's precedent.
- Unverified research facts are marked UNVERIFIED, and each has a fallback decision. They are: the D8 "1080p" reading and the 300 s duration, the D9 repeated chunk and chunk sizing, the D2 token reply fields and no PKCE, and the D7 declaration link targets. Two facts are marked NEEDS RESEARCH: the post link format (D11) and the declaration's policy links (D7). Neither blocks planning.
- Key risk for review: D5 records consent when the post is scheduled. Whether TikTok's audit accepts that is UNVERIFIED. The fallback (confirm at send) is recorded as owned by no spec (FR-042).
- Out of scope: everything is unowned, because this is the last roadmap entry. It includes the audit itself (the operator's job), analytics, comments, inbox, inbox (draft) upload, webhooks, grant revocation, a media route on Docket's domain, the AIGC label, cover frames, music, TikTok fields in the API, generator and bulk create, confirm-at-send, and an install-wide count against the 5-user cap. All are recorded in `docs/feature-map.md` (FR-040 to FR-043).
