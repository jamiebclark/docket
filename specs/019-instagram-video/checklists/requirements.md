# Specification Quality Checklist: Instagram video

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

- Validated in one pass on 2026-10-07; all items pass.
- **Implementation details**: no languages, frameworks, modules or code structure are prescribed. Instagram request values (`REELS`, `share_to_feed`, status codes, `VIDEO` never sent) are named on purpose. They are the externally verified platform contract from `docs/research/meta-video.md`, which constitution principle I requires specs to cite, as earlier entries (005, 017, 018) did. Repository docs are named only where the roadmap requires them to be updated.
- **No clarification markers**: every open choice was settled as a recorded decision (D1–D13) so the headless pipeline can continue. Choices the operator may want to revisit: D2 (Feed video is the default), D9 (keep checking every 5 minutes after the guidance's 5-minute window, up to the existing 60-minute ceiling), D10 (container allowance enforced from Docket's own count).
- **Left to plan, on purpose**: D8, the media type for a video carousel item (omitted or `REELS`). The research marks it UNVERIFIED; it is mocked only, and a live check by the operator is owed (FR-030).
- **Scope boundaries**: Stories (not on the roadmap), cropping, padding, trimming and encoding (entry 6), Facebook (entry 4), Threads (entry 5), Bluesky (entry 7), TikTok (entry 8). Unowned items (resumable upload to Instagram, cover and optional Reel fields) are recorded in feature-map (FR-035–FR-038).
- Generic changes G19 (per-target post-type choice, which adds a small schema field), G20 (per-type video limits) and G21 (lowest frame rate) touch shared code. Constitution V allows this as recorded generic hooks, the same way G1–G18 were added.
