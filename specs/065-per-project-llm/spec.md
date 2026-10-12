# Feature Specification: Per-project LLM — a project can bring its own model and API key

**Feature Branch**: `065-per-project-llm`

**Created**: 2026-10-12

**Status**: Draft

**Input**: User description: "Before specifying, read .specify/roadmaps/llm-credentials.md in full — in particular its preamble (goal paragraph and the 'Behaviour on main that every entry builds on' bullets, especially the provider layer / parseLlmConfig in src/server/llm/config.ts:37 and its env vars, the env-only secrets invariant quoted from docs/generator.md, and the social-account encrypt-at-rest pattern under CREDENTIALS_ENCRYPTION_KEY), the 'Rules for every entry' list (which carries extra obligations aimed specifically at this entry), and this entry's own section '2. per-project-llm'. Also read docs/generator.md ('Configuring a provider', 'Jobs') and docs/security.md in full, as the roadmap preamble requires of every entry.

Purpose as the author states it: so a project willing to spend its own tokens can choose a more capable model than the install's default. Per-project provider, model and API key, resolved as project override falls back to the env default, so an install that sets only env vars behaves exactly as it does today.

Build: encrypted-at-rest storage reusing the CREDENTIALS_ENCRYPTION_KEY pattern that social account credentials already use; a project settings surface restricted to owner and admin for editing; a per-project equivalent of `pnpm llm:check` so someone can validate a key before trusting it with a 500-item job; redaction everywhere a key could surface. Extend entry 1's hold to per-project credential scope — one project running dry must not hold another's jobs.

Documentation obligations the author attaches to this entry specifically: it reverses the env-only key invariant that docs/generator.md states ('Keys are read from the environment only and never stored, logged or rendered'). Record that reversal in docs/decisions.md next to the generator decisions, update docs/generator.md, and say what happens to installs that only ever used env vars.

Testing/safety requirement: no secret may reach a log, a response or the UI. Both OPENAI_API_KEY and ANTHROPIC_API_KEY are already named in the secret-scan regression suite (tests/integration/security/secret-scan.test.ts, tests/integration/no-plaintext.test.ts); extend that suite to cover per-project stored keys rather than exempting anything from it.

Must leave the repo working and state what it does not do and which later entry owns it.

Does NOT: report spend or cost — entry 3 (llm-cost-visibility) owns that; add any provider beyond the existing `openai` and `anthropic`; or let a non-admin see or test a key."

## Context and sources

- Roadmap `.specify/roadmaps/llm-credentials.md`, entry **2 of 3**, slug `per-project-llm`. The roadmap's goal: "make Docket's LLM layer survive a provider refusing on billing, then let a project bring its own model and key and see what it spent." Docket is moving to Anthropic `claude-haiku-4-5` against a **shared monthly credit pool that other work also consumes**, which is exactly why a project that wants a more capable model should be able to spend its own credit instead.
- Entry 1 (`credit-hold`, `specs/043-llm-credit-hold`, `docs/decisions.md` § 045) has landed. It deliberately left the seam this entry widens: `credentialOwnerFor(projectId)` in `src/server/dal/credential-owners.ts` (today a constant `"install"`), the per-owner `llm_credit_holds` table, per-owner probe scheduling, and `generationCreditHold(scope)` in `src/server/services/jobs/read.ts`, which already asks about *this project's* owner.
- Entry 3 (`llm-cost-visibility`) comes after and owns everything about spend, tokens and cost. This entry must not report any of it.
- The spec directory number (065) follows the feature branch rather than `specs/`'s own highest (044): parallel branches cut from the same `main` have already collided on spec numbers once, which `docs/decisions.md` § 045 had to explain. The branch and the spec directory are kept aligned here on purpose.

### Behaviour on `main` that this feature builds on

Read from the roadmap preamble, `docs/generator.md` ("Configuring a provider", "Jobs"), `docs/security.md` and the code itself:

