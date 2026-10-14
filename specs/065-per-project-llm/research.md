# Research: Per-project LLM

**Feature**: `specs/065-per-project-llm` | **Branch**: `065-per-project-llm` | **Date**: 2026-10-12

Phase 0 of the plan. Two jobs: close every unknown the Technical Context would otherwise have to mark,
and record the plan decisions (**L1–L33**) that `docs/decisions.md` § 046 will carry next to the spec's
K1–K16 and entry 1's C/H sets.

## 1. Unknowns, and how each was closed

Pipeline phases cannot reach the web or the npm registry (constitution I, VI; `docs/decisions.md` #19).
Every fact below was read out of this repository or out of `node_modules`, at the path given.

| Question | Answer | Where it was read |
|---|---|---|
| Does the encrypt-at-rest helper support binding a ciphertext to a row? | Yes. `encryptSecret(plaintext, { aad })` / `decryptSecret(ciphertext, { aad })`, AES-256-GCM, 12-byte IV, 16-byte tag, an embedded key id, and a single `SecretDecryptionError` for shape, key-id mismatch, tamper and wrong AAD. The original error is deliberately dropped so it cannot carry key or ciphertext. | `src/server/crypto/secrets.ts` |
| Is `CREDENTIALS_ENCRYPTION_KEY` already mandatory? | Yes — a required Zod field, 32 bytes as base64 (44 chars) or hex (64 chars). No install becomes newly unbootable and there is no new deployment step. | `src/server/env.ts:315-319` |
| What does the hold key look like today? | `llm_credit_holds.owner` is a `text` primary key with a `length(owner) > 0` check and three `timestamptz` columns. No credential value, no fingerprint. `INSTALL_CREDENTIAL_OWNER = "install"`. | `src/server/db/schema/generation.ts:40-53`, `src/server/dal/credential-owners.ts` |
| Is the owner seam really a single function? | Yes, and it is already async "on purpose" for this entry. Its callers are `runGenerationStep` / `planSeries` (via `withCreditHold`), `generationCreditHold` and `resolveBlockedProjectIds`, which already asks it per candidate project rather than guessing all-or-nothing. | `src/server/dal/credential-owners.ts`, `src/server/dal/job-claims.ts:41-58` |
| Can a conditional upsert express "claim the check unless one is running or the cooldown has not passed"? | Yes. Drizzle 0.45's `onConflictDoUpdate` takes `setWhere` (and `targetWhere`); `src/server/dal/video-versions.ts:79` already uses `setWhere`. Zero returned rows is the refusal. | `node_modules/drizzle-orm/pg-core/query-builders/insert.d.ts:63-66`, `src/server/dal/video-versions.ts` |
| Which permission shape fits "owner and admin only, and an editor cannot even see it"? | A statement granted to `owner` and `admin` and omitted from `editor` — exactly `api_key: ["manage"]` and `webhook: ["manage"]`. `project: ["view"]` is every role, so it cannot express "invisible to an editor". | `src/server/auth/access.ts` |
| Where does "a project setting changed, with actor and before/after" already go? | `membership_audit_log`, written only through `createAuditRepo(...).insert`, whose `assertAuditDetailsSafe` refuses any details key matching `/token|url|password|secret/i`. `account_posting_instructions_update` is the precedent. | `src/server/dal/audit.ts`, `src/server/db/schema/audit.ts` |
| What does `pnpm llm:check` print today, and does it need a database? | `provider=… model=… outcome=… latency_ms=…`, then a `job_call kind=… outcome=… latency_ms=… window_ms=… fits=…` line per kind and a `jobs budget_ms=… reserve_ms=… max_items_per_tick=…` line. Unconfigured it prints the fixed `UNMEASURED_LINE` and exits 0. It needs no database, because `withCreditHold` swallows hold-write failures (H12/H13). | `scripts/llm-check.ts`, `src/server/services/generation/credit.ts` |
| How many places build a provider from the environment? | One: `getLlm()`, memoised on `JSON.stringify(config)`. `getLlmStatus()` answers the configured question without building one. Fourteen call sites in all, listed in §3. | `src/server/llm/index.ts`; a grep for `getLlm()` / `getLlmStatus()` |
| Is a migration needed to the failure-kind enums? | No. The undecryptable-key case is a resolution state, not an `LlmFailureKind` (L29), so neither `llm_failure_kind` nor `generation_job_item_error` is touched and `messages.test.ts`'s exhaustiveness assertion is unaffected. | `src/server/llm/types.ts`, `src/server/llm/messages.ts`, `src/server/db/schema/{generation,jobs}.ts` |
| Does a project deletion path exist to hang FR-029 on? | No. Nothing in `src/server` deletes a project (searched for `deleteProject` and `delete(projects)`). The credential row is covered by `ON DELETE CASCADE`; the hold row cannot be, because `owner` is a shared text key, so a housekeeping sweep is the honest answer (L28). | `src/server/dal/projects.ts`, `src/server/services/projects.ts` |
| What is the next migration number? | `0024`. The newest is `0023_chemical_elektra`, which is itself the "add an enum value, then create a table" shape this entry needs. | `drizzle/`, `drizzle/meta/_journal.json` |
| Does any existing test already guard where a provider key may be read? | Yes. `src/server/llm/key-reads.test.ts` walks `src/` and `scripts/` and fails if `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` is read anywhere but `src/server/llm/config.ts`. It is extended rather than relaxed (L31). | `src/server/llm/key-reads.test.ts` |

**NEEDS RESEARCH: none.** **NEEDS DEPENDENCY: none** — `@anthropic-ai/sdk`, `openai`, `drizzle-orm`,
`zod` and `node:crypto` are all already in `package.json`; this entry adds no runtime dependency and no
infrastructure.

**One fact deliberately not verifiable offline**, and the spec says so: a model id is not checked against
any provider catalogue. The install's own `LLM_MODEL` is unvalidated beyond shape for the same reason, and
FR-019's live check is the intended validation. Nothing in this plan asserts that any particular model id
exists.

## 2. Plan decisions (L1–L33)

### Storage

- **L1 — One new project-owned table, `project_llm_settings`**, primary key `project_id`,
  `FK → projects ON DELETE CASCADE`, registered in `projectOwnedTables` with
  `scopeColumn: "project_id"`. It carries the optional credential (`provider`, `model`,
  `api_key_encrypted`), who last changed it and when (`updated_at`, `updated_by_user_id`), and the check
  bookkeeping (`last_check_at`, `check_lease_until`). *Rejected:* two tables — the spec expects one
  migration adding one table; columns on `projects` — operational lease state does not belong on the row
  every settings form writes; an in-process cooldown map — web and worker are separate processes and an
  install may run two web containers, so FR-021's limit would not actually hold.
- **L2 — The row may exist with no credential; the credential is `provider IS NOT NULL`.** A CHECK makes
  K1's atomicity a database fact: either all three credential columns are null, or all three are set. A
  removal (FR-017) nulls all three — destroying the ciphertext — and keeps the row, so the check cooldown
  and the "who last changed it and when" line survive it. "Use the install default" is therefore *no row,
  or a row whose provider is null*, and the service has exactly one predicate to get right.
- **L3 — `provider` is `text` with a CHECK naming the two providers, not a new pgEnum.** The roadmap
  closes the provider list; a CHECK is editable in one ordinary migration without `ALTER TYPE ADD VALUE`'s
  ordering rules, and the email tables already use this shape (`drizzle/0022_*.sql`).
- **L4 — The associated data is `project_llm_credential:<projectId>`**, the shape
  `webhook_endpoint:<id>` already uses. FR-008's "a ciphertext moved into another project's row fails to
  decrypt" is then the cipher's job, not a service check that could be forgotten.
- **L5 — Nothing but the ciphertext.** No hash, prefix, last-four, length or fingerprint column exists to
  populate, so FR-009 is a property of the schema (K6). The surface's status is computed from
  `api_key_encrypted IS NOT NULL`.

### Resolution

- **L6 — The one named place is `src/server/llm/resolve.ts`, `resolveLlmForProject(projectId)`** (FR-006).
  It returns a discriminated union — `{ ok: true, source: "project" | "install", provider, model, owner,
  limits, llm }`, `{ ok: false, reason: "not_configured", problems }` or
  `{ ok: false, reason: "key_unreadable" }` — and is the only code that reads the credential table or
  asks `getLlm()` on a project's behalf. A status-only sibling is deliberately *not* added: one function
  with one answer is what FR-006 asks for, and decrypting a short string costs microseconds.
- **L7 — No provider-instance cache for a project credential.** The install branch calls `getLlm()` and
  keeps its existing memoisation byte-for-byte, so an env-only install's behaviour and timings are
  identical (SC-001); a project credential constructs its SDK client per resolution, which makes FR-007's
  "no restart and no cached staleness" true by construction. *Rejected:* a keyed cache — the key material
  would become part of a Map key, and an eviction policy is a new thing to get wrong for no measurable
  gain.
- **L8 — Install-wide limits are parsed on their own.** A new `parseLlmLimits(source)` reads
  `LLM_TIMEOUT_SECONDS` and `LLM_MAX_OUTPUT_TOKENS` through the existing `intIn`, and `parseLlmConfig`
  delegates to it. This is what makes FR-004 true under K3: today `llmTimeoutMs()`
  (`runner.ts:68-71`) falls back to a hard-coded 90 000 whenever the provider group is incomplete, which
  was harmless while generation was off everywhere and is wrong the moment a project can generate on an
  install with no `LLM_PROVIDER`. Fixed in passing, with a test.
- **L9 — `credentialOwnerFor` becomes a read of the table**; owner values are `"install"` and
  `project:<uuid>`. `INSTALL_CREDENTIAL_OWNER` keeps its value, so every existing hold row keeps its
  meaning and no data migration is needed (C7/H2 paid off exactly as intended).
- **L10 — A batch sibling, `credentialOwnersFor(projectIds)`**, one statement for many projects.
  `resolveBlockedProjectIds` uses it: it runs inside the claim transaction, and one round trip per
  candidate project would put an unbounded number of statements inside a held transaction. The
  single-project `credentialOwnerFor` stays for every other caller.
- **L11 — The resolved credential carries its owner**, so `runGenerationStep` and `planSeries` stop asking
  twice: `withCreditHold(llm, resolved.owner)` instead of a second `credentialOwnerFor` call. One read per
  generation instead of two, and the owner can never disagree with the credential it came from.
- **L12 — Readiness, overview, job creation, the Batch jobs screens and the job page take their answer
  from `resolveLlmForProject`.** `getLlmStatus()` survives, used by startup-adjacent code and as
  resolution's install branch, so the lines an env-only install renders are unchanged (K4, SC-001). The
  job page's "Set: …" list comes from the `not_configured` branch's `problems`, which are the same
  `EnvIssue` names it prints today.
- **L13 — Test seams: `setLlmForTests` is untouched and still wins everywhere**, so no existing test
  changes. A new `setLlmFactoryForTests((config) => provider)` is consulted only when that override is
  unset, which is how a test gives a different stub per key — US1's independent test, which needs two
  projects to observe two different providers in one run.

### The surface

- **L14 — A new permission statement, `llm_credential: ["manage"]`**, granted to `owner` and `admin`,
  absent from `editor` (K11). The sub-nav link, the page and all three actions ask the same question in
  the same way `api_key` / `webhook` already do, so FR-014 is checkable in one place.
- **L15 — A settings sub-page, `/p/[projectSlug]/settings/model`**, beside API keys and Webhooks rather
  than a card on the project settings page. It carries a write-only secret, a confirmed destructive
  action and a live-call control — the shape those two pages already have — and the sub-nav's permission
  filter is where "absent, not disabled" (spec 028) is already implemented. An editor reaching the URL
  directly gets `notFound()`, the api-keys precedent, so existence is not revealed.
- **L16 — The key input is a `type="password"` field with `autoComplete="off"` and no value, ever.**
  Blank key with an unchanged provider keeps the stored key (FR-015, K8); blank key with a changed
  provider is a field-level error on the key (K8); blank key with nothing stored is a field-level error.
  No message quotes a submitted value (FR-016).
- **L17 — One shared Zod schema for provider and model**, `projectLlmCredentialSchema` in
  `src/lib/validation/generation.ts`, whose model rule is `parseLlmConfig`'s own (1–200 characters, no
  whitespace) so the install and a project are checked identically. The key is bounded at **500
  characters** after trimming, a documented constant; above it the refusal names the limit and no part of
  the value. Trimming matches `parseLlmConfig`, and empty-after-trimming is "no key given".
