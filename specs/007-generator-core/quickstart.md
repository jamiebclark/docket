# Quickstart: validating the generator core (007)

These are runnable checks that show the feature works. Behaviour details are in [contracts/](./contracts/) and [data-model.md](./data-model.md); this guide does not repeat them. Every LLM call in §1–§5 is mocked (constitution II). §6 is the only step that can make a live call, and only when a key is present.

## 0. Prerequisites

- Node 24, pnpm, and the test Postgres from decision #21:

  ```bash
  docker start docket-pg   # postgres://docket:docket@127.0.0.1:5433/docket_test
  export DATABASE_URL=postgres://docket:docket@127.0.0.1:5433/docket_test
  ```

- No new dependencies. `pnpm install --offline` should be a no-op (decision #19).
- Migration `0004` exists and is current:

  ```bash
  pnpm db:check            # "Migrations are current"
  ```

## 1. LLM layer (FR-001–FR-007, SC-005)

```bash
pnpm vitest run src/server/llm
```

Expected outcomes:

- `config.test.ts`:
  - unset settings mean generation is disabled with one problem;
  - `openai` without a key names `OPENAI_API_KEY`;
  - an unknown provider says "must be openai or anthropic";
  - out-of-range timeouts are refused;
  - no value appears in any message;
  - startup continues (it does not exit).
- `openai.test.ts` and `anthropic.test.ts` run against the fake transport. The **same scenario table** passes for both:
  1. the request body carries the system text, the user text, the image part before the text, and the JSON-schema format;
  2. a valid answer returns the parsed value, usage and latency;
  3. bad JSON gives `invalid_output` with `rawText`;
  4. a refusal gives `refused`;
  5. a max-tokens or incomplete answer gives `incomplete`;
  6. 429 gives `rate_limited`;
  7. 500 gives `unavailable`;
  8. 401 gives `auth`;
  9. 400 gives `bad_request`;
  10. an abort or timeout gives `timeout` with "The model took too long to answer.";
  11. the key never appears in logs.
- `images.test.ts`:
  - an oversized PNG becomes a cached variant;
  - a localhost or `signed` storage setup gives bytes mode;
  - a public https setup gives URL mode;
  - an over-budget set is refused with the image named.
- `no-model-literal.test.ts`: `src/` contains no model id.

## 2. Prompt and output checks (FR-013–FR-015)

```bash
pnpm vitest run src/server/services/generation
```

Expected outcomes:

- `prompt.test.ts`:
  - the section order matches contracts/prompt.md;
  - empty voice fields have no heading;
  - guidance for platforms that are not targeted is left out;
  - each platform's limit, counting note and media rule are present;
  - source text sits inside `<source_material>`, and an embedded closing tag is neutralised;
  - the retry section lists the problems;
  - a snapshot is stable.
- `schema.test.ts`: the wire schema has one key per targeted platform, every property required, and no `maxLength`, `minItems` or `anyOf` in `z.toJSONSchema` output.
- `core.test.ts` (fake LLM). Each case asserts the exact number of calls:
  - valid → 1 call;
  - Bluesky text of 312 graphemes, then valid → 2 calls, and the second prompt lists "bluesky: Text is 312 graphemes; the limit is 300.";
  - invalid twice → ok with `remainingProblems`;
  - unreadable twice → `ok: false`;
  - refusal then valid → 2 calls;
  - timeout twice → `timeout`;
  - 429 → 1 call, no retry.

## 3. Policies, review and services (FR-021–FR-032, SC-002–SC-004, SC-008–SC-010)

```bash
pnpm vitest run tests/integration/generation tests/integration/review tests/integration/voice
```

Expected outcomes:

- `policy-matrix.test.ts`: 2 approval policies × 2 scheduling policies × {valid, invalid}, through `generateSingle`:
  - the resulting `review_state` and target statuses match the decidePolicy table;
  - **0** invalid posts end up approved or scheduled;
  - auto + queue + valid gives targets `scheduled` in their next free slots.
- `overrides.test.ts`:
  - an editor overriding to `auto_approve` gets `PolicyNotAllowedError`, "Only owners and admins can auto-approve", and the fake receives 0 calls;
  - an editor with an auto-approve project default is allowed;
  - auto + queue without confirmation is refused, both on generate and on settings;
  - owner and admin overrides leave the project defaults unchanged.
- `single.test.ts`:
  - Bluesky + Facebook + one image gives one post with origin `generated`, two targets each with its variant, the image attached, and complete generation metadata (prompt, provider, model, profile version, inputs, usage, latency);
  - two accounts on one platform give one variant in the schema, used by both targets;
  - the same `requestId` twice gives one post;
  - a removed member's save is refused after the call.
- `series.test.ts`:
  - N=5 plan, edit one angle, delete one, start → 4 posts in order, each prompt containing its angle and the other titles;
  - when angle 3 fails, the others are saved; retrying angle 3 produces no duplicate;
  - an unreadable plan twice saves a failure row and no series.
- `regenerate.test.ts`:
  - regenerate appends a record and keeps the earlier one;
  - an invalid result moves the post to review;
  - a scheduled post is refused.
- `review.test.ts`:
  - approve, then approve again gives `already_reviewed`;
  - an approve with blocking issues is refused with the issues;
  - save-and-approve with an invalid edit keeps the edit and stays in review;
  - reject sends the post to the Rejected filter and the queue refuses it;
  - bulk approve of 20 posts with 1 invalid and 1 slot-less account gives "approved 19, skipped 1", plus an unscheduled note;
  - 20 parallel approvals of one post give one approval and at most one occupied slot per target.
- `voice.test.ts`:
  - create gives v1; edit gives v2, with v1's content byte-identical;
  - a stale `baseVersion` gives a conflict and no write;
  - archiving the default is refused;
  - archived profiles are hidden from Generate and their versions stay readable from posts;
  - editors are refused manage actions;
  - Try it writes 0 rows (a row-count diff over all project-owned tables).
- `tests/integration/actions-authz.test.ts`: the new action × role rows pass.
- The scope registry test fails a query on any of the four new tables without `project_id`.

## 4. Screens (FR-033)

```bash
pnpm vitest run "src/app/p/[projectSlug]/generate" "src/app/p/[projectSlug]/review" "src/app/p/[projectSlug]/voice" src/components
```

These are render tests in the existing style. They check:

- the not-configured, no-profile (owner vs editor) and no-accounts states;
- the labelled auto + queue option and its required checkbox;
- the editor's disabled auto-approve option with help text;
- the review empty state and bulk summary;
- the voice conflict banner;
- the Try it caption "Samples are not saved".

## 5. Manual walk (optional; needs a real key)

With the LLM settings in `.env`, run `pnpm dev`, sign in as an owner, and:

1. Create a voice profile, make it the default, and edit it to v2.
2. Open the profile's history and check v1 is unchanged.
3. Generate for a Bluesky account and a mock account.
4. Edit a variant and watch the counts.
5. Regenerate.
6. Approve the post in Review.
7. Reject another post and find it under Posts → Rejected.

Without a key, Generate shows "Generation is not configured" with the setting names; that state is itself a check. There is no fake-LLM switch in the app: the fake lives only in `tests/helpers/`. The automated checks in §1–§4 are the acceptance evidence.

## 6. Live latency (FR-037, SC-011)

```bash
pnpm llm:check
```

- With `LLM_PROVIDER`, `LLM_MODEL` and the matching key set, this prints `provider=<p> model=<m> outcome=ok latency_ms=<n>` (or the failure kind).
- Without them it prints `latency: unmeasured (no LLM key configured)` and exits 0.
- Record the line in `docs/decisions.md` under 007. If nothing was measured, write "verified with mocks only".

## 7. Final gates (once, at the end of implement)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

All exit 0. `tests/lint/worker-bundle.test.ts` still passes: the worker does not import `src/server/llm` or `src/server/services/generation`.
