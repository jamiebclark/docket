# Implementation Plan: Account posting instructions (per-account platform rules separate from the voice)

**Branch**: `011-account-posting-instructions` | **Date**: 2026-10-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/011-account-posting-instructions/spec.md`

## Summary

Each social account gets optional **posting instructions**: owner-written, channel-specific rules of at most 2,000 characters. The brand voice stays one per project. The work, in brief:

- **Storage and editing**:
  - instructions live in a nullable, normalised column `social_accounts.posting_instructions` (research D1);
  - owners and admins edit them on Accounts, next to the posting slots, through one service, `setPostingInstructions`;
  - that service takes the account row lock and writes an audit row in the same transaction (D2, D3).
- **Generation**:
  - **Grouping**: target accounts are grouped by platform and identical instructions, through one pure module, `src/lib/generation/groups.ts` (D4). Each group is one variant. A platform with one group keeps the platform key, so the one-account-per-platform case is byte-identical to today (FR-009), as proved by golden fixtures recorded before the change (D6). A platform with several groups gets `<platform>_<n>` keys.
  - **Prompt**: a `POSTING INSTRUCTIONS` section takes the place of `PLATFORM GUIDANCE`, between `VOICE` and `PLATFORM RULES` ([contracts/prompt.md](./contracts/prompt.md)).
  - **Output**: the output schema keeps its 007 R4 shape. Each target gets its group's text, and problems name the group (D7, D8).
- **Group limit**: at most **16 groups** per request (R1 interim, one constant). `assertGroupLimit` enforces it before any model call or write in every caller: single, series, regenerate, Try it, job creation and the public API (D5).
  - **The error**: it throws `GroupLimitError`, a named `ValidationIssuesError`. `failFromError` keeps its message and turns its field into `fieldErrors.targetAccountIds`, so every form shows the real text, not the generic validation message. The API still returns 400 `validation_failed`.
  - **Live**: the forms show the same message before submit.
- **Snapshots**:
  - every generation record stores, per account, the id, name, platform, instructions and group key (D8);
  - jobs store `posting_instructions_snapshot` at creation, beside the pinned voice version, and the runner uses it for every item. Pre-feature jobs (`NULL`) use current instructions (D9).
- **Voice**:
  - per-platform guidance leaves the editor and new versions (a separate input schema). Old versions keep it and show it read-only in history, labelled as no longer used, and the prompt never reads it (D10);
  - Try it now chooses accounts (D12).
- **Migration**: `0008` (generated DDL) and `0009` (custom SQL). `0009` copies each project's default profile's latest per-platform guidance onto that project's matching, empty, not-removed accounts. It is idempotent and has a migration test that seeds between the two files (D11).
- **UI and API**:
  - the result screen and Review group texts by the record's groups. Edits are sent keyed by account ids, while client state is keyed by group key, through a pure, unit-tested helper (D13). Problem labels use the stored group label;
  - `GET /api/v1/accounts` returns `postingInstructions`, which also appears in `account.*` webhooks, and the OpenAPI document picks it up (D14).

**No new dependency.**

**Revision, 2026-10-05.** This revision follows the review ([review.md](./review.md)). Three findings came from gaps in this design, and the design is now explicit about each:

- **Refusal message** (F2): the error class and how actions show its message (D5, F12).
- **Editor keying** (F1): how `VariantEditor` keys its state, and the problem label (D13, F4).
- **Try it defaults** (F5): one function for the default selection (D12).

The quickstart now names the tests behind F3, F6 and the new behaviour. The other findings are implementation work against an unchanged design:

- F7: wording in `docs/generator.md`;
- F8: commit the tree;
- F9: run T047.

Spec, data model and API contract are unchanged.

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS (`>=24.10 <25`).

**Primary Dependencies**: all already installed.

- Next.js 16.3.8: App Router, server actions, client leaf components. Read `node_modules/next/dist/docs/01-app/` before writing UI (AGENTS.md).
- `zod` 4.6.5 and `zod-openapi` 6.0.2: schemas and the OpenAPI document.
- Drizzle ORM 0.45.3 (`drizzle-orm/node-postgres`) and drizzle-kit 0.31.11, whose `generate --custom` was verified in `node_modules` (research F5).
- `@anthropic-ai/sdk` and `openai`: unchanged. They are reached only through `src/server/llm`.
- The dev dependency `@seriousme/openapi-schema-validator` is already in `package.json`.

**Storage**: PostgreSQL via Drizzle, in two migrations. Details are in [data-model.md](./data-model.md).

- **`0008`** (generated):
  - `social_accounts.posting_instructions text NULL`, with a 1..2000 check;
  - `generation_jobs.posting_instructions_snapshot jsonb NULL`;
  - `membership_action` value `account_posting_instructions_update`.
- **`0009`** (custom): the guidance copy.
- No new tables. Both changed tables are already project-owned and registered.

**Testing**: Vitest against real Postgres, with the fake LLM, as in 007 and 008. New suites:

- `src/lib/generation/groups.test.ts`
- `prompt.test.ts` and `schema.test.ts` additions, plus the golden fixtures
- `tests/integration/accounts-posting-instructions.test.ts`
- `tests/integration/migrations/copy-platform-guidance.test.ts`, using a throwaway DB and a partial journal
- `tests/integration/generation/{posting-instructions,group-limit,try-it-accounts}.test.ts`
- `tests/integration/jobs/posting-instructions.test.ts`
- API endpoint and OpenAPI additions

They are mapped in [quickstart.md](./quickstart.md). No live calls.

**Target Platform**: the existing `node:24-slim` image (web and worker). The worker bundle gains only the pure grouping module.

**Project Type**: the single Next.js app (`src/app`, `src/components`, `src/server`, `src/providers`, `src/lib`).

**Performance Goals**:

- Grouping is O(accounts), with at most 50 accounts per request.
- Prompt size grows by the instructions text: at most 16 groups × 2,000 characters, and typically a few hundred characters.
- The job runner adds no queries, because the snapshot is on the job row it already loads.

**Constraints**:

- **No model call before the limit check**: `assertGroupLimit` precedes every model call, and no model call happens in a held transaction (unchanged).
- **Account save transaction**: it locks only the account row, so it is compatible with `removeAccount`'s order (account → posts → targets).
- **Neon pooler**: no session features.
- **Stored records**: they stay backward-compatible, because the new record fields are nullish.
- **Interim constants** (each one constant, logged in `docs/decisions.md`):
  - `GROUP_LIMIT = 16` (R1);
  - `POSTING_INSTRUCTIONS_MAX = 2000`.

**Scale/Scope**:

- A handful of projects, each with a few accounts per platform.
- **Out of scope** (spec): per-image briefs or links, compliance checks, per-account voices, API writes and instruction history beyond the audit log.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Pre-research | Post-design | How the design complies |
|---|---|---|---|
| I. Verified facts over memory | PASS | PASS | The schema limits come from `docs/research/llm-and-storage.md` §1–2. Migrator behaviour and `--custom` were read from `node_modules` (research F5). Prompt and schema behaviour was read from current code (F1, F2, F8). R1 and the OpenAI property-count limits stay **UNVERIFIED**, behind one constant, with no value guessed. |
| II. Nothing "working" unless it ran | PASS | PASS | Every requirement maps to a test in quickstart §1–8 that runs against real Postgres with the fake LLM. The migration is exercised on a real database between `0008` and `0009`. Model compliance is reported as unverified. |
| III. Isolation in one place | PASS | PASS | The new columns sit on already-registered project-owned tables. The new DAL method uses the project-scoped `mine(id)` predicate, which the scope-check test covers. Services check `account: ["manage"]` on the server, outside and inside the transaction. The cross-project scoping test is in quickstart §2. The migration is SQL in the migration transaction, not runtime code. |
| IV. One service layer | PASS | PASS | There is one grouping module (D4), one `assertGroupLimit` with one error class (D5), and one Try it default selection used by the service and the panel (D12). The UI, jobs, Try it and the API all call the same generation services. Display grouping has one implementation, `variantGroupsForPost`, shared by the result screen and Review (D13). |
| V. Providers are plug-ins | PASS | PASS | No provider folder changes. Platform names and rules still come from the registry. Instructions are a Docket column, not part of provider `settings` (D1). |
| VI. Boring, few dependencies | PASS | PASS | No new dependency or infrastructure. |
| VII. Secrets never leak | PASS | PASS | Instructions are not secret (spec assumption), so they may appear in prompts, records, audit and API. The audit details keys (`accountId`, `displayName`, `previous`, `next`) pass the repository's secret-key guard. No credentials are touched. |
| Engineering: tick bounded, no network in a held transaction | PASS | PASS | The runner reads the snapshot from the loaded job. An over-limit pre-feature job fails the item with no call (D9). |
| Engineering: UI via `docket-ui` | PASS | PASS | [contracts/ui.md](./contracts/ui.md) covers labelled fields, help text, live counter, field errors, pending state, live regions, empty states and read-only views for editors. |
| Workflow: docs and decisions | PASS | PASS | The docs are `docs/generator.md`, `docs/accounts.md` and a `docs/decisions.md` `## 011` section with all FR-027 entries. |