- **L18 — One audit action, `llm_credential_update`**, covering set, change and removal, with details
  `{ fromProvider, fromModel, toProvider, toModel, keyChanged }` — never the key (K12). None of those
  names trips `assertAuditDetailsSafe`, which stays in force as the only write path.
- **L19 — Removal is a confirmed `Dialog` submit** naming the project and saying plainly that generation
  moves back onto the install's account (K13). It nulls the three credential columns in one transaction
  with the audit row and the hold clear.
- **L20 — The surface reports, and never renders a fragment of the key**: the provider and model in force,
  whether that is this project or the install default, whether a key is stored, and who last changed it
  and when (FR-013). A project on the install default sees one sentence saying so — the only visible
  addition for an env-only install (K4).

### The check

- **L21 — One check implementation, two callers** (K14, constitution IV), in
  `src/server/services/generation/check.ts`. `runLlmCheck(projectId, repo)` is the whole thing — resolve,
  gate, one call through `withCreditHold(resolved.owner)` so FR-023 uses the same wrapper every other path
  uses, release, map — and `checkProjectLlm(scope)` is `need(scope)` plus that call. The command line
  calls `runLlmCheck` directly with a repo pinned to the project id it resolved. *Rejected:* a
  session-less owner-privileged `ProjectScope` for the operator — it would create a privilege surface
  nothing else needs, and keeping `src/app` away from it would be a new lint to maintain. The split costs
  one extra exported function and asserts no role for a caller that has none.
