# Feature Specification: LLM cost visibility — show a project what it used

**Feature Branch**: `068-llm-cost-visibility`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Before specifying, read .specify/roadmaps/llm-credentials.md in full — in particular its preamble (goal paragraph and the 'Behaviour on main that every entry builds on' bullets, especially the last one: LlmUsage with inputTokens/outputTokens is returned by every call and written to the log line by logLlmCall in src/server/llm/log.ts, and no `usage` column exists anywhere in the generation schema), the 'Rules for every entry' list, and this entry's own section '3. llm-cost-visibility'. Also read docs/generator.md ('Configuring a provider', 'Jobs') and docs/security.md in full, as the roadmap preamble requires of every entry.

Sequencing the author gives: only worth building once entry 2 (per-project-llm) has projects spending their own money. LlmUsage is already returned by every call and logged, but nothing persists it, so there is no history to report.

Build: persist per-call input and output tokens against the generation that produced them, and surface per-project usage and estimated spend. Per-token prices differ by provider and model and change over time, so this spec must decide where rates live and how an unpriced model is displayed — the author's position is that an estimate labelled as one beats a confident wrong number.

Must leave the repo working and state what it does not do. No secret may reach a log, a response or the UI; extend the secret-scan suite rather than exempting it.

Does NOT: enforce budgets, cap or throttle generation on spend, or bill anyone. Reporting only. The author names no later entry owning those — this is the last entry in the roadmap, so they are simply out of scope."

## Context and sources

- Roadmap `.specify/roadmaps/llm-credentials.md`, entry **3 of 3**, slug `llm-cost-visibility`. The roadmap's goal: "make Docket's LLM layer survive a provider refusing on billing, then let a project bring its own model and key **and see what it spent**." This entry is the last clause, and the last entry in the roadmap.
- Entry 1 (`credit-hold`, `specs/043-llm-credit-hold`, `docs/decisions.md` § 045) landed the per-owner billing hold. Entry 2 (`per-project-llm`, `specs/065-per-project-llm`) landed per-project provider, model and encrypted key, resolution ("project override falls back to the env default"), the per-project check, and the owner/admin-only **Settings → Model & API key** page. Both explicitly deferred everything about tokens and spend to this entry: `docs/decisions.md` records "Persisting token usage or cost — roadmap entry 3, `llm-cost-visibility`. Usage stays logged and unpersisted" and "Reporting spend, cost or token usage, per project or at all … This entry stores a key and resolves it; it persists nothing about what a call consumed."
- The roadmap names **no later entry** for budgets, caps, throttling or billing. They are out of scope with no owner; if an install needs them, that is a new roadmap.

### Behaviour on `main` that this feature builds on

Read from the roadmap preamble, `docs/generator.md` ("Configuring a provider", "Per-project provider, model and key", "Jobs"), `docs/security.md` and the code itself:

- **Usage is already measured on every call and thrown away.** `LlmUsage` is `{ inputTokens: number | null; outputTokens: number | null }` (`src/server/llm/types.ts`) and is present on **both** arms of `LlmResult` — success *and* failure — alongside `latencyMs`, `provider` and `model`. Both providers (`src/server/llm/anthropic.ts:84`, `src/server/llm/openai.ts:110`) hand it to `logLlmCall` (`src/server/llm/log.ts`), which prints one redacted line with `usage: { in, out }` and nothing else. **No `usage` column exists anywhere in the generation schema** (`src/server/db/schema/generation.ts`).
- **Partial usage already reaches the database, but only inside a blob.** `generation_metadata` on `posts` (`src/server/db/schema/posts.ts:66`) and `attempts` on `generation_failures` both hold `attempts: [{ kind, latencyMs, usage }]` per `generationRecordSchema` (`src/lib/validation/generation.ts`). It is unindexed JSON on one row per saved post, it does not exist for calls that save no post, and nothing aggregates it. The result page already renders those attempts' latencies (`src/app/p/[projectSlug]/generate/result/[postId]/page.tsx:144`) but not their tokens.
- **Seven labelled call sites exist, and that is the complete list.** `generate.single` (`single.ts:233`), `generate.series_plan` (`series.ts:119`), `generate.series_post` (`series.ts:249`), `generate.regenerate` (`regenerate.ts:82`), `generate.job_item` (`runner.ts:324`), `voice.try` (`services/voice.ts:291`) and `llm.check` (`generation/check.ts:47`). All but the last two save a post; `voice.try` saves nothing; `llm.check` is not a generation at all. Four of the seven funnel through `runGenerationStep` (`generation/core.ts:144`), which can make a **second, correction retry call** in the same step.
- **Every project-context call already resolves a credential and knows its owner.** `resolveLlmForProject` (`src/server/llm/resolve.ts`) returns `source: "project" | "install"`, `provider`, `model`, `owner` and install-wide `limits`; `docs/generator.md` documents `pnpm llm:check --project <slug>` printing `source=project` or `source=install` as "the quickest way to tell which credential a project is actually spending". `credentialOwnerFor` (`src/server/dal/credential-owners.ts`) answers the same question for the hold.
- **Project-owned data goes through the scoped DAL** (`src/server/dal/`, constitution III): every table but users/auth carries `project_id`, a lint rule stops route handlers, actions and jobs importing the raw client, and a test fails if a query touches a project-owned table without a scope.
- **Roles are a server-side ACL.** `src/server/auth/access.ts` grants `llm_credential: ["manage"]` to `owner` and `admin` only; `editor` has neither it nor `api_key`/`webhook`. The settings sub-nav (`settings/layout.tsx`) adds "Model & API key" only when `scope.can({ llm_credential: ["manage"] })`, and `docs/generator.md` states the URL "404s for them (absent, not disabled)".
- **Projects carry their own time zone** (`projects.timezone`), and all times are stored UTC with wall-time conversion only through Temporal with explicit DST disambiguation (constitution).
- **`docs/security.md` is a per-area table, every row Fixed or Accepted**, and `tests/integration/docs/security-findings.test.ts` checks every row names tests that exist. The scanned run in `tests/integration/security/secret-scan.test.ts` already covers a billing-refusal generation through both real providers over an error body embedding the key, the Batch jobs screens rendered while held, and a project key saved, changed, checked and removed; `tests/integration/no-plaintext.test.ts` dumps all tables.

