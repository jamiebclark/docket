# Specification Quality Checklist: Real-time updates

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-12
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
  1. **The change probe could not see the changes the spec promised to push.** N71 originally watched two
     scalars — the newest attention position and the newest notification-state change — but FR-011 and
     FR-024 promise that a preference change and a *membership removal* reach an open tab in seconds, and
     a "newest change instant" can never see a deleted row. N71 and FR-010 now require the probe to cover
     every input the count depends on (attention events, the read floor, sparse marks, preference
     switches, memberships) and to see additions, changes **and deletions**, with a row count alongside
     each instant; the exact set is the plan's to fix, still in one query.
  2. **An overclaimed cost saving.** SC-004 and N72 said an install with ten tabs would do "strictly less
     database work" than today. False as stated: a 2-second probe is 30 queries a minute per web process
     whether or not anybody is connected, against ten count queries a minute today. Both now state the
     real trade — the *expensive* per-person count moves from once per tab per minute to once per
     connected person per actual change, at the cost of a fixed, cheap probe that does not scale with
     tabs — and SC-004 quantifies it (600 count queries an hour down to zero on a quiet hour, 1,800 cheap
     probes an hour added).
  3. **The connection cap could exhaust the database pool.** 50 streams per process against a default
     pool of 10 connections: nothing said how many recomputes may run at once. FR-009 now requires the
     watcher to bound its concurrent recomputes so a full process cannot starve ordinary page requests.
  4. **"The value differs" was ambiguous.** FR-010 said a message is sent when "the value" differs, but
     the payload carries a next-change instant as well as a count, and a snooze set elsewhere can change
     one without the other. FR-010 now names both fields.
  5. **Nothing forbade running both refresh mechanisms at once.** FR-019 now requires exactly one of the
     stream and the poll to be running at any moment, so a healthy stream does not sit alongside a
     60-second poll doing the same work.
  6. **A held stream could have kept a session alive for ever.** The stream re-checks the session once a
     minute, and a session read that renews expiry would keep renewing a session whose browser can never
     receive the refreshed cookie — a tab left open for days would outlive its own sign-out window.
     FR-022 and a new edge case now require that re-check to be read-only with respect to expiry.
  7. **A success criterion named a browser API.** SC-005 said "no `EventSource`"; it now describes the
     condition in behaviour terms ("a browser that cannot hold a stream"). The API name stays in the
     decisions and assumptions, where sources belong.
- **No `NEEDS CLARIFICATION`, `NEEDS RESEARCH` or `NEEDS DEPENDENCY` markers.** Everything this entry
  needs is either already installed or needs nothing: streaming route handlers are documented by the
  installed framework's own guide (`node_modules/next/dist/docs/01-app/02-guides/streaming.md`), the
  browser side needs no package, and `connect-src 'self'` in the existing Content-Security-Policy already
  permits a same-origin stream. The only external fact deliberately left unresearched is per-product
  reverse-proxy configuration, which `docs/deployment.md` §7 already handles by stating requirements
  rather than recipes (constitution I).
- Naming conventions carried deliberately from the house style of `specs/022-problem-notifications/`,
  `specs/042-per-event-read-snooze/`, `specs/043-notification-preferences/` and
  `specs/044-email-delivery/`: file paths, identifiers and prior decision numbers appear in "Context and
  sources" and "Decisions made while specifying", which exist so planning knows exactly which shipped
  behaviour and which prior decision each requirement sits against. The transport (Server-Sent Events)
  was fixed by the roadmap entry itself, and the deployment constraints are, in the roadmap's words, "the
  entry's real content, not an afterthought" — so naming them is the assignment, not leakage. Every FR
  and SC is still stated as behaviour.
- **The reversal is named, as the roadmap requires.** N12 is reversed in its first half (the 60-second
  poll becomes the fallback) and kept in its second (announce only on a rise). Nothing migrates, because
  N12 stored no data — it was a timer and a fetch. The spec says so in its own section, and FR-032
  requires the replacement to be recorded in `docs/decisions.md` next to N12.
- Judgement calls the spec phase made rather than deferring (recorded as N68–N84 for
  `docs/decisions.md`): snapshots rather than increments, which is what makes reconnection safe with no
  replay buffer, no cursor and no message ids (N69); no process ever notifying another — every process
  finds the change in the shared database, which dissolves the `RUN_WORKER_IN_PROCESS` problem and keeps
  Postgres `LISTEN` out, as the constitution demands (N71); the stream following the visible tab, which
  is a correctness measure under HTTP/1.1's six-connections-per-origin limit and not an optimisation
  (N73); caps as constants rather than environment variables, with the oldest of a person's streams
  displaced and a full process refusing the newcomer rather than evicting a stranger (N74, N75); a
  deliberately 5-minute connection so proxy timeouts, restarts and deploys are ordinary events (N76); the
  opening-snapshot deadline as the detector for a *buffering* proxy, which otherwise looks perfectly
  healthy while delivering nothing (N77); the poll kept as a working fallback with the server-rendered
  count still the floor (N79); and a snapshot yielding to the person's own action for one probe interval
  so the badge never flickers back to a number they just acted on (N84).
- Ready for `/speckit-plan`. No clarification questions are outstanding.