- **L22 — The gate is a lease plus a cooldown on the settings row, claimed and released in two short
  transactions with the live call in between** — the claim shape webhook delivery and the email section
  already use, and the rule that no provider call happens inside a held transaction. The claim is one
  conditional upsert (`ON CONFLICT (project_id) DO UPDATE … setWhere`): zero rows returned means another
  check is in flight or the cooldown has not passed, which is refused with a fixed sentence and **no live
  call** (FR-021, AS 2.4). Two concurrent claims serialise on the row lock and the loser re-evaluates the
  predicate after the winner commits, so exactly one wins under READ COMMITTED.
- **L23 — Documented constants, not environment variables** (the shape H6 set for the probe interval):
  `LLM_CHECK_COOLDOWN_MS = 30_000`, `LLM_CHECK_LEASE_MS = 60_000`, and the call's own timeout is
  `min(installTimeoutMs, 30_000)`. The cap is what makes SC-003's "a verdict in under 30 seconds" a
  property of the code rather than a hope, and the lease outlives the longest call it can make.
- **L24 — The CLI grows one optional argument.** `pnpm llm:check` with no argument is byte-identical to
  today — same lines, same exit codes, no database (FR-022). `pnpm llm:check --project <slug>` needs
  `DATABASE_URL`, resolves that project through a named `crossProject` read with no session, prints
  `source=… provider=… model=… outcome=… latency_ms=…` and exits non-zero on failure. It runs **no**
  `job_call` lines: those judge the install's tick budget, which is not a per-project fact.