**Result**: no violations, so Complexity Tracking is empty.

Two readings of the spec are recorded for the owner to check in `docs/decisions.md`:

- **(a)** A `platformGuidance` key sent to voice save is stripped, not refused (D10).
- **(b)** A `/generate` group-limit 400 is stored and replayed under its idempotency key, like other 4xx responses (D5).

## Project Structure

### Documentation (this feature)

```text
specs/011-account-posting-instructions/
├── plan.md              # This file
├── research.md          # Phase 0: facts F1–F12, decisions D1–D15 (revised 2026-10-05)
├── data-model.md        # Phase 1: columns, migration SQL, record shapes, VariantGroup
├── quickstart.md        # Phase 1: validation guide mapped to requirements
├── contracts/
│   ├── services.md      # grouping module, accounts, generation, voice, jobs, posts/review services
│   ├── prompt.md        # prompt sections, keys, output schema, invariants P1–P8
│   ├── ui.md            # Accounts form, voice editor/history, Try it, forms, result/Review, job page
│   └── http-api.md      # GET /accounts field, group-limit error, OpenAPI
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
drizzle/0008_*.sql, drizzle/0009_copy_platform_guidance.sql, drizzle/meta/*   # migrations (D11)
src/server/db/schema/{accounts,jobs,audit}.ts      # posting_instructions, posting_instructions_snapshot, enum value
src/server/dal/accounts.ts                         # setPostingInstructions
src/server/dal/errors.ts                           # GroupLimitError (D5)
src/lib/action-result.ts (+ .test.ts)              # GroupLimitError keeps its message; field → fieldErrors (D5)
src/lib/generation/groups.ts (+ .test.ts)          # NEW pure grouping, GROUP_LIMIT, messages, defaultTryItSelection (D4, D12)
src/lib/validation/{voice,generation,jobs}.ts      # voiceContentInputSchema; record.accounts, remainingProblems.groupKey; snapshot schema
src/lib/api/schemas.ts                             # AccountSchema.postingInstructions
src/server/services/accounts.ts                    # setPostingInstructions, AccountView.postingInstructions
src/server/services/generation/
  groups.ts                                        # NEW assertGroupLimit, groupsForAccounts, recordAccounts
  prompt.ts, schema.ts, core.ts                    # section, keys, per-group checks (D6, D7)
  single.ts, series.ts, regenerate.ts, save.ts     # grouping + limit + record + save by group (D8)
  __fixtures__/pre-011-prompts.json                # NEW golden outputs recorded from pre-change code
src/server/services/voice.ts                       # input schema, no-op check, Try it by accounts (D10, D12)
src/server/services/jobs/{create,runner,read}.ts   # snapshot, limit, runner use, job view (D9)
src/server/services/posts/variant-groups.ts        # NEW display grouping (D13)
src/server/services/posts/index.ts, review.ts      # edits by accountIds; groups for Review
src/server/services/views/account.ts               # toApiAccount field (D14)
src/server/api/operations/generate.ts              # problem labels
src/app/p/[projectSlug]/accounts/{page.tsx,PostingInstructionsForm.tsx,actions.ts}
src/app/p/[projectSlug]/settings/members/{activity-list.tsx,page.tsx}
src/app/p/[projectSlug]/voice/{VoiceEditor.tsx,voice-logic.ts,TryItPanel.tsx,page.tsx,[profileId]/history/page.tsx}
src/app/p/[projectSlug]/generate/{generate-logic.ts,GenerateForm.tsx,page.tsx,actions.ts,result/[postId]/*}
src/app/p/[projectSlug]/review/{ReviewList.tsx,actions.ts}
src/app/p/[projectSlug]/jobs/{new/form-data.ts,new/JobForm.tsx,[jobId]/page.tsx}
docs/{generator.md,accounts.md,decisions.md}
tests/integration/{accounts-posting-instructions.test.ts,migrations/copy-platform-guidance.test.ts}
tests/integration/generation/{posting-instructions,group-limit,try-it-accounts}.test.ts
tests/integration/jobs/posting-instructions.test.ts
```