- **Configuration is environment-only.** `parseLlmConfig` (`src/server/llm/config.ts:37`) reads `LLM_PROVIDER` (`openai` | `anthropic`), `LLM_MODEL` (no default on purpose), `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`, `LLM_TIMEOUT_SECONDS` (10–600, default 90) and `LLM_MAX_OUTPUT_TOKENS` (256–32000, default 4000). It returns names and reasons for problems, never values. Generation is simply off when `LLM_PROVIDER` is unset; startup logs it and carries on. `getLlm()` / `getLlmStatus()` (`src/server/llm/index.ts`) are process-wide and cache the provider by its configuration.
- **Every caller already goes through the service layer.** The only places a provider's `generate` is called from a project context are `runGenerationStep` (`src/server/services/generation/core.ts`) and `planSeries` (`series.ts`), each wrapping the provider in `withCreditHold(llm, await credentialOwnerFor(projectId))`. The job runner passes `ctx.llm ?? getLlm()` (`src/server/services/jobs/runner.ts:294`). `createJob`, `getGenerationReadiness`, `getOverview`, `jobsRunnable` and the Batch jobs screens all consult `getLlmStatus()`.
- **Secrets are env-only today, and `docs/generator.md` says so**: "Keys are read from the environment only and never stored, logged or rendered." `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are both named in the secret-scan regression suite (`tests/integration/security/secret-scan.test.ts`, `tests/integration/no-plaintext.test.ts`), whose `docs/security.md` rows cover secrets in logs, in responses, in rendered UI, and in attempt and audit rows.
- **Encrypt-at-rest already exists.** `encryptSecret` / `decryptSecret` (`src/server/crypto/secrets.ts`) are AES-256-GCM with the key from `CREDENTIALS_ENCRYPTION_KEY` (32 bytes, hex or base64, required at startup), an embedded key id, and optional associated data; a key-id mismatch or tampering raises `SecretDecryptionError`. Social account credentials (`social_accounts.credentials_encrypted`) and webhook endpoint secrets use it, the latter with the endpoint as associated data.
- **Roles are a server-side access-control list.** `src/server/auth/access.ts` grants `api_key: ["manage"]` and `webhook: ["manage"]` to `owner` and `admin` only; `editor` has neither. `project: ["update"]` is also owner-and-admin, while `project: ["view"]` is every role.
- **The audit log is where settings changes go.** `membership_audit_log` is append-only, written only through `createAuditRepo(...).insert`, which refuses any details key matching `/token|url|password|secret/i` (`src/server/dal/audit.ts`). `account_posting_instructions_update` is the existing precedent for "a project setting changed, recorded with actor and before/after". `activity_events` is the publish-outcome log and is not involved.
- **The hold is already per owner.** `llm_credit_holds` (`src/server/db/schema/generation.ts`) is keyed by `owner` with `held_since`, `last_refusal_at` and `next_probe_at`, and records **no key, hash or prefix**. `gateCreditHolds` returns `{ held, probing }` per owner inside the claim transaction; `resolveBlockedProjectIds` (`src/server/dal/job-claims.ts:47`) already asks `credentialOwnerFor` about each candidate project and filters the claim by project; `CREDIT_PROBE_INTERVAL_MS` is a fixed 5 minutes, per owner row.
- **`pnpm llm:check`** (`scripts/llm-check.ts`) makes one sample call plus two job-shaped calls through `withCreditHold(getLlm(), INSTALL_CREDENTIAL_OWNER)` and prints `provider=… model=… outcome=… latency_ms=…`, `job_call …` and `jobs budget_ms=…`; it needs no database and tolerates having none.
- **Failure text is fixed per kind.** `src/server/llm/messages.ts` holds one sentence per `LlmFailureKind` (including `credit_exhausted`), `messages.test.ts` asserts the map is exhaustive, and SDK error text never reaches a user. The public API maps `credit_exhausted` to the existing 503 `generation_unavailable`.
- **Usage is captured but never persisted** (`LlmUsage`, `logLlmCall`) — entry 3's material, untouched here.

### Facts, and what is not verified

- No new runtime dependency and no new infrastructure is expected (constitution VI). One migration is expected: one new project-owned table and one new audit action value, with no change to either failure-kind pgEnum. No new environment variable.
- `CREDENTIALS_ENCRYPTION_KEY` is already required at startup, so no install becomes newly unbootable, and an install that has one and never sets a project key is unaffected.
- Model identifiers are not validated against any provider catalogue: the install's `LLM_MODEL` is deliberately unvalidated beyond shape ("a model id your account can use. There is no default on purpose"), and phases cannot reach the network. A per-project model is therefore shape-checked only, and the live check (FR-019) is how a person learns the model is real — which is the reason the author asks for it.
- The provider set is closed at `openai` and `anthropic` (constitution V governs *social* providers, not LLM ones; the roadmap closes this list explicitly).
- Everything live is verified with mocked HTTP only (constitution II). No test in this entry makes a real provider call.

## Decisions made while specifying

Judgement calls, for planning to record in `docs/decisions.md` as **K1–K16**, next to the generator decisions and entry 1's `C`/`H` sets.

### What a project may override

- **K1 — The override is one atomic credential: provider, model and key together, or nothing.** No field-by-field fallback. A model-only override would let a project spend the *install's* credit on a model the operator never chose, which inverts this entry's own purpose ("a project willing to spend its own tokens"); and a half-set override has no honest resolution. Resolution is therefore a choice between two complete configurations.
- **K2 — Timeout and output-token limits stay install-wide.** `LLM_TIMEOUT_SECONDS` and `LLM_MAX_OUTPUT_TOKENS` are operational safety limits tied to the tick budget (`SCHEDULER_TICK_BUDGET_SECONDS`, the 8 s minimum call and 3 s save reserve), not spend choices. A project that could raise its own timeout could stall the shared worker. Both apply unchanged to a project credential.
- **K3 — A project credential makes generation available for that project even when the install has none.** `LLM_PROVIDER` unset stops meaning "generation is off everywhere" and starts meaning "off for projects without their own credential". The startup line stays as it is (it describes the environment); readiness, overview, job creation and the Batch jobs screens become per-project answers.
- **K4 — Nothing changes for an env-only install.** No new setting, no new screen state, no change to prompts, calls, logging, timings or existing test expectations. The only visible addition is a settings section telling an owner or admin that this project uses the install default.

### Storage and secrecy

- **K5 — One project-owned row per project, with the key in a single encrypted column.** Stored through the scoped DAL like every other project-owned table (constitution III), encrypted with `encryptSecret` under `CREDENTIALS_ENCRYPTION_KEY`, with the project as associated data so a ciphertext lifted into another project's row fails to decrypt instead of quietly working.
- **K6 — Nothing but the ciphertext is kept.** No plaintext, hash, prefix, last-four, length or fingerprint — unlike `api_keys`, which keeps a hash and four characters because a caller must be *recognised* by the key they present. Here nothing ever needs to recognise the key, only to use it, so the cheapest safe choice is to keep nothing recognisable. This also keeps entry 1's "no credential value, and no fingerprint of one" rule (C8) intact for the hold table.
- **K7 — The key is write-only in every direction.** It is read only to make a provider call. It never appears in an action result, a page, a log line, an error message, an audit row, an API payload or a test snapshot, and the settings surface renders no fragment of it — the status is "a key is stored" or "no key is stored", plus who last changed it and when.
- **K8 — Leaving the key field blank keeps the stored key**, so the model can be changed without re-typing a key nobody can read back. Switching provider requires a key, because a key belongs to one provider.
- **K9 — A key that cannot be decrypted makes generation unavailable for that project; it never falls back to the install default.** If `CREDENTIALS_ENCRYPTION_KEY` is rotated or a row is tampered with, silently spending the install's credit on a project that chose to spend its own would be the wrong answer. The project is told, in a fixed sentence, that an owner or admin must re-enter the key; the stored row is left alone (nothing is destroyed on a read).
- **K10 — Provider error text is still never surfaced.** The fixed per-kind sentences in `src/server/llm/messages.ts` remain the only user-facing failure text, for the check too. No new failure kind and no new API error code are introduced.

### The surface and who may use it

- **K11 — A new permission statement for the credential, granted to owner and admin only.** Reusing `project: ["update"]` would be approximately right, but the author requires that a non-admin may not even *see* that a key exists, nor check one, and a dedicated statement makes that checkable in one place — the shape `api_key` and `webhook` already use. Editors do not see the section at all (spec 028's role-awareness convention: absent, not disabled), and the server refuses their actions whatever the UI shows.
- **K12 — Every set, change and removal is audited.** One new `membership_audit_log` action, with the actor, the provider and model before and after, and whether the key changed — never the key. The repository's details guard already refuses key names that look sensitive, and stays in force.
- **K13 — Removing the override is one explicit, confirmed action**, because it silently moves spend back onto the install's account. It deletes the stored key.

### Checking a credential before trusting it

- **K14 — One check service, two callers.** A single function performs the per-project check; both the settings surface and the command line call it (constitution IV). It makes one bounded live call with the project's resolved credential, saves nothing, and reports source (project or install default), provider, model, outcome and latency — the same vocabulary `pnpm llm:check` already prints, so an operator reading either output learns the same things. It never prints a key.
- **K15 — The check is serialised per project with a short cooldown**, so the control cannot be used to loop live calls against someone's account; and it runs through `withCreditHold`, so a billing refusal during a check sets that project's hold and any other outcome clears it — the rule entry 1 applies to every other path (C11).

### The hold

- **K16 — The credential owner becomes the credential, and a credential change clears that owner's hold at once.** A project with its own credential is its own owner; projects on the install default keep sharing the install owner, so an install-wide outage still holds them together. Saving, changing or removing a project's credential clears that project's hold immediately, so someone who has just fixed a key does not wait out a probe interval — entry 1 could not do this because it had no event to hang it on (a top-up is invisible, C8/C9); this entry does. Everything else about the hold — the 5-minute probe, single-flight probing, nothing failed or unreserved while held, no give-up timeout, no operator control to lift it — is unchanged, and simply now per owner.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A project brings its own model and key (Priority: P1)

A project's owner wants a more capable model than the install's shared default, and is willing to spend the project's own credit on it. In project settings they choose the provider, type the model id, paste the key and save. The next generation — single, series, "Try it", or a 500-item batch job — runs on that model, paid for by that key. Nothing about any other project changes.

**Why this priority**: It is the entry. Everything else exists to make it safe and legible.

**Independent Test**: Set a project credential through the settings surface with a stubbed provider per key, run one single generation and one job item in that project and one of each in a project without an override, and check that each call used the credential its own project resolves to.

**Acceptance Scenarios**:

1. **Given** an install with environment settings and a project with none, **When** anyone generates in that project, **Then** the install's provider, model and key are used — exactly as today.
2. **Given** a project with its own complete credential, **When** anyone generates in that project (single, series, regenerate, "Try it", a job item, or through the public API), **Then** the project's provider, model and key are used and the install's key is not.
3. **Given** a project credential saved a moment ago, **When** the next generation runs, **Then** it uses the new credential with no restart and no cached staleness.
4. **Given** an install where `LLM_PROVIDER` is unset and a project with its own credential, **When** someone opens that project, **Then** generation is available there; **and** in a project without a credential it is still reported as not configured, as today.
5. **Given** a project with its own credential, **When** an owner removes the override, **Then** the project reverts to the install default in one action and the stored key is gone.
6. **Given** a project credential, **When** a call is made with it, **Then** the install-wide timeout and output-token limits apply to it unchanged.

---

### User Story 2 - A key can be checked before a 500-item job (Priority: P1)

Before pointing a 500-item job at a newly pasted key, an admin runs the check on the settings surface. Within seconds they are told whether the key and model actually work — provider, model, outcome, how long it took — or which single thing went wrong. An operator with shell access but no login can run the same check for one project from the command line.

**Why this priority**: A wrong key or an unusable model discovered four hours into a batch job is exactly the waste this entry is meant to prevent, and the roadmap asks for this surface by name.

**Independent Test**: With the provider stubbed to succeed, then to refuse on auth, then to time out, run the check from the settings surface and from the command line for the same project and compare the reported outcome in each case.

**Acceptance Scenarios**:

1. **Given** a project with its own credential and a provider that answers, **When** an owner or admin runs the check, **Then** it reports success with the provider, the model, that the source was this project, and a latency — and saves no post.
2. **Given** a wrong key, **When** the check runs, **Then** it reports the single fixed sentence for that failure, naming no provider error text and no key.
3. **Given** a project with no credential, **When** the check runs, **Then** it checks the install default and says that is what it checked.
4. **Given** a check already running for a project, **When** a second is requested immediately, **Then** it is refused with a message saying to wait, and no second live call is made.
5. **Given** a provider that refuses on billing, **When** the check runs, **Then** the project's hold is set and the check reports the billing sentence; **and** when the provider then answers, a check clears the hold.
6. **Given** the command line, **When** the check is run for one named project, **Then** it prints the same fields in the existing `key=value` shape including which source it used, and exits non-zero on failure; **and** run with no project it behaves exactly as `pnpm llm:check` does today.

---

### User Story 3 - One project running dry does not hold another's jobs (Priority: P1)

Two projects each have jobs queued. One is on its own key and runs out of credit; the other is on the install default and funded. The dry project's items wait, unharmed. The funded project keeps generating at full rate. When the dry project's credit is restored — or its key replaced — its items resume on their own.

**Why this priority**: The roadmap states it as a requirement of this entry: "one project running dry must not hold another's jobs." Entry 1's hold is install-wide in effect until this lands.

**Independent Test**: Queue jobs in two projects with different credentials, stub one provider to refuse on billing, run ticks, and check that the funded project's throughput is unchanged while the dry project's items stay queued with no attempt counted and none failed.

**Acceptance Scenarios**:

1. **Given** two projects with different credentials and one refusing on billing, **When** ticks run, **Then** only the refusing project's jobs are skipped, and the other project's items are claimed and completed at the usual rate.
2. **Given** several projects on the install default and one of their calls refused on billing, **When** ticks run, **Then** all of them are held together, because they share one credential — and a project with its own working credential is not.
3. **Given** two projects both held on billing, **When** ticks run, **Then** each has its own probe schedule and one project's probe does not consume the other's.
4. **Given** a held project, **When** an owner saves a new key (or removes the override), **Then** that project's hold is gone and its items resume on the next tick, with no probe wait and no retry action.
5. **Given** a held project, **When** anyone opens the Batch jobs list or a job page in it, **Then** the notice says generation is paused because the model provider refused on billing, since when, that the waiting items have not failed and need no retry, and whose provider account needs credit — this project's own, or the install's.
6. **Given** a held project, **When** anyone opens Batch jobs in a *different*, funded project, **Then** no hold notice appears there.
7. **Given** a project with a credential, **When** the project is deleted, **Then** no credential row and no hold row for it remain.

---

### User Story 4 - A key never leaks, and only owners and admins can touch it (Priority: P1)

An editor opens project settings and sees nothing about keys at all. An admin sees the provider and model in use and that a key is stored, but no part of the key itself — and no screen, log line, response, audit row or database column anywhere carries its value.

**Why this priority**: This entry reverses the install's env-only key invariant. The reversal is only acceptable if the replacement is proven, and the author requires the proof to come from extending the existing scan rather than exempting anything from it.

**Independent Test**: Run the extended secret scan over a scanned run that stores a project key, renders the settings page for owner, admin and editor, runs a check, runs a tick that generates, and takes a billing refusal whose provider error body embeds that key; then dump every table and assert the key appears nowhere in any form.

**Acceptance Scenarios**:

1. **Given** a stored project key, **When** the settings surface is rendered for an owner or admin, **Then** it reports that a key is stored, who last changed it and when, and renders no character of the key.
2. **Given** an editor, **When** they open project settings, **Then** the credential section is absent; **and** when they submit the save, remove or check action directly, **Then** the server refuses it and nothing changes.
3. **Given** a provider whose error body embeds the configured key, **When** a generation fails in a project using a stored key, **Then** neither the log line, the action result, the stored failure row, the API response nor the screen contains the key, and the user-facing text is the one fixed sentence for that kind.
4. **Given** a scanned run that sets, changes and removes a project key, **When** every console line, response, rendered page, audit row and database row is scanned for that key in every form the suite already checks, **Then** there are no findings — and the scan is still provably able to fail on a deliberate leak.
5. **Given** a stored credential, **When** its row is read, **Then** the key column holds ciphertext only, and the plaintext key is not a substring of any column of any table.
6. **Given** a ciphertext copied into another project's row, **When** a generation is attempted there, **Then** it fails to decrypt and reports unavailable rather than making a call.
7. **Given** the install's encryption key has been rotated, **When** generation is attempted in a project with a stored key, **Then** that project reports that an owner or admin must re-enter the key, and the install's credential is **not** used instead.

---

### Edge Cases

- **An unknown or unusable model id.** Saving succeeds (shape only — there is no catalogue to check against), the check is how a person finds out, and a job item that hits it fails the way an unusable model already fails, with its fixed sentence.
- **Provider changed without a new key.** Refused at validation: a key belongs to one provider.
- **Whitespace or quotes pasted around a key.** Trimmed before storing, as `parseLlmConfig` already trims environment values; empty after trimming counts as "no key given".
- **Two admins save at once.** Last write wins and both writes are audited; the stored credential is whichever was saved last, never one admin's provider with another's key.
- **A job created before the credential changed.** Policies and instruction snapshots are pinned at creation, but the credential is not: items run on whatever the project resolves to when each item runs. The Batch jobs screens therefore always describe the credential in force now, not at creation.
- **A key removed while a job is queued.** The project falls back to the install default for its remaining items; if the install has no configuration, the items wait with the existing "generation is not configured" notice rather than failing.
- **A held project whose job is cancelled.** Unchanged from entry 1: cancelling works, and so does "Retry failed items".
- **The install has no environment configuration and the project's key is removed.** Generation becomes unavailable for that project, with the existing not-configured state — nothing fails and nothing is destroyed.
- **The check run while the project is held.** Allowed: it is the cheapest honest probe, and its outcome either clears the hold or confirms it.
- **A project credential for a provider the install never configured** (install on `openai`, project on `anthropic`). Supported: resolution is per project and complete, so no mixing is possible.
- **Very long or binary-ish key input.** Bounded by a documented maximum length and refused above it, with no part of the value in the message.

## Requirements *(mandatory)*

### Functional Requirements

**Resolution**

- **FR-001**: A project MUST be able to store its own generation credential as one unit: provider (one of the two existing providers), model id, and API key.
- **FR-002**: Every generation path for a project MUST resolve its credential as: the project's stored credential when it has a usable one, otherwise the install's environment configuration.
- **FR-003**: An install where no project has a credential MUST behave exactly as it does today: no new required setting, and no change to prompts, provider calls, log lines, screens, timings or existing test expectations.
- **FR-004**: The install-wide timeout and maximum-output-token limits MUST apply identically whichever source the credential came from, and a project MUST NOT be able to change them.
- **FR-005**: A project with its own credential MUST be able to generate even when the install has no environment configuration; a project without one in that install MUST report generation as not configured, exactly as today.
- **FR-006**: Resolution MUST happen in exactly one named place that every caller uses — single, series, regenerate, "Try it", the job runner, the public API, readiness, job creation, the Batch jobs screens and the check. No caller may read the environment or the stored credential directly.
- **FR-007**: A saved or removed credential MUST take effect for the next generation in that project without restarting any process.

**Storage and secrecy**

- **FR-008**: The stored key MUST be encrypted at rest with the same mechanism and the same `CREDENTIALS_ENCRYPTION_KEY` that social account credentials use, and MUST be bound to its project so a ciphertext moved to another project fails to decrypt rather than working.
- **FR-009**: Nothing recognisable about the key may be stored besides that ciphertext — no plaintext, hash, prefix, fragment or length.
- **FR-010**: The key value MUST NOT appear in any log line, console output, action result, server response, rendered page, error message, audit row, public API payload, test snapshot or database column other than its own encrypted column.
- **FR-011**: User-facing failure text MUST remain the existing fixed sentence per failure kind; no provider error text, and no part of any key, may be surfaced anywhere.
- **FR-012**: When a stored key cannot be decrypted, generation for that project MUST report itself unavailable with a fixed sentence telling the reader that an owner or admin must re-enter the key, MUST NOT fall back to the install's credential, and MUST NOT delete or rewrite the stored row.

**Surface and permissions**

- **FR-013**: Project settings MUST show which provider and model the project will use, whether that comes from the project or the install default, whether a key is stored, and who last changed it and when.
- **FR-014**: Viewing that section, saving, removing and running the check MUST be restricted to owner and admin, enforced on the server; editors MUST NOT see the section and MUST be refused if they invoke any of its actions directly.
- **FR-015**: The key input MUST be write-only: it never shows any part of a stored key, and submitting it blank MUST leave the stored key unchanged so the model can be changed on its own.
- **FR-016**: Saving MUST refuse an unknown provider, a missing or malformed model id, a missing key when none is stored, a key beyond a documented maximum length, and a provider change without a key — with field-level messages that quote no submitted value.
- **FR-017**: An owner or admin MUST be able to remove the override in one confirmed action, which deletes the stored key and returns the project to the install default.
- **FR-018**: Every set, change and removal MUST be written to the project's audit log with the actor, the provider and model before and after, and whether the key changed — and never the key.

**Checking a credential**

- **FR-019**: An owner or admin MUST be able to check the project's resolved credential from the settings surface: one bounded live call that saves no post, reporting either success with provider, model, source and latency, or exactly one fixed failure sentence.
- **FR-020**: The check MUST state which source it tested (this project's credential or the install default) and MUST NOT include any part of the key.
- **FR-021**: At most one check per project MUST be in flight at a time, with a documented minimum interval between checks, so the control cannot be used to loop live calls.
- **FR-022**: The same check MUST be runnable from the command line for a single named project without signing in, printing the same fields in the existing `key=value` shape and exiting non-zero on failure; run without a project it MUST behave exactly as `pnpm llm:check` does today.
- **FR-023**: A check refused on billing MUST set that project's credit hold, and a check with any other outcome MUST clear it — the same rule every other generation path follows.

**Hold scope**

- **FR-024**: The credit hold's owner MUST follow the credential: a project with its own credential is its own owner; projects on the install default share the install owner.
- **FR-025**: A held owner MUST hold only the jobs of projects that resolve to it. In the same tick, other projects' items MUST be claimed and run normally.
- **FR-026**: Each held owner MUST have its own independent probe schedule, and one owner's probe MUST NOT consume another's.
- **FR-027**: Saving, changing or removing a project's credential MUST clear that project's hold immediately, so its items resume on the next tick without waiting for a probe and without any retry action.
- **FR-028**: The Batch jobs notices MUST appear in a project only when that project's own resolved credential is held, MUST say since when and that waiting items have not failed and need no retry, and MUST say whose provider account needs credit — this project's own, or the install's.
- **FR-029**: Deleting a project MUST leave no credential row and no hold row behind for it.

**Tests and documentation**

- **FR-030**: The secret-scan regression suite MUST be extended to cover a stored project key end to end — set, changed and removed through the real surface; the settings page rendered for owner, admin and editor; a check; a tick that generates; and a billing refusal whose provider error body embeds that key — scanning console output, responses, rendered pages, audit rows and every database column, in every form the suite already checks, with nothing exempted; and the suite MUST remain provably able to fail on a deliberate leak.
- **FR-031**: `docs/generator.md` MUST replace the statement "Keys are read from the environment only and never stored, logged or rendered" with what is now true, describe the per-project override, how resolution works and the check, and keep the headings other documents link to; `docs/decisions.md` MUST record the reversal next to the generator decisions, stating explicitly that an install that only ever used environment variables needs to do nothing and behaves as before; `docs/security.md` MUST gain or update the rows covering the stored key and name the tests that prove them.
- **FR-032**: The feature MUST leave the repository working — every existing quality gate green — and its documentation MUST state what it does not do and which later entry owns each of those things.

### Key Entities

- **Project generation credential**: a project's own choice of provider, model and API key, stored as one unit with the key encrypted and bound to that project, plus who last changed it and when. At most one per project; its absence means "use the install default".
- **Resolved credential**: the provider, model, key and install-wide limits a given project's next call will use, together with its source (project or install default). The only thing any caller receives.
- **Credential owner**: the identity a credit hold is keyed by — a project with its own credential, or the install's environment credential shared by every project without one.
- **Credential check result**: source, provider, model, outcome and latency for one live call, carrying no key and no provider error text.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An install that sets only environment variables shows no observable change: every existing screen, call and timing is identical, no new setting is required, and the whole existing test suite passes unchanged.
- **SC-002**: An owner or admin can move a project onto its own provider, model and key in under 2 minutes from the project settings page, and the very next generation in that project uses it.
- **SC-003**: Someone can get a definite verdict on a newly entered key — works, or one named reason — in a single action and under 30 seconds, before committing a 500-item job.
- **SC-004**: Zero findings: no stored key value appears in any log line, response, rendered page, audit row or database column outside its own encrypted column, in any of the encodings the secret scan checks, while that scan remains provably able to fail on a deliberate leak.
- **SC-005**: An editor can neither see that a key exists nor change or check one: 100% of such attempts are refused by the server, whatever the UI shows.
- **SC-006**: With one project out of credit and another funded, the funded project's items keep completing at the install's normal rate (about 120 items an hour at the documented defaults) while the dry project's items wait with zero failures and zero attempts counted.
- **SC-007**: A project whose credential is fixed resumes with no human retry: on the next tick when the fix was a save, and within one probe interval (5 minutes) when the fix was a top-up.
- **SC-008**: A project whose stored key cannot be decrypted spends nothing: zero calls are made on the install's credential for it, and the reader is told what to do instead.
- **SC-009**: A reader of the updated documentation can answer, without reading code, where keys live, who may set one, how to check one, and what an environment-only install must do about this change (nothing).

## Assumptions

- The override is atomic (K1): there is no supported way to override only the model or only the key. Should a half-override later prove wanted, that is a new decision, not a gap in this one.
- `CREDENTIALS_ENCRYPTION_KEY` is already present on every install, because startup requires it today, so this feature adds no new deployment step.
- Model ids are shape-checked only; no provider catalogue is consulted (none is available offline, and the install's own `LLM_MODEL` is unvalidated for the same reason). The live check is the intended validation.
- Per-project credentials are a project setting, not a per-user one: everyone generating in the project spends the project's credential.
- The existing fixed per-kind sentences cover every outcome this entry can produce, so no new failure kind, no migration to either failure-kind enum, and no new public API error code is needed.
- The public API inherits resolution through the same service layer, so no public API contract changes; a caller's generation simply runs on whatever the project resolves to.
- Interactive generation stays unblocked by a hold (entry 1, C11): a person pressing Generate gets one honest sentence at once rather than a wait.
- Live provider behaviour is verified with mocked HTTP only; no test in this entry makes a real call.

## Out of scope — and who owns it

- **Reporting spend, cost or token usage, per project or at all** — roadmap entry 3, `llm-cost-visibility`. This entry stores a key and resolves it; it persists nothing about what a call consumed.
- **Any provider beyond `openai` and `anthropic`** — closed by the roadmap; nothing here opens it.
- **Letting a non-admin see, change or check a key** — explicitly excluded; editors see no credential section at all.
- **Budgets, caps or throttling on spend** — outside the roadmap entirely.
- **Per-project timeouts or output-token limits** (K2), and **per-user credentials** — no roadmap entry owns either; both would need a new decision.
- **Changing entry 1's hold mechanics** — the probe interval, single-flight probing, "nothing failed while held", the absence of a give-up timeout and the absence of an operator control to lift a hold all stay exactly as entry 1 specified them; only the owner's identity widens.
- **Notifying anyone that a project's credential failed** — the notifications roadmap owns attention events; the Batch jobs notices and the check are the only surfaces here.
- **Image generation credentials** — image generation is an extension point only on `main`, with no implementation or configuration.
- **Validating model ids against a provider catalogue**, and **retro-fitting anything onto generations already made** — neither is owned by any roadmap entry.