### Facts, and what is not verified

- **Verified against the live provider on 2026-10-12** (roadmap, and `docs/generator.md` § Jobs): 8 requests, 360 tokens, **every one of them free** — attributed on the usage dashboard to the data-sharing incentive tier, total spend `$0.00`. At the Build tier that offer covers 2.5M tokens a day on the mini group, roughly a thousand Docket generations. Tokens × list price would have overstated spend by about **100%**. A typical call was ~1.3 s with **58 input / 42 output tokens** on a trivial prompt.
- **The API will not say what was free.** A response's `service_tier` reports processing priority (`default`/`flex`/`priority`), not billing attribution. The free share appears only on the provider's own usage dashboard, grouped by processing tier. Nothing Docket can read at call time distinguishes a free call from a billed one.
- **Per-token prices are an external fact Docket may not assert.** Constitution I forbids taking them from memory, `docs/research/` has no price table (`llm-and-storage.md` covers APIs, not pricing), and pipeline phases cannot reach the web. Any price in this feature therefore has to come from the operator. See **M8**.
- No new runtime dependency and no new infrastructure is expected (constitution VI). One migration is expected: one new project-owned table. No change to either failure-kind pgEnum (`llm_failure_kind`, `generation_job_item_error`) and no change to `LlmFailureKind`.
- Everything live is verified with mocked HTTP only (constitution II). No test in this entry makes a real provider call.

## Decisions made while specifying

Judgement calls, for planning to record in `docs/decisions.md` as **M1–M19**, after entry 1's `C`/`H` sets and entry 2's `K`/`L` sets.

### What gets recorded

- **M1 — One row per model call, not per generation.** The roadmap asks for "per-call input and output tokens against the generation that produced them". A column on the post could not hold two numbers for a step that made a correction retry, could not hold the plan call plus one call per post for a series, and has nowhere to put `voice.try` (saves no post) or `llm.check` (is not a generation). So: a project-owned, call-level ledger, each row naming the generation it belongs to — post, series, job item — where one exists, and naming its purpose where one does not.
- **M2 — Every call that reached the provider is recorded, whatever its outcome.** Failed calls consume tokens: `invalid_output`, `incomplete` and `refused` all come back reporting input and some output usage, and the correction retry is a second call that consumed its own. Recording only successes would understate by exactly the amount that hurts most — the runs that went wrong. The outcome (`ok` or the failure kind) is stored beside the counts, so the report can say how much went on calls that produced nothing.
- **M3 — Unknown counts stay unknown; null is never 0.** `LlmUsage`'s fields are already nullable, and a call that timed out or never got a response body has no counts to report. Such a call is counted as a call, excluded from token sums, and the exclusion is stated on the screen ("N calls reported no token counts"). Coercing null to zero would manufacture exactly the confident wrong number this entry exists to avoid.
- **M4 — Each row records which credential it spent, and the provider and model as used at the time.** All three are already on `LlmResult` / `ResolvedLlm`. A project's history spans credentials (it may adopt, change or remove its own key at any time, and entry 2's "undecryptable key" case moves nothing back to the install), and the operator of a shared credit pool cares which projects are spending the install's. Model is stored as the literal string used, not a reference, so a later rename or removal does not rewrite history.
- **M5 — A call that was never made is not a row.** A project held on billing claims nothing and calls nothing; a request refused before any call (over the 16-group limit, generation not configured, key unreadable) consumed no tokens. The ledger records calls to a provider, not intentions. The hold screens already explain the held case, and nothing here changes them.
- **M6 — Bookkeeping never fails a generation.** The usage row is written after the call returns and must not fail, delay beyond its own insert, or roll back the post, the job item or the series. A failure to write is logged and swallowed. The consequence, stated honestly: the ledger can **under**-count if the process is killed between the provider answering and the row committing, and never over-counts. The report is therefore a floor on calls and tokens, and the money figure (M12) is an upper bound on the calls it knows about.
- **M7 — No prompt, output, error text or credential ever enters the ledger.** A row holds ids, provider, model, source, purpose, outcome, two token counts, latency and a timestamp. That is the same discipline the `attempts` blob already follows, and it keeps entry 1's "no credential value and no fingerprint of one" rule intact.

