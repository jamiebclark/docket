# Feature Specification: Hardening for real use — failures view, limits audit, security pass, configuration and deployment

**Feature Branch**: `010-hardening-deployment`

**Created**: 2026-10-04

**Status**: Draft

**Input**: User description: "Harden Docket for real use. Before specifying, read docs/build-prompt.md in full (especially 'Deployment', 'Scheduler rules', 'UI' -> failures view, 'Quality bar' and 'Owner answers': deploy locally first, then on an Unraid server via Docker Compose; Netlify is skipped), .specify/memory/constitution.md, all of docs/research/ and docs/decisions.md. Must deliver: a failures view (/p/[slug]/failures) listing ambiguous and failed targets across the project with their full publish_attempts logs, resolution actions for ambiguous targets (mark published with optional external URL / mark not published and requeue) and retry for failed ones; an audit that every provider limit (text length, media count/size/format, rate limits) is enforced in our code before platform calls, filling gaps with tests; a security pass (tokens never in logs/responses/UI — add a test that scans log output and API responses in the e2e mock flow for credential values; CSRF on mutations; tick endpoint secret; webhook secrets; headers) with findings fixed; startup env validation covers every variable and .env.example is complete; docs/deployment.md covering honestly: local Docker Compose, Unraid (Compose stack, volumes, backups, reverse proxy + HTTPS, public media bucket requirement), a container host + Neon (pooled vs direct URL, worker as second service or external cron hitting /api/internal/tick), Render free-tier trade-offs (spins down after 15 min, no background workers or cron, free Postgres expires after 30 days — external cron every minute is fragile); README final pass (features, quick start, configuration, architecture overview, adding a provider); docs/adding-a-provider.md refreshed against the final framework. Verify `docker compose up` from a clean checkout end-to-end with the mock provider and document the exact steps run. Must NOT do: new platforms, video, analytics, billing, Netlify adapter (out of scope)."

## Context and sources

- Product behaviour: `docs/build-prompt.md` "Scheduler rules" (an unknown publish outcome is marked ambiguous and surfaced for the owner to resolve; mixed outcomes make a post `partially_failed` and individual targets can be retried; per-account publish limits are enforced in our own code before calling the platform), "UI" (a failures view showing ambiguous and failed targets with their attempt logs), "Deployment" (Docker Compose first, then a container host plus Neon; Render free-tier facts checked by the owner, which must shape `docs/deployment.md`), "Data model" (`publish_attempts` is append-only and never holds tokens; tokens never reach the browser or the logs), "Quality bar" (`.env.example` documents every variable; startup validation fails loudly when one is missing; README, `docs/deployment.md` and `docs/adding-a-provider.md`), "Owner answers" 2 (the repo is public; docs must not assume the owner's infrastructure) and 5 (Netlify skipped; deploy locally first, then on an Unraid server via Docker Compose).
- External facts used here, with their sources:
  - Provider limits: `docs/research/bluesky.md` (300 graphemes and 3,000 bytes of text; 4 images; 2,000,000 bytes per image; `createSession` 30 per 5 minutes and 300 per day per account; writes 5,000 points per hour and 35,000 per day, create = 3 points — **approximate**, the source page did not load), `docs/research/meta.md` (Instagram JPEG only, 8 MB, aspect 4:5 to 1.91:1, width 320–1,440 px, 10 carousel items, alt text ≤1,000 characters, 100 API-published posts per rolling 24 h, media required; Threads 500 characters with emoji counted by UTF-8 bytes, JPEG/PNG, 8 MB, width 320–1,440, aspect ≤10:1, carousel 2–20 items, 250 posts per 24 h). Facebook Page values are 005's interim R1–R10 constants, **UNVERIFIED** (`docs/decisions.md` 005).
  - Neon: `docs/research/tooling.md` (the `-pooler` host is transaction-mode PgBouncer; `FOR UPDATE SKIP LOCKED` works there, session features do not; migrations use the direct URL `DATABASE_URL_DIRECT`, falling back to `DATABASE_URL`).
  - Public media bucket: `docs/research/llm-and-storage.md` §3 (R2 public custom domain or rate-limited `r2.dev` for development; presigned URLs do not work on custom domains; set `Content-Type` on upload) and the build prompt "Media" (Instagram and Threads cannot fetch from `localhost`).
  - Render free tier: the owner's own checked facts in `docs/build-prompt.md` "Deployment" (spins down after 15 minutes without inbound traffic; no background workers or cron jobs; free Postgres expires after 30 days).
- What already exists and is reused rather than rebuilt (constitution IV):
  - `retryTarget` and `resolveAmbiguous` in `src/server/services/posts/` (002), and the per-target Retry / Mark as published / Mark failed actions on the post detail page (003). The failures view calls these services; it does not reimplement them. `resolveAmbiguous`'s "failed" outcome is replaced by "not published" with requeue (FR-008).
  - The per-target attempt log (`listAttempts`) and the attempt outcome vocabulary (`retry_requested`, `resolved_published`, `resolved_failed`, `recovered_ambiguous`, `stale_result`, …).
  - The one validation path (`planImage` then `validateTargetContent`, 003) used by the composer check, queue and schedule gates, and the publish-time re-check; provider capabilities as the single source of every limit (003, G9); the engine's publish-limit counting (002 "Limit counting").
  - Startup order (env validation → migrations → bootstrap, 001 D14), provider-declared environment (G8), the storage env group (003), the LLM startup check (007 generic change 6).
  - The tick endpoint's hashed constant-time secret check and its 32-character minimum; webhook signing, rotation and the delivery log (009); `safe-fetch` with its address policy (009); the existing no-secrets tests for Meta (`tests/integration/meta/no-secrets.test.ts`).
- Findings earlier reviews deferred to this entry and taken into scope here (each one in its own requirement below): 009 N15 (a chunked request body is read whole before the size check), 009 "DNS rebinding and IPv6 edge ranges" for `safe-fetch` (6to4, Teredo and documentation ranges missing), 009's webhook-URL rule ("tightening belongs to the hardening security pass"), 003 F15 ("Mark as published" link accepts any URL scheme and is rendered as a link), 001 F4 (only one of two audit-write paths refuses secret-looking detail keys), 001 F7 (the pre-start migration runs before configuration is validated), 001 F12 (an empty `DATABASE_URL_DIRECT=` is read two different ways), 002 F21 (an engine-side failure before the provider is called is recorded as ambiguous on a may-publish step), 003 F9 (the post detail page does not show a target's attempt count), 004 F5 (`docs/adding-a-provider.md` contradicts the code in places) and 006 F7 (the G11 refresh hold interacts with `needsRefresh`; the provider guide should say so). Every other MINOR recorded in earlier reviews stays out of scope (see Assumptions).

