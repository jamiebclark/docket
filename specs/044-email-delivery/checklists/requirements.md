# Specification Quality Checklist: Email delivery

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

## Notes

- Iteration 1 found seven issues, all fixed in the spec before this checklist was marked complete:
  1. **An overclaim about database restores.** US6 and SC-002 asserted that nobody gets the same email
     twice "even when the database is restored from a backup taken a minute earlier" — which is false: the
     mailed-through position goes back with everything else, so that one message can arrive again. The
     story, its independent test, SC-002 and the test list now say what is actually guaranteed (concurrent
     ticks, a kill at any stage, a failure after accept, an unknowable outcome), and a new edge case names
     the restore case as the one Docket cannot cover, to be stated beside the backup instructions in
     `docs/deployment.md`.
  2. **An unbounded message.** Nothing stopped a bad day producing an email with hundreds of lines.
     FR-011 now bounds how many problems a message lists and requires it to count the rest with a link,
     and FR-021 says the position advances over the counted overflow, so a bad day is one message and not
     a run of them. A matching edge case was added.
  3. **Implementation detail inside a requirement.** FR-024 named the SQL claiming construct; it now
     states the behaviour ("claiming work the way the tick already claims work", so several processes may
     tick and a tick may be killed without losing or duplicating work). The construct belongs to the plan.
  4. **Two outcomes where a test needs one.** US4 scenario 6 and FR-029 said a token for a vanished
     person or an ended membership "is refused or has no effect". Both now assert the single invariant:
     nothing is written and the same neutral page is shown.
  5. **An untestable threshold.** FR-023's "enough consecutive temporary failures" now says the number is
     fixed in the plan, as the webhook endpoint's self-disabling threshold is.
  6. **A contradiction between FR-013 and FR-017.** FR-013 forbade changing "any bookkeeping" when there
     is nothing to send, while FR-017 requires a skipped digest's due instant to roll forward. FR-013 now
     names what must not change (no position advances, no attempt is recorded) and what may.
  7. **A protocol fact taken from memory.** FR-026 depended on the mail-client one-click unsubscribe
     headers, which are not in `docs/research/`. The `NEEDS RESEARCH` marker at the top of the spec now
     covers them explicitly, and FR-026 says the names and semantics must come from research
     (constitution I).
- **Two markers are deliberately left in the spec and are not defects**: `NEEDS DEPENDENCY: nodemailer`
  and `NEEDS RESEARCH: SMTP`. Docket has no mail package at all and headless phases cannot reach the npm
  registry (decision #19), so the wire transport is the one piece this entry cannot finish. The spec
  bounds the consequence instead of hiding it: FR-004 requires every other behaviour to be testable
  through the mailer interface with a recording mailer, and FR-005 specifies the
  configured-but-unavailable state (said once at startup, recorded per would-be send, no bookkeeping
  advanced, nothing retried in a loop, nobody told a lie). Planning should resolve the dependency from a
  front-end session if possible; if not, that single task ships marked and the rest of the entry still
  lands.
- Naming conventions carried deliberately from the house style of `specs/022-problem-notifications/`,
  `specs/042-per-event-read-snooze/` and `specs/043-notification-preferences/`: file paths, identifiers
  and prior decision numbers appear in "Context and sources" and "Decisions made while specifying", which
  exist so planning knows exactly which shipped behaviour and which prior decision each requirement sits
  against. They are sources and judgement calls, not implementation choices; every FR and SC is stated as
  behaviour.
- Judgement calls the spec phase made rather than deferring (all recorded as N42–N67 for
  `docs/decisions.md`): email is opt-in per person, deliberately the opposite of N27's default-on (N45);
  the SMTP group is the two variables that are meaningless alone, with credentials an all-or-none pair so
  an unauthenticated relay is still configurable (N43); a per-person time zone is introduced because
  people have none today and projects may disagree (N48); quiet hours govern immediate mail only, since a
  chosen digest hour is an explicit instruction (N49); an unknowable send outcome is recorded as sent and
  never retried, following constitution V (N54); the unsubscribe link does not act on the GET, because
  mail clients and scanners fetch links unasked, while a mail client's own one-click button does (N57);
  and the delivery log stores no reply text at all, departing from the webhook log's excerpt because a
  refusal quotes the recipient address (N60).
- Ready for `/speckit-plan`. No clarification questions are outstanding.