**Structure Decision**: the existing single Next.js app layout. New logic goes into the existing service and lib folders. The only new modules are the pure grouping module (shared by server and client forms), its server-side assertion helpers, and the display-grouping service.

### Implementation order (for `/speckit-tasks`)

1. **Golden fixtures first**: record `pre-011-prompts.json` from the unchanged `prompt.ts` and `schema.ts`, for voices with no guidance and one account per platform. Commit the fixture and its test before any prompt change (D6).
2. Schema and migrations (`0008`, `0009`), the migration test, the DAL method, and `setPostingInstructions` with its audit and role tests.
3. The grouping module with its unit tests, then the prompt, schema and core changes with tests P1–P8.
4. The single, series, regenerate and save callers, plus the record snapshot and the limit tests on each caller.
5. Jobs: the snapshot, the runner, the job view, and the job tests.
6. The voice input schema, editor removal, history label and Try it by accounts.
7. UI: Accounts form, activity label, form group-limit messages, result screen, Review, job page.
8. API field and OpenAPI test, `/generate` problem labels.
9. Docs and decisions, then the final pass (quickstart §9).

**After the 2026-10-05 review**, steps 1–8 are implemented but uncommitted. The remaining work, in order:

1. Commit the existing tree in logical conventional commits with explicit paths (review F8).
2. Add `GroupLimitError` and the `failFromError` change, with their unit and action-level tests (F2).
3. Key `VariantEditor` by group key through a `variant-logic.ts` helper, with its unit test (F1). Use the stored problem label on the result screen (F4).
4. Add `defaultTryItSelection` and use it in `tryVoice` and `TryItPanel` (F5).
5. Fill the test gaps in quickstart §4 and §5: the Try it limit, the real `requestId`, failure-row counts, deferred and manual retries, and the job page render (F3, F6).
6. Fix the `docs/generator.md` wording (F7). Record the `GroupLimitError` choice in `docs/decisions.md` § 011.
7. Run the final pass, T047 (F9).

## Complexity Tracking

No constitution violations to justify.
