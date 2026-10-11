# Specification Quality Checklist: Per-event read state and snooze

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-11
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

## Validation notes

Iteration 1 found two leaks and one judgement call worth recording; both leaks were fixed before this
checklist was marked complete.

- **Fixed — "No implementation details".** N15 described the count gaining "one anti-join rather than a
  branch per state", and FR-003 said the count "MUST NOT join to targets, accounts or any table other
  than the activity log, the floor and the sparse marks". Both named a query shape rather than a
  behaviour. They now state the behaviour and the cost constraint behind it: the state is one comparison
  against the current time, and the count must not depend on the current state of the event's target or
  account.
- **Accepted — existing identifiers in "Context and sources".** `seen_seq`, `notification_states`,
  `/api/me/notifications`, `createNotificationsRepo` and the component folder appear in the Context
  section and in a few requirements. They are named because they are *shipped behaviour this entry
  changes*, and the roadmap entry names them as the surfaces to update. This follows the precedent set
  by `specs/022-problem-notifications/spec.md`, whose Context section names the same surfaces. They are
  references, not prescriptions: no new identifier, table name, column or query shape is specified here —
  that is the plan's job.
- **Accepted — SC-006's millisecond budget.** It is carried over verbatim from 022's SC-003 so the two
  are comparable, which is the whole point of the measurement: this entry must meet the budget 022 met
  *without* per-event state. A purely user-facing restatement ("the page feels instant") would not be
  falsifiable against the thing it has to be compared with.
- **No clarifications needed.** Three judgement calls had real alternatives — the snooze choices and
  their time zone (N17), what happens at the sparse-mark cap (N16.3), and whether a risen floor clears a
  snooze (N19). The roadmap entry explicitly asks the spec to *define* the last two, and a reasonable
  default exists for each, so all three are decided in "Decisions made while specifying" with their
  reasons, rather than deferred as blocking questions.

## Notes

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`.
- Two things planning must carry forward, because the roadmap's rules require them and the spec only
  states the obligation (FR-028): recording N13–N24 in `docs/decisions.md` **next to** N2 and N3 with
  the fate of data written under the old rule, and putting any browser, screenshot or
  visual-judgement task **last** in `tasks.md`.