### Where rates live

- **M8 — Rates are operator-supplied install configuration with no built-in defaults, and Docket never fetches them.** Three reasons, each sufficient: the constitution forbids asserting external facts from memory and phases cannot reach the network; published prices change without notice, so a value committed today is wrong later with no signal; and a baked-in price that is wrong is the "confident wrong number" the author rejects. Docket therefore ships with an **empty** rate table. An install that wants money shown enters the rates it believes it is paying, and the screen says the numbers are the operator's, not Docket's.
  **Where, concretely:** the install's own environment configuration, validated at startup and documented in `.env.example`, which is where every other operator setting in Docket already lives and the only one an operator can change without a rebuild or a database edit. *Rejected:* a file committed into the image — an operator cannot edit it inside a running container; a database table with an install-admin screen — Docket has no install-wide admin surface and this entry should not invent one to hold four numbers; per-project rates in project settings — **M9**.
- **M9 — A rate is keyed by provider and model, with separate input and output prices, expressed per million tokens, in one install-wide currency code.** Per million tokens because that is the unit published prices are normally quoted in, so the operator copies a number rather than converting one. One currency code, displayed as given, with **no conversion** — Docket has no exchange-rate source and inventing one would be another unverifiable fact. Not per project: a project with its own key is normally on the same published price for the same model, and if it is not, the operator still has only one number to type. The trade-off is accepted and stated on the screen.
- **M10 — The estimate is computed when the screen is rendered, from the rates configured now. Rates are not snapshotted per call.** A snapshot would imply the stored figure is a record of what was charged — which it is not — and would freeze a mistyped rate into history forever. The screen says so in its own words: this is what the recorded usage would cost at the rates configured now. Correcting a rate corrects every past estimate, which is the behaviour an estimate should have.
- **M11 — Zero is a legal rate and means zero.** "This model costs us nothing" is a thing an operator may know (a free tier they are confident of, a self-hosted gateway). It is distinct from "no rate configured" (M13), and the screen distinguishes them.

### What the number is called

- **M12 — The surface is called Usage, tokens are the headline, and the money figure is never called "spend", "cost", "charged" or "billed".** It is an **estimated upper bound**, carried by one fixed sentence wherever it appears: the provider may have charged less, or nothing at all, because free tiers and data-sharing offers are invisible to the API, and the provider's own dashboard is the only record of what was actually billed. This is not caution for its own sake — it is the measured case: on 2026-10-12 every one of Docket's calls was free and tokens × list price would have overstated by ~100%. Calls and tokens are facts Docket observed; money is arithmetic over a number the operator typed.
- **M13 — An unpriced model shows no money at all — never zero, never a guess.** Its row shows calls and tokens with an explicit "no rate configured" marker and a pointer to where rates are set. The totals cover only priced models and **say so**, naming how many calls and tokens sit outside them and on which models. A total that silently dropped unpriced usage would be a confident wrong number in the other direction, and one that treated unpriced as free would be the same error the free-tier case already makes.
- **M14 — With no rates configured at all, the money column is absent, not empty.** The screen is honest and useful on calls and tokens alone, which is the roadmap's own position. One line says money can be shown once rates are configured, and where. An all-dashes column that exists only to be filled in is clutter that teaches nothing.

### Who sees it, and where