### The hold

- **L25 — Saving, changing and removing clear the project's hold inside the same transaction as the
  write** (FR-027, K16), so "its items resume on the next tick" is a committed fact rather than a
  follow-up call that could fail after the save succeeded. `clearCreditHold(owner)` gains an optional
  `exec` parameter, exactly as `rewindCreditProbe` already has one.
- **L26 — The notice gains one sentence naming whose account needs credit** (FR-028). The five existing
  constants in `src/lib/jobs/credit-hold.ts` are untouched; one more is added, `CreditHoldNotice` takes a
  `scope: "project" | "install"` prop, and `generationCreditHold(scope)` — which already resolves the
  owner — returns that discriminator alongside `since`. A project whose own credential is not held gets
  no notice, because the lookup is keyed by that project's owner (AS 3.6).
- **L27 — The runner's global gate becomes "the install is configured, or some project has a
  credential"**, one `EXISTS` read per tick, so an install with neither still claims nothing and the
  `notConfigured` counter keeps its meaning. Per item, resolution runs after the claim and before the
  call; `not_configured` or `key_unreadable` **releases** the item — no attempt counted, no failure, the
  existing `release()` — and increments a new per-item counter. That is what the spec's "a key removed
  while a job is queued" and "the install has no configuration" edge cases require: items wait, nothing is
  destroyed.
