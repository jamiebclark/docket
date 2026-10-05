# Quickstart: validating account posting instructions

This guide proves the feature works end to end. It covers what to run, what to expect, and which test covers each requirement. Shapes and rules are in [data-model.md](./data-model.md) and [contracts/](./contracts/). This file does not repeat them.

## Prerequisites

- Node 24 and pnpm, with dependencies installed (no new packages).
- Postgres for tests: the same local or CI service the suite already uses, with `DATABASE_URL` set.
- The LLM is always **faked** in tests (`tests/helpers/fake-llm.ts`, `setLlmForTests`). No live model calls are made. Anything that needs a real model is reported as "verified with fakes only" (constitution II).

## 1. Schema and migrations

```bash
pnpm db:generate                                                    # writes 0008 (column, job snapshot, enum value)
pnpm exec drizzle-kit generate --custom --name=copy_platform_guidance   # empty 0009; fill with data-model.md § Migration
pnpm db:check                                                       # must pass: migrations match the schema
pnpm vitest run tests/integration/migrations/copy-platform-guidance.test.ts
```

Expected (US4 scenarios 1 to 5, FR-023, SC-007):

- **Setup**: the test migrates a throwaway database from a copy of `drizzle/` whose journal stops at `0008`.
- **Seed**:
  - Project A has a default profile whose latest version has Bluesky and Facebook guidance, and whose older version has Instagram guidance.
  - It also has a non-default profile with Threads guidance.
  - Its accounts: Bluesky ×2 (one with instructions), Facebook, Threads, and a removed Bluesky account.
  - Project B has no default profile.
- **Apply the real folder**:
  - the empty Bluesky account and the Facebook account now hold the guidance;
  - the Bluesky account that had instructions, Threads, the removed account and project B are unchanged;
  - Instagram guidance from the old version is not copied;
  - no audit rows are added.
- **Re-run** the `0009` SQL: no row changes.

## 2. Editing instructions on Accounts

```bash
pnpm vitest run tests/integration/accounts-posting-instructions.test.ts tests/integration/accounts-ui.test.ts
```

Expected (US1, FR-001 to FR-004, SC-008):

- An owner and an admin save text (including CRLF and surrounding spaces), and it is stored normalised. One audit row records the actor, the account id and name, the previous text and the new text.
- Saving the same text again returns `changed: false` and writes no audit row.
- Clearing the field stores `NULL` and is audit-logged.
- 2,001 characters is refused with "Keep posting instructions to 2,000 characters or fewer", and nothing changes.
- An editor's call is a `ForbiddenError`, and nothing changes. The editor's page shows the text read-only, with no form.
- An account id from another project is `NotFoundError`, both when read and when written.
- A reconnect (mock `reconnectMock`, and `upsertConnected`) keeps the instructions.

To check by hand: run `pnpm dev` with `MOCK_PROVIDER_ENABLED=true`, connect two mock accounts, open **Accounts**, and save instructions on one. The counter tracks the typed length. **Settings → Members → Recent activity** shows "… changed the posting instructions for "Account name"".

## 3. Prompt assembly and grouping (pure)

```bash
pnpm vitest run src/lib/generation/groups.test.ts src/server/services/generation/prompt.test.ts src/server/services/generation/schema.test.ts
```

Expected: invariants P1 to P8 in [contracts/prompt.md](./contracts/prompt.md).

- **Golden fixtures**: `__fixtures__/pre-011-prompts.json` was recorded from the code **before** `prompt.ts` changed (the first implementation task). It must match byte for byte (FR-009, SC-003).
- **Grouping unit tests**: whitespace and CRLF differences group together; case and inner-spacing differences do not; group order follows first appearance; keys use `_n` only for multi-group platforms; `GROUP_LIMIT` is 16.

## 4. Generation through every caller

```bash
pnpm vitest run tests/integration/generation/posting-instructions.test.ts tests/integration/generation/group-limit.test.ts
```

Expected (US2, US3, US6, FR-005 to FR-015, FR-019, SC-002, SC-004, SC-005):

- **Grouping** (the fake model returns variants by key):
  - (a) two Bluesky accounts with identical instructions ask for one variant `bluesky`, and both targets get it;
  - (b) different instructions ask for `bluesky_1` and `bluesky_2`, each target gets its own text, and the prompt lists each key with its account name;
  - (c) one account per platform, with no instructions, gives the same keys, texts and prompt as before.
- **Record**: the latest generation record has an `accounts[]` entry per target (id, display name, platform, instructions, group key). Editing the account afterwards leaves the record unchanged.
- **Retry**: one group on a platform breaks its limit. The retry prompt names `bluesky_2 (Bluesky: …)`, and the retry asks for the same keys.
- **Group limit**: 17 groups are refused on each of these callers:
  - single, series plan, series start and series post;
  - regenerate and Try it (`tryVoice` with 17 groups through `accountIds`);
  - job creation, `POST /api/v1/generate` and `POST /api/v1/jobs`.

  Each refusal is a `GroupLimitError` (an API 400) naming 17 and 16, and the fake model has `requests.length === 0`. Exactly 16 groups proceed.
  - **Nothing is written**: for single, assert no post for the refused request's own `requestId`, not a fresh random id. For single and `/generate`, the generation-failure row count is unchanged. For `/generate`, no post is created. For jobs, no job.