**NEEDS RESEARCH** (cannot be fetched by pipeline phases; recorded, not guessed):

- **U1 — Unraid specifics.** `docs/research/` has nothing on Unraid: how a Compose stack is installed and managed there (built-in support or a community plugin), its conventional host path for persistent data, and its built-in or customary reverse-proxy options. `docs/deployment.md` describes the Unraid path with generic Docker Compose instructions that work on any Docker host, and labels every Unraid-UI-specific step as "unverified — check against your Unraid version" until a research note exists. Planning must not invent plugin names, menu paths or default paths.
- **U2 — Facebook Page posting rate limit.** No per-Page publish limit is in `docs/research/meta.md`. The audit records "no documented per-Page limit found; NEEDS RESEARCH" and keeps whatever account-level limit the engine already applies, rather than inventing a number.
- **U3 — Bluesky rate limits are approximate** (the research page did not load). The audit records them as approximate; enforcement uses the documented figures as the ceiling.

## Decisions made while specifying

Each is a judgement call. It will be appended to `docs/decisions.md` and can be reversed.

- **"Mark not published" requeues by default.** An ambiguous target marked not published goes back to its account's queue at the next free posting slot, through the same slot-allocation function the composer uses. If the account has no free slot (no slots, all paused, or none within the queue horizon), the target becomes `failed` with "Not published — no free posting slot; retry or schedule it", so it stays on the failures view and can be retried or rescheduled. The person resolving may instead choose "Mark not published, don't requeue", which records it as failed (today's "Mark failed"). *Why:* the brief's ask is "mark not published and requeue", and a missed post should be one click from going out. *Reverse:* make the no-requeue choice the default.
- **Retry keeps today's meaning.** Retry on a failed target re-arms it to publish as soon as possible (at the next tick), as `retryTarget` does now. It does not take a slot. *Reverse:* make retry use the next free slot.
- **Who may resolve and retry.** Anyone who may schedule posts in the project (owner, admin, editor) may retry and resolve, matching the existing post-detail actions. Every member may view the failures view. *Reverse:* restrict the actions to owners and admins in the access statements.
- **External URLs must be `http` or `https`.** "Mark published" accepts an optional URL only with an `http`/`https` scheme and no embedded credentials, everywhere it is accepted (failures view, post detail). Other schemes (`javascript:`, `data:`, …) are refused with a field error. *Why:* the URL is rendered as a link (003 F15). *Reverse:* none wanted.
- **Ambiguous targets are counted in the project navigation.** The Failures nav item shows the number of ambiguous targets (they need a human decision), and the failed count separately on the page. *Reverse:* remove the badge.
- **Webhook destination rule.** Webhook URLs keep allowing `http` and private-network addresses (the owner's n8n runs on the same home server, 009), but always refuse loopback, link-local (which includes cloud metadata addresses), unspecified and the IPv6 edge ranges added to the shared address policy (FR-026), both when saved and at every delivery after DNS resolution. *Why:* private LAN targets are a real self-hosting need; loopback and metadata endpoints never are. *Reverse:* allow loopback in the shared webhook validation.
- **Startup validation strictness.** A required variable that is missing, any variable that is set but malformed, and any optional group that is only partly set (for example a storage group missing its secret key, or an LLM provider named without its key) stop the process at startup with a message naming each variable and what is wrong. A wholly absent optional group disables its feature and logs one line saying which feature is off. *This reverses 007 generic change 6* ("startup logs LLM problems and never fails") for the partly-set and malformed cases only; a wholly absent LLM configuration still only logs. *Reverse:* restore the log-only LLM check.
- **Security response headers apply to every response**, with the strict-transport header sent only when the app's configured public URL is `https`, so a local `http://localhost` run is not pinned to HTTPS in the browser. *Reverse:* send it unconditionally.
- **The clean-checkout verification is scripted.** The exact steps run are written into `docs/deployment.md` as a numbered list and also captured in a small smoke script that drives the mock flow against a running stack, so anyone can repeat them. The script is not added to CI (a Compose run in CI is heavy and Docker image build already runs there). *Reverse:* add a CI job that runs the script.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See and resolve every post that did not go out (Priority: P1)

An owner gets the feeling a post didn't land. They open **Failures** in the project navigation, which shows "2" beside it. The page lists every target in the project that is `ambiguous` or `failed`, newest first, with ambiguous ones grouped at the top under "Needs your decision". Each row shows the account, a short excerpt of the post text, when it was meant to go out, the last error in plain language, the attempt count and a link to the post. Expanding a row shows the full attempt log for that target: every step, outcome, summary of what was sent and received, and time.

For an ambiguous Instagram target the owner checks Instagram, sees the post is there, chooses **Mark published**, pastes the post's address and confirms. For another ambiguous target the post is not on the platform, so they choose **Mark not published and requeue**; Docket shows the slot it will take ("Thu 9 Oct, 09:00") before confirming. For a failed Bluesky target whose error was a temporary outage, they choose **Retry**.

**Why this priority**: The scheduler's core safety rule (a missed post beats a duplicate) only works if someone can see and resolve the misses. Today ambiguous and failed targets are only discoverable post by post.

**Independent Test**: With the mock provider, create three posts whose targets end `ambiguous`, `failed` (retryable exhausted) and `failed` (fatal). Open `/p/<slug>/failures`: all three appear with their attempt logs; the nav badge shows 1. Resolve the ambiguous one as published with a URL; it leaves the list and the post detail shows it published with that link. Retry one failed target; the next tick publishes it. Confirm a member of another project gets "not found" for the page and for every action.

**Acceptance Scenarios**:

1. **Given** a project with ambiguous and failed targets across several posts and accounts, **When** any member opens the failures view, **Then** every ambiguous and failed target of the project appears exactly once, ambiguous ones first under "Needs your decision", then failed ones, each group newest first, with account, post excerpt, intended time in the project's time zone, last error, attempt count and a link to the post.
2. **Given** a listed target, **When** the member expands it, **Then** the full attempt log for that target is shown in time order (each step, outcome, request and response summaries, time, and who acted for user actions), and no credential, token or secret appears in it.
3. **Given** an ambiguous target, **When** a member who may schedule chooses Mark published, optionally enters an `https://` address and confirms, **Then** the target becomes published at the time of the decision with that address as its link, a `resolved_published` attempt naming the member is appended, the post's derived status is recalculated, the same webhook event fires as for an automatic publish, and the row leaves the list.
4. **Given** an ambiguous target on an account with free posting slots, **When** the member chooses Mark not published and requeue, **Then** the dialog shows the slot the target will take before confirming, and on confirm the target is scheduled into that slot (the occurrence is taken with the same guarantee as Add to queue), a resolution attempt and a requeue attempt are appended, and the row leaves the list.
5. **Given** an ambiguous target whose account has no free slot, **When** the member chooses Mark not published and requeue, **Then** the dialog says no slot is free and offers "Mark not published, don't requeue"; on confirm the target becomes `failed` with a message saying it was not published and how to retry or reschedule it, and it moves to the failed group.
6. **Given** a failed target on an active account, **When** the member chooses Retry, **Then** the target is re-armed to publish at the next tick, a `retry_requested` attempt is appended, and the row leaves the list (it reappears if the new attempt fails).
7. **Given** a failed target whose account needs reconnecting, was removed, or whose provider is no longer available, **When** the member views the row, **Then** Retry is not offered and the row says what to do instead ("Reconnect <account> to retry"); a forced request to the server is refused with the same message.
8. **Given** an editor, admin or owner, **When** they use any action, **Then** it succeeds; **given** a member without the schedule right or a non-member, **When** they call the action on the server directly, **Then** it is refused (non-members see "not found").
9. **Given** two members resolve the same ambiguous target at the same moment, **When** both confirm, **Then** exactly one resolution is applied and the other sees "This post was already resolved" with the current state; no slot is taken twice.
10. **Given** no ambiguous or failed targets, **When** a member opens the page, **Then** an empty state says nothing needs attention and links to the posts list.

---

### User Story 2 - Trust that platform limits are enforced before any platform call (Priority: P1)

The owner schedules a busy week across four platforms. They want certainty that Docket never sends a platform something it will reject or something that exceeds a posting limit — whether the post came from the composer, the generator, a job or the API, and even if the content or the platform's rules changed between scheduling and publishing.

**Why this priority**: A post that hits a platform limit fails at the worst moment (publish time), and an exceeded rate limit can get an account restricted. The brief requires limits to be enforced in our code before platform calls.

**Independent Test**: Read the limits inventory in the docs. For each row, run the named test: it builds content or an account history that violates exactly that limit, runs the publish path with mocked HTTP, and asserts that no platform request was made and that the target got the documented outcome (validation error before scheduling, or a deferral for rate limits).

**Acceptance Scenarios**:

1. **Given** the limits inventory, **When** the owner reads it, **Then** every shipped provider (Facebook, Instagram, Threads, Bluesky, and the mock) lists each limit it has — text length and counting rule, number of media items, bytes per item, allowed formats, dimensions and aspect ratio, alt-text length, whether media is required, and publish rate limits — with the value, its source (research note or "interim, unverified"), where it is enforced, and the test that proves it.
2. **Given** content that breaks any one listed content limit, **When** it is submitted through the composer, the generator, a job or the API, **Then** it is refused or sent to review with a message naming the limit, before any scheduling, through the one shared validation path.
3. **Given** a scheduled target whose content or media no longer passes validation at publish time (edited, media replaced, or capability changed), **When** the tick reaches it, **Then** no platform request is made and the target fails with a message naming the limit.
4. **Given** an account at its publish rate limit for the window, **When** another of its targets comes due, **Then** no platform request is made and the target is deferred to when the window allows it, as the engine already does; this holds for every provider with a documented rate limit.
5. **Given** a limit the audit finds unenforced or untested, **Then** it is enforced and tested in this feature, or — if the fact itself is unknown — recorded as NEEDS RESEARCH in the inventory, never silently skipped.

---

### User Story 3 - Know that secrets never leak (Priority: P1)

The repo is public and other people will self-host it. The owner wants proof — not a promise — that platform tokens, app passwords, API keys, webhook secrets and Docket's own secrets never appear in logs, API responses, rendered pages or the attempt log, and that the app resists the common web attacks for an internet-facing self-hosted service.

**Why this priority**: A leaked page token or app password compromises an account the owner cares about. A self-hosted app on the open internet will be probed.

**Independent Test**: Run the end-to-end mock flow test. It sets distinctive fake values for every secret, drives setup, project creation, account connection, posting, publishing, failure, resolution, an API key's use and a webhook delivery, then scans everything captured — log output, every API and route response body and header, rendered pages, attempt logs and webhook payloads — and fails if any secret value (or a recognisable encoding of it) appears.

**Acceptance Scenarios**:

1. **Given** distinctive fake values for every credential and secret the app holds, **When** the end-to-end mock flow runs, **Then** none of them appears in any captured output, and the test names the secret and where it appeared if one does.
2. **Given** a signed-in member's browser, **When** another site tries to make it submit any state-changing request to Docket, **Then** the request is refused without effect; this holds for every state-changing surface reachable with a session (server actions, session-authenticated route handlers and the auth endpoints).
3. **Given** the tick endpoint, **When** it is called without the secret, with a wrong secret, with the secret in the query string, or while no secret is configured, **Then** it refuses without running the tick and without revealing which case applied; a correct secret runs exactly one tick.
4. **Given** webhook endpoints, **When** a secret is created or rotated, **Then** it is shown once, stored encrypted, never returned by any later read, and every delivery is signed; a destination that resolves to loopback, link-local or another always-refused range is refused at save and at delivery.
5. **Given** any page or response, **When** it is served, **Then** it carries the agreed security headers (content type sniffing off, framing by other sites refused, a restrictive referrer policy, a content security policy that the app's own pages satisfy, and strict transport when the public URL is `https`).
6. **Given** the security pass, **When** it is finished, **Then** a findings record lists each area checked, what was found, and the fix or the reason it was accepted, and every fixed finding has a test.

---

### User Story 4 - Configure and start the app with confidence (Priority: P2)

A self-hoster copies `.env.example` to `.env`, fills it in and starts the stack. If they mistype or forget something, the app refuses to start and tells them exactly which variable is wrong and why, instead of starting and failing later at publish time.

**Why this priority**: Misconfiguration is the most common self-hosting failure, and a scheduler that starts but silently cannot publish is worse than one that refuses to start.

**Independent Test**: Run an automated check that compares every variable the code reads (core, provider-declared, storage, LLM, scheduler, worker) with `.env.example` and with the startup validation, and fails on any variable missing from either. Then start the app with each required variable removed in turn, and with a malformed value for each validated variable, and confirm it exits before serving or migrating, naming the variable.

**Acceptance Scenarios**:

1. **Given** the codebase, **When** the coverage check runs, **Then** every environment variable the app or worker reads appears in `.env.example` with a description, whether it is required, its default, and an example, grouped by feature; and every one is covered by startup validation.
2. **Given** a missing required variable, a malformed value, or a partly-set optional group, **When** the web process or the worker starts, **Then** it stops before running migrations or accepting requests, printing every problem at once, each naming the variable and the reason, and never printing a secret value.
3. **Given** a wholly absent optional group (storage, LLM, a provider's app credentials), **When** the app starts, **Then** it starts, logs one line per disabled feature, and the UI shows that feature as not configured.
4. **Given** an empty value such as `DATABASE_URL_DIRECT=`, **When** startup and the migrator read it, **Then** both treat it the same way (as unset).

---

### User Story 5 - Deploy Docket on my own hardware or a host, following honest docs (Priority: P2)

The owner wants to run Docket locally first, then on their Unraid server with Docker Compose, and someone else wants to put it on a container host with Neon. Each reads `docs/deployment.md` and gets the steps, the trade-offs, and the things that will silently break (a sleeping host stops the scheduler; a private bucket breaks Instagram and Threads).

**Why this priority**: Without a working, honest deployment guide the app cannot be used for real, and the repo is meant for others to self-host.

**Independent Test**: From a clean checkout on a machine with Docker, follow the "Local Docker Compose" section of `docs/deployment.md` exactly. Reach a working app, create the first user, create a project, connect a mock account, publish a post now, and see it published by the worker, with the "last successful tick" indicator current. Then follow the backup and restore steps and confirm the restored database has the post.

**Acceptance Scenarios**:

1. **Given** a clean checkout and Docker, **When** someone follows the local Docker Compose section step by step, **Then** they reach a working app and publish a post with the mock provider, and the section lists the exact commands that were run to verify it, with the date.
2. **Given** the Unraid section, **When** the owner reads it, **Then** it covers installing the Compose stack, where persistent data lives (database volume, `.env`), backups and restores, a reverse proxy with HTTPS in front of the web service, keeping the worker running, and the requirement for a publicly reachable media bucket; Unraid-UI-specific steps that are not in research are labelled unverified (U1).
3. **Given** the container host plus Neon section, **When** a reader follows it, **Then** it explains the pooled and direct connection strings and which one migrations use, running the scheduler as a second service from the same image or by an external cron calling the tick endpoint with the secret, the in-process worker option for single-service hosts, and how to confirm ticks are happening.
4. **Given** the Render section, **When** a reader reads it, **Then** it states plainly that free web services spin down after 15 minutes without traffic, the free tier has no background workers or cron jobs, and free Postgres expires after 30 days; so the free tier only works with an external cron hitting the tick endpoint every minute, which is fragile, and recommends a paid always-on service or another host for real use.
5. **Given** any deployment, **When** the scheduler stops, **Then** the docs tell the reader where the stale-tick warning appears and what to check.
6. **Given** a Netlify reader, **Then** the docs say Netlify is not supported and why, without instructions.

---

### User Story 6 - Understand and extend the project from its docs (Priority: P3)

A developer finds the public repo. The README tells them what Docket does, how to try it in minutes, how to configure it, how it is built, and how to add a provider; `docs/adding-a-provider.md` matches the code they will actually write against.

**Why this priority**: Important for an open-source repo and for the owner's future self, but it does not change runtime behaviour.

**Independent Test**: A reviewer follows the README quick start and the provider guide against the current code and finds no instruction, type name, member or file path that does not exist or behaves differently.

**Acceptance Scenarios**:

1. **Given** the README, **When** a reader opens it, **Then** it has, in order: what Docket is and its features, a quick start (Compose with the mock provider), configuration (pointing to `.env.example` and the feature groups), an architecture overview (web, worker, database, bucket; service layer; scoped data access; provider framework; tick and its triggers), links to deployment, provider, storage, Meta setup and n8n docs, adding a provider, testing and contributing.
2. **Given** `docs/adding-a-provider.md`, **When** compared with the provider contract in the code, **Then** every member of the contract (required and optional, including the generic additions G1–G13) is described with when to use it, the contradictions found by 004's review are gone, and it notes the refresh-hold interaction recorded by 006's review.
3. **Given** the README and docs, **Then** they assume no particular owner infrastructure (public repo), and every command shown has been run or is marked as not run.

### Edge Cases

- A target is resolved or retried on the failures view at the moment the tick is working on it: the action is refused with "Publishing in progress" (a failed or ambiguous target is never claimed by the tick, so this only arises if its status changed meanwhile, which the action re-reads under lock).
- The account of an ambiguous target was removed: Mark published and Mark not published (without requeue) are still allowed, because they record what happened; requeue and Retry are not offered.
- The post of a failed target was soft-deleted: the target does not appear (deletion is refused while a target is ambiguous, so ambiguous targets always have a live post).
- A failed target retried from the failures view fails again: it reappears with the new attempts appended to the same log; nothing is lost.
- A very long attempt log (a polling step repeated many times): the expanded log shows all entries, with repeated identical polling entries collapsible but still countable; nothing is dropped.
- A project with hundreds of failed targets: the list is paginated; filters by status and account; the nav badge counts ambiguous targets only.
- Mark published URL with a fragment, query or non-ASCII host: accepted if the scheme is `http`/`https` and it has no embedded credentials; displayed as text-safe link.
- Requeue when the next free slot is taken by a concurrent queue operation: the slot guarantee picks the next free one or reports none, never a double booking.
- A limit value changes in a provider's capabilities after posts were scheduled: publish-time validation catches it and fails the target before any platform call (User Story 2 scenario 3).
- An engine-side failure before the provider is called (credential decryption fails, content cannot be loaded, settings do not parse) on a step that may publish: the target fails (nothing was sent), it is not recorded as ambiguous (002 F21).
- A request body sent chunked without a length and larger than the limit: rejected once the limit is crossed, without reading the rest into memory (009 N15).
- A webhook or media-by-URL destination whose name resolves to an always-refused address only after the first check (DNS rebinding): refused at connection time.
- `TICK_SECRET` unset while the external-cron trigger is the only scheduler: the endpoint refuses every call and the stale-tick warning appears; the docs say so.
- Startup with a malformed variable in the worker only (shared `.env`): the worker exits with the same message the web process would give.
- The clean-checkout run happens on a machine behind a TLS-intercepting proxy: the docs point to the existing optional build secret for an extra CA (decision 12) and say it is not needed elsewhere.
- Docker is not available in the environment where the implementation runs: the verification is reported as not run (constitution II), with the steps ready for the owner, rather than claimed.

## Requirements *(mandatory)*

### Functional Requirements

**Failures view**

- **FR-001**: The project MUST have a failures view at `/p/[projectSlug]/failures`, linked from the project navigation, listing every `ambiguous` and every `failed` target of the project (excluding targets of soft-deleted posts), ambiguous first under "Needs your decision", each group newest first.
- **FR-002**: Each row MUST show the account (name and platform), a post excerpt, the intended time in the project's time zone, how it was scheduled (slot, explicit, now), the last error in plain language, the attempt count, and a link to the post detail.
- **FR-003**: Each row MUST expand to the target's full attempt log in time order: step, outcome, request and response summaries, time, and the acting member or API key for user actions. Nothing is truncated away; long runs of identical polling entries may be collapsed behind a count.
- **FR-004**: The view MUST be filterable by status (ambiguous, failed, both) and by account, and paginated; filters and page are kept in the address so the view can be linked and reloaded.
- **FR-005**: The navigation MUST show the number of ambiguous targets in the project next to Failures when it is above zero, without loading the list itself on every page (007 review F6 showed the cost of doing so).
- **FR-006**: The view MUST read only through the scoped data-access layer and services; a member of another project, or a non-member, MUST see "not found".
- **FR-007**: For an ambiguous target, a member with the schedule right MUST be able to **Mark published** with an optional external address. The address MUST be `http` or `https` with no embedded credentials; any other value is refused with a field error. This rule MUST apply wherever "Mark published" exists (failures view and post detail).
- **FR-008**: For an ambiguous target, a member with the schedule right MUST be able to **Mark not published and requeue**: the dialog previews the next free slot for the target's account; on confirm the target is placed in that occurrence through the shared slot-allocation function (with its database-backed uniqueness), and attempts recording the resolution and the requeue are appended. If no slot is free, the dialog says so and offers **Mark not published, don't requeue**, which makes the target `failed` with a message saying how to retry or reschedule.
- **FR-009**: For a failed target on an active account with an available provider, a member with the schedule right MUST be able to **Retry**, using the existing retry service (re-armed for the next tick, attempt count reset, `retry_requested` appended). Retry MUST NOT be offered — and the server MUST refuse it with an actionable message — when the account needs reconnecting, was removed, or its provider is unavailable.
- **FR-010**: Every resolution and retry MUST be applied atomically together with a re-check of the target's current status, so concurrent actions apply at most once and the loser gets a clear "already resolved" or "no longer failed" message; the post's derived status MUST be recalculated and the same webhook events MUST fire as for the equivalent automatic outcome.
- **FR-011**: The post detail page MUST show each target's attempt count (003 F9) and offer the same resolution choices as the failures view, calling the same services.
- **FR-012**: An engine-side failure that happens before the provider is called (credentials cannot be decrypted, content or settings cannot be loaded) MUST fail the target rather than mark it ambiguous, because nothing was sent (002 F21). A failure after the provider call started on a may-publish step keeps today's ambiguous rule.
- **FR-013**: The view MUST follow the `docket-ui` conventions: keyboard operable (rows, expanders, dialogs), visible focus, labelled controls, announced results, sensible empty, loading and error states.

**Provider limits audit**

- **FR-014**: The project MUST include a limits inventory (a document under `docs/`) listing, for every shipped provider, each limit in these categories: text length and counting rule; media count (including carousel minimums); bytes per item; allowed formats; dimensions and aspect ratio; alt-text length; media required or text-only allowed; publish rate limits per account and window; and any login/session rate limit relevant to our calls. Each entry gives the value, its source (research file, or "interim, UNVERIFIED" with the decision number), where it is enforced, and the test that proves enforcement.
- **FR-015**: Every content limit in the inventory MUST be enforced by the one shared validation path before scheduling, for every caller (composer, generator, jobs, API), and again at publish time before any platform request.
- **FR-016**: Every publish rate limit in the inventory MUST be enforced by the engine before any platform request, deferring the target until the window allows it, with no attempt counted and no platform call.
- **FR-017**: Every inventory entry MUST have at least one test, using mocked HTTP only, that violates exactly that limit and asserts no platform request was made and the documented outcome occurred. Gaps found by the audit MUST be fixed and tested in this feature.
- **FR-018**: Limits whose facts are not in research MUST be recorded as NEEDS RESEARCH in the inventory (U2, U3), not invented; the inventory MUST state which values are verified, approximate or interim.
- **FR-019**: Bluesky sessions MUST be reused and refreshed rather than created per post (the `createSession` limit), and the inventory MUST cite the test that proves a publish does not create a session.

**Security pass**

- **FR-020**: An end-to-end test using the mock provider MUST set distinctive fake values for every secret the app holds — platform tokens and app passwords (encrypted credentials), API key plaintexts, webhook secrets, invitation tokens, session tokens, the auth secret, the credentials encryption key, the tick secret, storage keys and LLM keys — drive setup, project creation, account connection, compose, publish, failure, resolution, API key use and webhook delivery, and capture all log output (web and worker), every response body and header from API and route handlers, rendered pages, attempt logs and webhook payloads. It MUST fail if any secret value, or its base64 or URL-encoded form, appears anywhere it is not meant to (the one-time display of a newly created API key or webhook secret to its creator is the only allowed appearance, and is asserted separately).
- **FR-021**: Every state-changing request that a browser session can authenticate (server actions, session-authenticated route handlers, auth endpoints) MUST be refused when it comes from another origin. The security findings MUST list each such surface and how it is protected, with a test per surface type proving a cross-origin request has no effect.
- **FR-022**: The tick endpoint MUST refuse (with one indistinguishable response) a missing secret, a wrong secret, a secret passed in the query string, and any call when no secret is configured; it MUST compare in constant time and never log the presented value. A test MUST cover each case.
- **FR-023**: Webhook secrets MUST be shown once at creation and rotation, stored encrypted, absent from every later read, response, log and page, and every delivery MUST be signed. Webhook destinations MUST be refused, at save time and at delivery after resolution, when they resolve to loopback, link-local, unspecified or other always-refused ranges, while `http` and private-network addresses stay allowed (decision above).
- **FR-024**: Every response MUST carry security headers: no content-type sniffing; framing by other origins refused; a restrictive referrer policy (the sign-up page keeps `no-referrer`); a content security policy that the app's pages satisfy without console violations in the shipped screens; and strict transport security only when the configured public URL is `https`. A test MUST assert the headers on a page, an API response and the health endpoint.
- **FR-025**: Request bodies MUST be bounded while being read: a body without a declared length (chunked) MUST be rejected as soon as it crosses the limit, without buffering the rest (009 N15).
- **FR-026**: The shared outbound address policy (media by URL and webhooks) MUST also refuse the IPv6 6to4, Teredo and documentation ranges and any IPv4-mapped form of a refused IPv4 address, and MUST check the resolved address at connection time so a name that changes its answer cannot bypass the check.
- **FR-027**: Every audit-log write path MUST refuse secret-looking detail keys (token, url, password, secret), not only the shared helper (001 F4).
- **FR-028**: The security pass MUST produce a findings record (in `docs/`) listing each area checked — secrets in logs/responses/UI/attempt logs/errors, CSRF, tick secret, webhook secrets and destinations, headers, request size, outbound fetches, session cookie attributes, rate limits on sign-in, error messages that could reveal existence of other projects — with the finding, the fix or the accepted reason, and the test. Every finding rated as fixable within this feature's scope MUST be fixed.

**Configuration and startup**

- **FR-029**: An automated check MUST fail if any environment variable read anywhere in the app, worker, scripts used at runtime, providers or Compose file is missing from `.env.example` or from startup validation.
- **FR-030**: `.env.example` MUST document every variable, grouped by feature (core, auth, scheduler, storage, LLM, each provider, API/webhooks, Compose-only), with description, required or optional, default, and a safe example value; it MUST NOT contain a real-looking secret.
- **FR-031**: Startup validation MUST run before migrations in every entry point (web, worker, pre-start migrator) (001 F7) and MUST stop the process on a missing required variable, a malformed value or a partly-set optional group, listing every problem at once by variable name and reason, without printing secret values.
- **FR-032**: A wholly absent optional group MUST disable its feature, log one line naming the disabled feature, and leave the rest of the app working.
- **FR-033**: Empty values MUST be treated as unset consistently by every reader of the same variable (001 F12).

**Deployment and verification**

- **FR-034**: `docs/deployment.md` MUST cover, honestly and without assuming the owner's infrastructure: (a) local Docker Compose; (b) Unraid with Docker Compose — the stack, persistent data (database volume and `.env`), backups and restore, a reverse proxy with HTTPS, keeping the worker running, and the publicly reachable media bucket requirement for Instagram and Threads; (c) a container host plus Neon — pooled vs direct URL and which migrations use, the scheduler as a second service from the same image or an external cron calling the tick endpoint with the secret, and the in-process worker option; (d) Render free-tier trade-offs exactly as the owner checked them (15-minute spin-down, no background workers or cron, Postgres expiry after 30 days, so only an every-minute external cron works and it is fragile); (e) how to confirm the scheduler is ticking and what the stale-tick warning means; (f) a statement that Netlify is not supported.
- **FR-035**: The backup section MUST give a database backup command and a restore procedure that were run against the Compose stack during this feature (or are marked not run), and state what else must be kept (the `.env`, especially the credentials encryption key, without which stored account credentials cannot be decrypted; the media bucket is separate).
- **FR-036**: The reverse-proxy section MUST state the settings Docket depends on: the public URL variable matching the external `https` address, the trusted proxy/IP headers settings (001 decision 22), the upload body size the proxy must allow, and that the web port should not be published directly to the internet.
- **FR-037**: `docker compose up` MUST be verified from a clean checkout (a fresh clone or equivalent with no local build artefacts or volumes) end to end with the mock provider: copy and fill `.env`, start the stack, create the first user, create a project, connect a mock account, publish now, see the worker publish it, see the last-tick indicator current. The exact commands and their observed results, with the date, MUST be recorded in `docs/deployment.md`, and the same steps MUST be repeatable through a smoke script. If Docker cannot be run where the implementation runs, this MUST be reported as not verified, not claimed.
- **FR-038**: The Compose file and docs MUST make the mock provider's production default explicit (it is off when `NODE_ENV=production`, which the image sets), saying how to enable it for the local walkthrough and to leave it off for real use.

**README and provider guide**

- **FR-039**: The README MUST be revised to cover, in order: features, quick start, configuration, architecture overview, links to the other docs, adding a provider, testing and contributing; sections superseded by `docs/deployment.md` MUST link there rather than duplicate it.
- **FR-040**: `docs/adding-a-provider.md` MUST be refreshed against the final provider contract: every required and optional member (including G1–G13), capabilities and counting rules, connect strategies, step machine and results, limits (with a pointer to the inventory), refresh and `needs_reauth` (including the 006 F7 refresh-hold note), the no-secrets rule, testing with mocked HTTP, and the worked examples; every contradiction recorded by 004 F5 MUST be resolved. A test MUST fail if a member of the provider contract is not mentioned in the guide.

**Process**

- **FR-041**: Every judgement call made while building MUST be appended to `docs/decisions.md` under a "010 — Hardening" heading, including the decisions above.
- **FR-042**: No new runtime dependency or infrastructure is added unless justified in the plan and logged (constitution VI).

### Key Entities *(include if feature involves data)*

- **Post target** (existing): the per-account publication with status (`ambiguous`, `failed`, …), last error, attempt count, external id and link, who resolved it and when. This feature adds no new statuses; "not published" resolves to `scheduled` (requeued) or `failed`.
- **Publish attempt** (existing, append-only): one entry per provider call or user action on a target. New user-action outcomes for "resolved not published" and "requeued" may be added; existing entries are never changed.
- **Limits inventory entry** (document, not data): provider, limit category, value, source and verification status, enforcement point, proving test.
- **Security finding** (document, not data): area, finding, severity, fix or accepted reason, proving test.
- **Environment variable** (document plus validation): name, feature group, required/optional, default, validation rule, example.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From the project home, a member reaches the full list of posts needing attention in one click and resolves an ambiguous target in under 30 seconds (open, expand, choose, confirm).
- **SC-002**: 100% of ambiguous and failed targets in a project appear on the failures view, and 0 targets of other projects do (tested with seeded data across two projects).
- **SC-003**: Under 20 parallel attempts to resolve or requeue the same ambiguous target, exactly one succeeds and no posting slot occurrence is ever held twice.
- **SC-004**: 100% of entries in the limits inventory have a passing test proving no platform request is made when the limit is violated; 0 limits are listed as "unenforced".
- **SC-005**: The end-to-end secret scan finds 0 occurrences of any of the seeded secrets across all captured logs, responses, pages, attempt logs and webhook payloads, and the test demonstrably fails when a secret is deliberately logged.
- **SC-006**: 100% of state-changing surfaces reachable with a session refuse a cross-origin request in tests.
- **SC-007**: 100% of environment variables read by the code are documented in `.env.example` and covered by startup validation, enforced by an automated check; starting with any one required variable removed exits before migrations in 100% of cases, naming it.
- **SC-008**: A person following the local Docker Compose section from a clean checkout reaches a published mock post in under 15 minutes of hands-on time, using only the documented commands.
- **SC-009**: A database backup taken with the documented command and restored with the documented procedure contains the posts created before the backup.
- **SC-010**: A reviewer comparing `docs/adding-a-provider.md` and the README with the code finds 0 references to members, files or commands that do not exist; the guide-coverage test passes.
- **SC-011**: Every finding in the security findings record is either fixed with a test or has a written acceptance reason; 0 are left open without one.

## Assumptions

- The provider framework, scheduler, services and existing UI from entries 001–009 are complete; this entry changes them only where a requirement above says so, and logs each change as a generic change.
- "Requeue" means the next free posting slot of the target's own account, using the existing queue horizon and slot rules; retry means "as soon as possible", as today.
- The failures view covers publish targets only. Failed generation job items keep their existing place on the job screens.
- The remaining MINOR findings from earlier reviews that are not named in "Context and sources" stay recorded in those reviews and are out of scope here.
- Live platform verification (real Meta and Bluesky accounts) stays owed by the owner; everything in this feature is verified with mocks or locally, and reported that way (constitution II).
- The local Docker walkthrough uses text-only posts with the mock provider, so no bucket is needed; the optional offline MinIO profile may be shown for an image post but is not required for verification.
- The owner's laptop sits behind a TLS-intercepting proxy; the existing optional build secret for an extra CA covers Docker builds there and is documented as machine-specific.
- Unraid-specific UI steps are unverified until a research note exists (U1); the generic Compose steps are verified on the local machine.
- Out of scope: new platforms, video, stories, reels, analytics, billing, a Netlify adapter or Netlify instructions, public sign-up, email delivery, image generation, CI changes beyond any new checks this feature's tests need.