- **L28 — Orphan hold rows are swept by housekeeping.** `llm_credit_holds.owner` is a text key shared
  with `"install"`, so it cannot carry a foreign key; `pruneOrphanCreditHolds()` deletes `project:<uuid>`
  rows with no matching project, one bounded batch per tick beside the existing purges. That is how
  FR-029's "no hold row remains" is met for a deletion path the product does not yet have.

### Secrecy, tests and docs

- **L29 — The undecryptable-key sentence is a resolution state, not a failure kind** (K10, and the spec's
  own assumption). No `LlmFailureKind` is added, neither pgEnum is migrated, and `messages.test.ts`'s
  exhaustiveness assertion is untouched. Its single sentence lives in a new
  `src/lib/generation/llm-source.ts` beside the credit-hold wording, and the public API maps it onto the
  existing `generation_not_configured` through `LlmNotConfiguredError` — the honest code, since generation
  is not usable for this project and no retry helps until someone acts (no new API error code).
- **L30 — The runner's `logLine` redacts the *resolved* key, not just the environment's.** It passes
  `[parsed.config.apiKey]` to `redact` today; a project-sourced call must pass that project's key, or the
  belt-and-braces guard would be weakest for exactly the new case (FR-010). `logLlmCall` needs no change:
  it already emits fixed fields only.
- **L31 — A new guard test extends the existing one.** `key-reads.test.ts` keeps "the environment keys are
  read only in `config.ts`"; a sibling asserts three things by walking `src/` and `scripts/`:
  `api_key_encrypted` / `apiKeyEncrypted` appears only in the schema, `src/server/dal/project-llm.ts` and
  `src/server/llm/resolve.ts`; `decryptSecret` is applied to it only in `resolve.ts`; and `runLlmCheck` is
  imported only by `check.ts`'s siblings and `scripts/llm-check.ts`. FR-010's "nowhere else" becomes a
  lint rather than a hope.
- **L32 — The secret-scan extension is one more section of the existing scanned run** (the shape H19
  set): a project key saved, changed and removed through the real server actions; the settings page
  rendered for owner, admin **and** editor; a check; a tick that generates on that credential; and a
  billing refusal whose provider error body embeds *that* key. The stored key joins the run's
  `credentials` list, so it is scanned in all five forms (raw, base64, base64url, URL-encoded, hex) in
  every captured place, with nothing exempted; the file's existing deliberate-leak test still proves the
  scanner can fail. `no-plaintext.test.ts` gains the stored key and its SHA-256 hex and dumps the new
  table before its all-tables scan (FR-030).