- **M15 — Owner and admin only, gated on the existing `llm_credential: ["manage"]`; an editor sees no sub-nav item and the URL 404s — absent, not disabled.** This follows entry 2's precedent exactly, for the same reason: what the project's credential is spending is the same concern as what the credential is. No new access-control statement is added; reusing the one that already means "may know about this project's model and key" keeps one answer to one question rather than two that can drift.
- **M16 — It is a screen, and only a screen.** Nothing is added to the public API, no webhook event, no notification, no email, no activity-log entry, no export. The roadmap says "reporting only", and every one of those is a new contract to keep. A later roadmap may add them.
- **M17 — The screen answers for a period in the project's own time zone**, defaulting to the last 30 days, with this month, last month and all time available, and grouped by model with a breakdown by what the calls were for. Day boundaries come from the project's `timezone` through Temporal with explicit DST disambiguation, like every other wall-clock boundary in Docket; a report whose "this month" means UTC would mislabel the edges of every month for most installs.
- **M18 — A total you cannot trace is not trustworthy, so the generation-level numbers show up where the generation already is.** A generated post's existing generation detail gains its calls' token counts next to the latencies it already shows, and a batch job's page gains its own totals. This is what turns "why is this number large?" into an answer.

### Retention

- **M19 — Rows live as long as their project and are never pruned by this entry.** They cascade with the project like every other project-owned table. Volume is bounded by generation itself: a 500-item job is 500–1000 rows, and the documented throughput of ~120 items an hour caps a flat-out install near a million rows a year, which an indexed range scan over `(project, time)` handles without a rollup table. No entry owns pruning or rollups; if an install outgrows this, that is a new roadmap, and the screen's own periods are the natural place to notice.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An owner sees what their project has used (Priority: P1)

A project has its own Anthropic key (entry 2) and has been running batch jobs for a fortnight. Its owner opens **Settings → Usage** and sees, for the last 30 days: how many model calls the project made, how many input and output tokens they consumed, which models they ran on, and which of those calls spent the project's own credential rather than the install's. No money is claimed anywhere, because no rates are configured yet.

**Why this priority**: this is the entry's whole subject, and it is the half that needs no unverifiable facts. The roadmap is explicit that "reporting usage — tokens, calls, per model — is honest and useful on its own". Everything else here is layered on top of it.

**Independent Test**: run generations through a stubbed provider that reports known usage, then load the Usage screen and assert the calls, input tokens, output tokens, per-model rows and credential-source split match what the stub reported. Fully deliverable with no rate configuration in existence.

**Acceptance Scenarios**:

1. **Given** a project with no generations, **When** its owner opens Usage, **Then** an empty state says no model calls have been recorded for this period, and offers the other periods.
2. **Given** a project whose single generation made one call of 58 input and 42 output tokens, **When** its owner opens Usage, **Then** it reports 1 call, 58 input tokens, 42 output tokens, on that model.
3. **Given** a generation whose first call returned invalid output and whose correction retry succeeded, **When** its owner opens Usage, **Then** both calls are counted and their tokens summed, and the failed one is attributed to a call that produced nothing.
4. **Given** a project that ran ten calls on the install's credential, then stored its own key and ran five more, **When** its owner opens Usage, **Then** all fifteen appear, split by which credential they spent, and the ten keep their original attribution.
5. **Given** a call whose provider reported no token counts, **When** its owner opens Usage, **Then** the call is counted, its tokens are excluded from the sums, and the screen says how many calls reported no counts.
6. **Given** usage spread over three months, **When** the owner switches the period from "last 30 days" to "last month", **Then** only calls whose timestamp falls in that month in the project's own time zone are included.

---

### User Story 2 - The operator puts a price on it, and it is labelled as an estimate (Priority: P2)

The install's operator knows what they are paying per million tokens for the two models their projects use, and enters those rates once, install-wide. Every project's Usage screen now also shows an estimated upper bound in the configured currency — per model and in total — carrying one fixed sentence saying the provider may have charged less or nothing, and that only the provider's dashboard records what was actually billed.

**Why this priority**: it is the roadmap's "estimated spend", but it depends on a number Docket cannot know, so it must not block the honest half. P2 rather than P1 for exactly that reason.

**Independent Test**: configure rates for one model, generate known usage on it, and assert the money figure equals tokens × rate, that it is labelled an estimated upper bound, and that removing the rates removes the money column entirely without touching the token figures.

**Acceptance Scenarios**:

1. **Given** no rates configured, **When** any owner opens Usage, **Then** no money appears anywhere, and one line says money can be shown once rates are configured, naming where.
2. **Given** a rate configured for the project's model, **When** its owner opens Usage, **Then** the estimate equals input tokens × input rate plus output tokens × output rate, in the configured currency, labelled as an estimated upper bound with the fixed sentence.
3. **Given** a rate of zero for a model, **When** its owner opens Usage, **Then** that model's estimate is zero currency units and is visibly a configured rate, not a missing one.
4. **Given** a rate the operator then corrects, **When** the owner reloads Usage, **Then** every past period's estimate reflects the corrected rate, and the screen says the figure uses the rates configured now.
5. **Given** malformed rate configuration at startup, **When** Docket boots, **Then** it logs the problem and carries on with no rates configured — generation, jobs and every other screen are unaffected.

---

### User Story 3 - An unpriced model never produces a confident wrong number (Priority: P2)

A project switches to a model the operator has not entered a rate for. The Usage screen keeps reporting that model's calls and tokens, marks it as having no rate configured, and keeps it out of the money total — while saying, in the total's own words, how many calls and tokens it is leaving out and on which models.

**Why this priority**: the roadmap names this as a decision the spec must face rather than discover, and it is the difference between an estimate and a lie. It rides on US2's machinery, so it cannot precede it.

**Independent Test**: configure a rate for model A only, generate usage on A and B, and assert B's row shows tokens with a "no rate configured" marker, the total covers A alone, and the total names B's excluded calls and tokens.

**Acceptance Scenarios**:

1. **Given** rates for model A and usage on A and B, **When** the owner opens Usage, **Then** B's row shows its calls and tokens with an explicit "no rate configured" marker and a pointer to where rates are set.
2. **Given** the same state, **When** the owner reads the total, **Then** it is stated to cover priced models only and names the count of calls and tokens excluded, and the models they ran on.
3. **Given** usage only on unpriced models, **When** the owner opens Usage, **Then** no money total is shown at all — not zero — and the screen says why.
4. **Given** a rate configured for a provider but a different model id, **When** the owner opens Usage, **Then** the model is treated as unpriced; rates never match by provider alone.

---

### User Story 4 - A surprising total can be traced to the generation that caused it (Priority: P3)

An owner sees more tokens than expected, and wants to know which work caused them. A batch job's page shows that job's own calls and tokens, and a generated post's generation detail shows its calls' token counts beside the latencies it already displays.

**Why this priority**: the project total is useful without it, but a number nobody can explain stops being believed. Lowest priority because it adds no new facts, only navigation.

**Independent Test**: run a two-item batch job and one single generation with known usage, then assert the job page's totals equal those two items' calls and the post's detail shows its own call's counts.

**Acceptance Scenarios**:

1. **Given** a completed batch job of two items, **When** its owner opens the job page, **Then** it shows the job's own call count and input and output token totals.
2. **Given** a generated post, **When** an owner opens its generation detail, **Then** each attempt shows its input and output token counts beside its latency, and an attempt with no reported counts says so rather than showing zero.
3. **Given** a job still running, **When** its owner opens the job page, **Then** the totals cover the calls made so far and are labelled as being to date.

---

### User Story 5 - The ledger leaks nothing and costs nothing (Priority: P1)

Across the whole feature, no API key, prompt, model output or provider error text reaches the ledger, the screens, a log line or a response — and a failure to write a usage row never costs anyone a post.

**Why this priority**: a roadmap rule for every entry, and non-negotiable under constitution VII. P1 beside US1 because the first row written is the first chance to break it.

**Independent Test**: extend the existing scanned run to render the Usage screen for owner, admin and editor and to dump the new table, and assert no secret appears; separately, force the usage write to fail and assert the generation still saves and still answers normally.

**Acceptance Scenarios**:

1. **Given** the scanned secret-scan run with a project key stored, changed, checked and removed, **When** the Usage screen is rendered for owner, admin and editor and the new table is dumped, **Then** no secret appears in any of them, in any of the five encodings the suite already checks.
2. **Given** a generation that succeeds, **When** the usage row's write fails, **Then** the post is still saved, the caller still gets its normal answer, and the failure is logged without any prompt, output or credential in the line.
3. **Given** an editor, **When** they request the Usage URL directly, **Then** they get a 404 — absent, not disabled — and the sub-nav shows them no Usage item.
4. **Given** a non-member, **When** they request another project's Usage URL, **Then** they get the same not-found as for any foreign project, revealing nothing about its existence.

---

### Edge Cases

