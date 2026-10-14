# Specification Quality Checklist: Pinterest provider

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-14
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

- Validation pass 1 (2026-10-14): all items pass.
- **Platform facts, by project convention.** Like the earlier provider specs (004–006, 014, 026), this spec
  names Pinterest's documented limits, scopes, error statuses and token lifetimes, and the "Context and
  sources" and "Request vs research" sections name provider-contract members and file paths. Those are
  required external behaviour (constitution I: platform facts come from `docs/research/pinterest.md`) and the
  plug-in contract (constitution V), not design choices. The functional requirements themselves are written as
  behaviour — "a pin cannot exist without a board", "an over-long description is refused naming the limit" —
  rather than as endpoint calls, and the user stories, edge cases and success criteria stay outcome-focused.
  How it is built (module layout, step naming, hook numbers, where the board read is cached) is left to the
  plan.
- **No clarification markers.** Every open point has an informed default recorded in the spec, per the owner's
  standing instruction to keep building and log decisions. The five that most shape the entry:
  - **The post's text is the pin's description** (800 characters), with **title** and **link** as per-target
    fields. Pinterest wants three text slots where Docket models one; putting title and link on the target
    keeps the composer unchanged for every other provider.
  - **The board is a required per-target choice**, read live, rather than an account setting — one Pinterest
    account with many boards stays one Docket account.
  - **No hard aspect-ratio or pixel range.** Pinterest's 2:3 figure is a recommendation about feed cropping,
    and no official minimum or maximum exists; a hard limit would refuse pins Pinterest accepts, so
    out-of-range images warn and still publish.
  - **`pins:read` is not requested.** Its only use would be the post-hoc duplicate check, which Pinterest's own
    reference flags for performance problems and which Docket's manual resolve-ambiguous flow has no way to
    call. The grant stays at the minimum three permissions.
  - **The Trial-access shared cap is documented, not enforced.** 300 creates per day per app, shared across
    accounts, cannot be expressed by a per-account publish limit; the spec requires it be stated on the account
    card and in the setup guide instead of being silently mis-counted.
- **Scope deliberately excludes video and carousel pins**, each with its reason and a named later entry, so this
  entry stays reviewable and ships before the catalogue it serves is out of season.
- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`.