- **L33 — Docs.** `docs/generator.md`'s sentence "Keys are read from the environment only and never
  stored, logged or rendered" is replaced **in place**, under the same headings other documents link to,
  by what is now true, plus a "Per-project provider, model and key" subsection covering resolution, who
  may set one, the check and the undecryptable case; "Jobs" gains the per-project hold scope.
  `docs/decisions.md` gains **047 — Per-project LLM** with K1–K16 and L1–L33 next to the generator
  decisions, including a line of its own stating that an install that only ever used environment
  variables needs to do nothing and behaves exactly as before. `docs/security.md`'s four secret rows are
  updated to name the stored project key and the new places, and gain a row for the credential at rest
  naming the tests that prove it. `.env.example`'s generator block says a project may also store its own.
  **No new environment variable.**

## 3. The resolution call sites

Every place that asks about the model today, and what it becomes. FR-006 is satisfied when this list is
exhaustive and each row goes through `resolveLlmForProject`.

| Call site | Today | After |
|---|---|---|
| `generation/core.ts:235` (`runGeneration` default) | `getLlm()` | resolved for `scope.project.id` (L6, L11) |
| `generation/core.ts:110` (`runGenerationStep`) | `withCreditHold(llm, await credentialOwnerFor(id))` | `withCreditHold(llm, resolved.owner)` (L11) |
| `generation/series.ts:85` (`planSeries` default) | `getLlm()` | resolved (L6) |
| `generation/regenerate.ts:47` (optional `llm`) | passed through | passed through; the default resolves |
| `services/voice.ts:288` ("Try it") | `runGeneration` default | resolved through it |
| `services/jobs/runner.ts:294` | `ctx.llm ?? getLlm()` | `ctx.llm ?? resolved` per item, with the release path (L27) |
| `services/jobs/runner.ts:68` (`llmTimeoutMs`) | `parseLlmConfig(process.env)` | `parseLlmLimits(process.env)` (L8) |
| `services/jobs/runner.ts:74` (`logLine`) | redacts the env key | redacts the resolved key (L30) |
| `services/jobs/create.ts:105` | `getLlmStatus()` | resolved for the scope (L12) |
| `services/jobs/read.ts:169` and `generationCreditHold` | `getLlmStatus()`, `credentialOwnerFor` | resolved; the hold gains its scope (L12, L26) |
| `services/generation/readiness.ts:15`, `services/overview.ts:39` | `getLlmStatus()` | resolved (L12) |
| `scheduler/generation.ts:71` | `getLlmStatus().configured` | install configured **or** any project credential (L27) |
| `app/p/[projectSlug]/jobs/[jobId]/page.tsx:62` | `getLlmStatus()` | the job view's own fields (L12) |
| `scripts/llm-check.ts:87,91` | `getLlmStatus()` / `getLlm()` | unchanged with no argument; resolved with `--project` (L24) |

## 4. Alternatives considered and rejected

- **Field-by-field override** (a project model over the install key). Rejected by K1 for a product reason
  — it would spend the operator's credit on a model they never chose — and it has no honest resolution for
  a half-set row. The CHECK in L2 makes it impossible rather than merely discouraged.
- **A credential row deleted on removal, with the cooldown somewhere else.** Rejected: the cooldown then
  needs a second table or columns on `projects` (L1), and "who last changed it and when" would be lost at
  exactly the moment someone wants to know who turned the override off.
- **Adding the undecryptable case as a tenth `LlmFailureKind`.** Rejected (L29): it is not a model-call
  outcome, it would force a migration of two pgEnums the spec says are untouched, and it would put a
  fixable configuration problem into the same vocabulary as provider failures.
- **Caching project providers.** Rejected (L7).
- **An operator control to lift a hold, or a per-project probe interval.** Out of scope by the spec; entry
  1's mechanics are explicitly unchanged.
- **Exempting the new table from the secret scan** (the easy way to make FR-030 pass). Forbidden by the
  roadmap's own rule for every entry, and L32 does the opposite.