- **A call that was never made.** A project held on billing, a request over the 16-group limit, a project whose key cannot be decrypted, an install with generation switched off: no call, so no row, and no gap to explain (**M5**).
- **The credential check and "Try it".** Both spend real tokens and neither saves a post. Both are recorded, attributed to their purpose, and included in the project's totals — a check loop that someone leaned on should be visible, not invisible.
- **A series.** One plan call plus one call per post, each its own row, all tied to the same series.
- **A job item's deferred correction retry.** The retry may land in a later tick, minutes after the first call. Two rows, each stamped when its own call happened, so a period boundary can fall between them.
- **A cancelled job.** Calls already made are already charged; their rows stay. Cancelling removes nothing from the ledger.
- **A deleted post.** The post is soft-deleted; its usage rows stay in the project's totals, because the tokens were spent.
- **A project that removes its own credential**, or whose key stops decrypting: past rows keep saying they spent the project's credential, because they did.
- **Both token counts null.** Counted as a call, excluded from token sums and from any money figure, and surfaced as an exclusion rather than hidden (**M3**).
- **A model id that differs only in case or trailing version suffix** from a configured rate: it does not match. Rates match the model string exactly, and the screen shows the unmatched id verbatim so the operator can see what to add.
- **Rate configuration with a duplicate provider-and-model pair**, a negative number, a non-numeric price or an unknown currency: the configuration is rejected at startup as a whole, logged, and treated as "no rates configured" (**US2 scenario 5**). A half-applied rate table is worse than none.
- **A period with usage but no priced models**: tokens shown, no money total, reason stated (**US3 scenario 3**).
- **DST.** A "last month" boundary in a project whose zone shifted inside the period resolves through Temporal with explicit disambiguation, like every other wall-clock boundary.
- **Concurrency.** Two ticks writing usage rows for different items, and a reader aggregating at the same time, must not block each other or double-count; the ledger is insert-only, never updated.

## Requirements *(mandatory)*

### Functional Requirements

**Persisting usage**

- **FR-001**: The system MUST persist one record per model call that reached the provider and returned, from every path that makes one — single generation, a series' plan, each series post, regenerate, each batch job item, "Try it" on the voice screen, and the credential check — including each correction retry as its own record. No path may make a call without recording it.
- **FR-002**: Each record MUST carry the owning project, the call's purpose, the input and output token counts as reported (nullable, never coerced), the outcome (`ok` or the failure kind), the provider, the model string as used, which credential it spent (the project's own or the install's), the call's latency, and when the call happened.
- **FR-003**: Each record MUST reference the generation it belongs to where one exists — the post, the series and position, or the job item — and MUST be storable without any of them for calls that produce no post.
- **FR-004**: The system MUST NOT store any prompt, model output, provider error text, API key, or any fragment, hash or fingerprint of a key in these records.
- **FR-005**: A failure to persist a usage record MUST NOT fail, delay or roll back the generation, the job item, the series, the check or the voice try that produced it; the failure MUST be logged with no prompt, output or credential in the line.
- **FR-006**: The system MUST NOT write a record for a request that made no provider call (held on billing, refused before the call, generation not configured, key unreadable).
- **FR-007**: Records MUST be insert-only — never updated or deleted by any code path except deletion of the project they belong to.
- **FR-008**: All reads and writes of these records MUST go through the scoped data-access layer with a project scope, like every other project-owned table.

**Rates**

- **FR-009**: The system MUST read per-token rates from the install's own environment configuration only, MUST ship with none configured, and MUST NOT contain, infer or fetch any provider's prices. No project-level surface may set a rate.
- **FR-010**: A rate entry MUST be keyed by provider and exact model string and MUST carry separate input and output prices expressed per million tokens, with one install-wide currency code for all entries.
- **FR-011**: The system MUST validate the rate configuration at startup, and on any problem (duplicate provider-and-model pair, negative or non-numeric price, missing or unknown currency, unparseable input) MUST log it and behave as though no rates are configured, leaving generation and every other feature unaffected.
- **FR-012**: A rate of zero MUST be accepted and MUST be distinguishable on screen from no rate configured.
- **FR-013**: The system MUST compute money figures at render time from the rates configured at that moment, and MUST NOT store a rate, a currency or a money amount on any usage record.

**The Usage surface**