- **Group limit through server actions** (research D5): `src/lib/action-result.test.ts` adds two cases.
  - `failFromError(new GroupLimitError(groupLimitMessage(17)))` returns `message` and `fieldErrors.targetAccountIds` equal to that text, which names 17 and 16.
  - A plain `ValidationIssuesError` still returns the generic message and no `fieldErrors`.

  An action-level integration case, `regenerateAction` or `generateSingleAction` over the limit, returns the same text in `message`.
- **Callers**: series plans and posts include the section; regenerate uses the **current** instructions.

## 5. Jobs

```bash
pnpm vitest run tests/integration/jobs/posting-instructions.test.ts
```

Expected (US5, FR-016 to FR-018, SC-006):

- **Snapshot**: creating a job (UI, CSV and API sources) stores a snapshot.
- **Mid-job edits**: edit an account's instructions, then run ticks (`runTick` with the fake model). Every item's prompt and record show the snapshot text. That includes three cases, each with its own assertion:
  - an item appended over the API after the edit;
  - a deferred correction retry (`pending_retry`, made by a fake response that breaks a limit);
  - an item retried with `retryItem` after a failure.
- **Next job**: a second job uses the new text.
- **Removed account**: an account removed mid-job is dropped. The remaining accounts still use their snapshot.
- **Pre-feature job** (`posting_instructions_snapshot = NULL`, seeded directly): items use current instructions, and records show what was used.
- **Over the limit at creation**: a job with more than 16 groups is refused.
- **Job page**: a render assertion shows "Posting instructions (as of job creation)" with the snapshot per account, and "Not recorded" for the pre-feature job.

## 6. Voice editor, history and Try it

```bash
pnpm vitest run src/lib/validation/voice.test.ts 'src/app/p/[projectSlug]/voice/voice.test.tsx' tests/integration/generation/try-it-accounts.test.ts
```

Expected (US4 scenarios 6 and 7, US6 scenarios 1 and 2, FR-020, FR-024, FR-025):

- **Saving a voice**: `platformGuidance` in input is not stored. An unchanged save of a pre-upgrade version creates no new version.
- **Editor and history**: the editor has no guidance field. History shows old guidance under "Platform guidance (no longer used)", with a link to Accounts.
- **Try it with accounts**: two Bluesky accounts with different instructions return two samples, each labelled with its account. Nothing is written: post, failure and version counts are unchanged.
- **Try it defaults**: `defaultTryItSelection` (`src/lib/generation/groups.test.ts`) keeps list order and stops adding accounts at 16 groups. `tryVoice` without `accountIds` returns the samples for that same selection.
- **Try it without accounts**: the panel shows the empty state, and the service throws "Connect an account to try the voice."

## 7. Result screen, Review and edits

```bash
pnpm vitest run 'src/app/p/[projectSlug]/generate/result/result.test.tsx' tests/integration/review tests/integration/generation/overrides.test.ts
```

Expected (FR-011, US2 scenario 7):

- Two Bluesky groups show two cards, labelled with their accounts, each with `used / limit`.
- **Editor logic** (`variant-logic.ts` unit test, research D13): with cards `bluesky_1` and `bluesky_2`, editing `bluesky_2` changes only that card's displayed text and only its `{ accountIds, text }` edit. The other card keeps its original text.
- Saving or approving an edit to one card changes only that group's targets.
- **Problem labels**: remaining problems on the result screen use the stored label, for example `mock_2 (Mock (offline): Acme News): …`, never a bare `mock_2: …`.
- Older posts (records without `accounts`) still group by platform and show "Not recorded".

## 8. Public API and OpenAPI

```bash
pnpm vitest run tests/integration/api/endpoints tests/integration/api/openapi.test.ts
```

Expected (US7, FR-021, FR-022):

- `GET /api/v1/accounts` with a `read` key gives each item `postingInstructions` (text or `null`).
- The OpenAPI document validates (`@seriousme/openapi-schema-validator`), and `Account` documents the field as required and nullable.
- Request shapes for `/generate` and `/jobs` are unchanged (the existing contract tests pass).

## 9. Final pass (once, at the end of implement)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

`build` is included because routes, server actions and client components change. Docs to check by reading:

- `docs/generator.md`: voice vs posting instructions, prompt order, grouping, the limit, snapshots and the migration;
- `docs/accounts.md`: the new field and who can edit it;
- `docs/decisions.md`: a new `## 011` section with the FR-027 entries.

## What stays unverified

- R1, the Anthropic required-property and schema-size limits, and OpenAI property-count limits (research F3, F4). The 16-group limit is the guard.
- That the model follows the instructions well. That is best-effort, by design, and only the owner can judge it with a live model.