- **FR-014**: Owners and admins MUST be able to see, for a project: the number of model calls, the input and output token totals, and a breakdown by model and by what the calls were for, over a chosen period.
- **FR-015**: The surface MUST show, per model row and in total, how many calls spent the project's own credential and how many spent the install's.
- **FR-016**: The surface MUST offer periods of last 30 days (default), this month, last month and all time, with boundaries resolved in the project's own time zone.
- **FR-017**: The surface MUST state how many calls in the period reported no token counts, and MUST exclude those calls from every token and money figure.
- **FR-018**: The surface MUST distinguish calls whose outcome was `ok` from calls that produced nothing, and MUST report the tokens consumed by the latter.
- **FR-019**: When at least one rate is configured, the surface MUST show an estimated money figure per priced model row and a total over priced models, in the configured currency.
- **FR-020**: Every money figure MUST be labelled an estimated upper bound and MUST carry one fixed sentence stating that the provider may have charged less or nothing, that free tiers and data-sharing offers are invisible to the API, and that the provider's own dashboard is the only record of what was billed. No money figure may be labelled "spend", "cost", "charged" or "billed".
- **FR-021**: A model with no configured rate MUST show its calls and tokens with an explicit "no rate configured" marker and a pointer to where rates are set, and MUST contribute nothing to any money total.
- **FR-022**: A money total MUST state that it covers priced models only, and MUST name the number of calls and tokens excluded and the models they ran on.
- **FR-023**: When no rate at all is configured, the surface MUST omit money entirely and MUST say in one line that money can be shown once rates are configured, naming where.
- **FR-024**: When a period has usage but no priced models, the surface MUST show no money total — not zero — and MUST say why.
- **FR-025**: The surface MUST state that estimates use the rates configured now, so that correcting a rate corrects past estimates.
- **FR-026**: Access MUST be restricted to roles holding the existing project LLM-credential permission (owner and admin). An editor MUST see no navigation entry and MUST receive a 404 for the URL; a non-member MUST receive the same not-found as for any foreign project. No new access-control statement is added.
- **FR-027**: An empty state MUST say that no model calls have been recorded for the period and MUST let the person choose another period.

**Tracing**

- **FR-028**: A batch job's page MUST show that job's own call count and input and output token totals, labelled as to date while the job is still running.
- **FR-029**: A generated post's existing generation detail MUST show each attempt's input and output token counts beside the latency it already shows, and MUST say when an attempt reported no counts rather than showing zero.

**Keeping the install working, and the invariants**

- **FR-030**: An install that configures no rates MUST see no change to generation, jobs, prompts, calls, logging, timings or any other screen; the only addition is the Usage surface itself.
- **FR-031**: The existing one-line-per-call log MUST keep its current fields and shape; this entry adds persistence, not logging.
- **FR-032**: The secret-scan suite MUST be extended, not exempted: the existing scanned run MUST render the Usage surface for owner, admin and editor and include the new table in its dump, and MUST assert that no secret appears in any encoding it already checks.
- **FR-033**: `docs/generator.md` MUST document the Usage surface, where rates live, that no prices ship with Docket, and that the money figure is an estimated upper bound; `docs/security.md` MUST gain or update the rows covering the new table and screens, naming tests that exist; `docs/decisions.md` MUST record M1–M19; `.env.example` MUST document any new configuration with the same "no default on purpose" care the generator block already uses.

### Key Entities

- **LLM call usage record** — one model call that reached the provider: the project it belongs to, what it was for, the generation it came from (post, series and position, or job item; all optional), provider, model string, credential source, outcome, input and output token counts (either may be unknown), latency, and when it happened. Insert-only; cascades with its project. Contains nothing secret and nothing free-text from a provider.
- **Model rate** — install-level operator configuration: provider, exact model string, input price and output price per million tokens. Many rate entries share one install-wide currency code. Not project-owned, not stored per call, empty by default.
- **Usage report** — a derived answer, never stored: for one project and one period, the calls, token totals, per-model and per-purpose breakdowns, the credential-source split, the count of calls with no reported counts, and — only when rates exist — a per-model and total estimated upper bound plus the list of models and calls excluded for want of a rate.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a project whose calls' token counts are known, the Usage screen's call count and input and output token totals match those calls exactly, with no call missing and none counted twice — including correction retries, a series' plan call, "Try it" and the credential check.
- **SC-002**: 100% of calls that reach the provider produce a usage record, proven once for each path that can make one, and 0% of requests that make no call produce one.
- **SC-003**: No money figure appears anywhere in the product when no rates are configured, asserted over the Usage screen, the job page and the post generation detail.
- **SC-004**: With rates configured for some models only, the money total equals the priced models' tokens × their rates, and the screen names every excluded model and the count of calls and tokens excluded — verified by a test that would fail if unpriced usage were silently treated as free.
- **SC-005**: Every money figure in the product is accompanied by the fixed upper-bound sentence; a test fails if any money figure is rendered without it, or if the words "spend", "cost", "charged" or "billed" label one.
- **SC-006**: A call reporting no token counts is counted as a call, contributes nothing to token or money figures, and is reported as an exclusion — asserted on a period containing only such calls.
- **SC-007**: Correcting a rate changes the estimate for a past period on the next page load, with no migration, backfill or write to any usage record.
- **SC-008**: An owner opens Usage and reads their project's calls, tokens and (where priced) estimate for the last 30 days without configuring anything first; the screen answers in under 2 seconds for a project with 50,000 recorded calls.
- **SC-009**: A forced failure of the usage write leaves the generation's outcome, its saved post and its response identical to the same run with the write succeeding.
- **SC-010**: An editor gets a 404 for the Usage URL and sees no Usage navigation entry; a non-member gets the same not-found they already get for any foreign project.
- **SC-011**: The extended secret-scan run finds no secret in the Usage screens, the new table or the rate configuration, and the suite is still proven able to fail by its existing deliberate-leak test.
- **SC-012**: An install with no rates configured and no Usage screen visited behaves identically to `main` — same prompts, same calls, same log lines, same timings, same screens — with the existing test suite unchanged except where it asserts the new behaviour.
- **SC-013**: Period boundaries land on the project's own midnight, including across a DST transition inside the chosen period.

## Assumptions

- **Entry 2 has landed and is what this builds on.** Per-project credentials, `resolveLlmForProject`'s `source`, and the owner/admin-only Settings → Model page all exist. A project with no credential of its own spends the install's, and the ledger records that.
- **The operator is the only source of prices.** Nobody expects Docket to know what their account pays. The operator entering rates is accepted as the price of not being wrong, and an install that never enters any still gets the token report.
- **Rates are install-wide, not per project.** Accepted trade-off (**M9**): a project on a different negotiated price than the install's would be estimated at the install's configured rate for that model. The figure is already an upper bound, and the screen says the rates are the operator's.
- **Estimates are not reconciled against the provider.** Docket never reads a provider's billing or usage API. The roadmap excludes it, and it is the only place the free share is visible.
- **No historical backfill.** Nothing before this entry ships has a usage record, and the `attempts` blobs on existing posts are not mined to invent one — they cover only calls that saved a post, so a backfill would be a partial history indistinguishable from a complete one. The screen's periods start where the ledger does, and the empty state carries no apology.
- **Volume is bounded by generation itself** (**M19**): a 500-item job is 500–1000 records; the documented ~120 items an hour caps a flat-out install near a million records a year. No rollup table, no pruning.
- **Nothing in this entry needs a live provider call.** All usage figures in tests come from a stubbed provider reporting known counts (constitution II).
- **No new runtime dependency and no new infrastructure.** One migration for one project-owned table; no change to either failure-kind pgEnum, to `LlmFailureKind`, or to `logLlmCall`'s shape.
- **Percentage-of-free is not knowable and is not estimated.** The screen never guesses what share of usage was free; it says the figure is an upper bound and points at the provider's dashboard.

## Out of scope — and who owns it

The roadmap ends here, so most of these have **no later owner**. They are out of scope, not deferred.

- **Budgets, caps, throttling or blocking generation on spend** — explicitly out of the roadmap, named as out of scope by entries 1 and 2 as well. **No entry owns this.** The ledger this entry adds would be the natural input to it, which is a reason to keep it clean, not a reason to build it.
- **Billing anyone, invoices, plans, seats or payment** — out of scope for Docket (the constitution lists billing as out of scope until a spec says otherwise, and this spec does not). **No owner.**
- **Reconciling against the provider's own billing or usage API** — excluded by the roadmap; it is the only place the free share is visible, and reading it would mean a second credential, a second failure mode and a second truth to disagree with. **No owner.**
- **Estimating what share of usage was free** — unknowable from the API (`service_tier` is processing priority, not billing attribution). The upper-bound label is the honest substitute. **No owner.**
- **Per-project rates, currency conversion, or rates that vary over time** — **M9**, **M10**. A later roadmap could add them; nothing here forecloses it.
- **Backfilling usage from existing `generation_metadata` blobs** — a partial history that looks complete is worse than an empty one.
- **Exporting usage (CSV, API, webhook, notification or email)** — **M16**. The notifications roadmap owns attention events and this is not one; the public-api roadmap entry owns the API surface and nothing here is added to it.
- **Install-wide or cross-project usage reporting for the operator** — the per-project screens say which calls spent the install's credential, which answers the question that matters without a new admin surface. **No owner.**
- **Per-user attribution of usage** — records name the generation, not the person who asked for it; entry 2 already declined per-user credentials and **no entry owns** per-user anything.
- **Changing entry 1's hold mechanics or entry 2's credential storage, resolution, check or audit** — untouched. A held credential simply makes no calls, so it writes no records.
- **Pruning, archiving or rolling up usage records** — **M19**. **No owner.**
- **Image generation usage** — `src/server/llm/image-generation.ts` is an extension point with no implementation; there is nothing to record.
