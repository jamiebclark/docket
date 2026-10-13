# Quickstart: validating generated images in the media library

**Feature**: `070-image-generation` | **Plan**: [plan.md](./plan.md)

Runnable checks that prove the feature works end to end, mapped to the spec's success criteria.
Details live in [data-model.md](./data-model.md) and [contracts/](./contracts/); this file is how
you run them and read the result.

**No step here makes a live provider call** (constitution II). Every image comes from a stubbed
`ImageProvider` or a mocked HTTP fetch returning known bytes, and anything that cannot be exercised
without real credentials is reported as "verified with mocks only".

---

## Prerequisites

```bash
pnpm install                      # pre-installed in pipeline phases; phases cannot reach npm
docker compose up -d postgres     # integration tests need a real Postgres
```

- Integration tests require `DATABASE_URL` to name a database **ending in `_test`**
  (`tests/setup/global-setup.ts`), which it clones per worker. On this machine that Postgres
  listens on **port 5555**, not the 5432 in `.env.example` — point `DATABASE_URL` at
  `postgres://…@localhost:5555/docket_test` before running them.
- `pnpm db:generate` after touching `src/server/db/schema/media.ts` or
  `src/server/db/schema/generation.ts`, then **commit the SQL**, or `pnpm db:check` fails.
- No environment variable is needed to run the tests: the image provider is injected through
  `setImageProviderForTests` / `setImageProviderFactoryForTests`, the same seams the text path has.

## Run the checks in proportion to the change

Per the constitution: per task, only the affected tests (`pnpm vitest run <files>`), plus
`pnpm typecheck` when types changed and `pnpm lint <files>` for touched files. Once, at the end of
the implement phase: the full `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm db:check`
(the schema changed) and `pnpm build` (routes and a client component changed).

---

## 1. An owner generates an image into the library — **SC-001**, US1

```bash
pnpm vitest run tests/integration/media/generate.test.ts
```

**Expect**

- A stubbed provider returning a known 1536×1024 PNG produces **one** `media_assets` row for the
  project, `kind = 'image'`, `processing_state = 'ready'`.
- Both objects — original and thumbnail — exist under `projects/<projectId>/media/<assetId>/`, and
  nowhere else.
- The row's `width`/`height` match the landscape aspect; `mime_type` is `image/png`.
- `original_filename` is `Generated image.png`; `alt_text` is `''`; `tags` is empty.
- A whitespace-only prompt, and a 1001-character prompt, are refused **before** the provider is
  called: the stub records **zero** calls and no row is written.
- A provider failure of each kind leaves the library byte-for-byte unchanged: no row, **and no
  storage object** (assert the storage stub's `put`/`delete` pairs balance).
- Bytes over `MEDIA_MAX_UPLOAD_MB` or `MEDIA_MAX_MEGAPIXELS` are refused with the **library's own**
  sentence (`processUpload`'s), not an image-generation sentence.

## 2. A generated image is an ordinary asset — **SC-002**, US2

```bash
pnpm vitest run tests/integration/media/generated-is-ordinary.test.ts
```

**Expect**, against an asset created through the service with a stubbed provider:

- `fitOf` returns the **same** `PlatformFit` for every registered provider as it does for an
  uploaded image of identical dimensions, format and byte size — assert the two objects are deeply
  equal, which is what SC-002 actually claims.
- `ensureVariant` derives and caches a variant for a provider whose constraints need one, with no
  generated-image branch anywhere in `media-variants.ts` or `media-fit.ts` (assert by behaviour,
  and by `grep` in check 9).
- It appears in the "Unused" filter, is returned by `listIdsForSelection({ unusedOnly: true })`,
  is found by a filename search, can be attached to a post, and is deleted by `deleteMedia` — all
  through the existing paths.
- Deleting it removes the provenance with the row (query the four columns after delete: no row).
- It is never treated as a video: `kind = 'image'`, `video` is `null` on the view.

## 3. A billing refusal pauses, it does not fail loudly — **SC-003**, US3

```bash
pnpm vitest run tests/integration/llm/image-hold.test.ts
```

**Expect**

- A stub raising the provider's own quota error (`type: "insufficient_quota"`) writes an
  `llm_credit_holds` row for `install`, and the caller gets the fixed credit-exhausted sentence.
- With a project credential whose provider **is** the configured image provider, the hold is
  written for `project:<id>` and the call spends that project's key (assert the key the factory
  seam was handed).
- A credential already held from an earlier **text** refusal is still attempted (no pre-refusal),
  and a second refusal refreshes `last_refusal_at` and `next_probe_at` while leaving `held_since`
  unmoved.
- A success clears the hold.
- With the hold write forced to throw, a successful generation still returns `ok: true` and the
  asset still exists.
- A project whose stored key cannot be decrypted is refused with the existing
  `LLM_KEY_UNREADABLE` sentence, and the install's key is **never** handed to a provider (assert
  the factory seam saw no install key).

## 4. Nothing is offered that cannot work — **SC-006**, **SC-008**, US4

```bash
pnpm vitest run tests/integration/media/generate-gates.test.tsx
```

**Expect**

- Storage off: the Media page renders the existing storage empty state and **no** generate control
  (assert the rendered markup contains neither "Generate an image" nor the dialog); calling the
  action returns exactly `"Media storage is not set up."`, with zero provider calls and nothing
  written.
- Storage on, no image provider: no control; calling the action returns a sentence listing
  `LLM_IMAGE_PROVIDER`, `LLM_IMAGE_MODEL`, `OPENAI_API_KEY` and **no value** (scan the message for
  the distinctive fake key — it must not appear).
- Editor on a fully configured install: no control anywhere on the page; calling the action is
  refused server-side with no provider call and no asset.
- Owner of project A naming project B: refused; neither project gains an asset.

## 5. Provenance and usage — **SC-004**, **SC-009**, US5

```bash
pnpm vitest run tests/integration/media/generated-provenance.test.ts tests/integration/llm/image-usage.test.ts
```

**Expect**

- The row holds the prompt **exactly as typed after trimming** — not the prompt sent to the
  provider, which carries the real-people instruction — plus the provider name, the model id used,
  and `generated_at`.
- An uploaded asset has all four columns null, and the card renders no "Generated" badge.
- The all-or-none CHECK rejects a hand-built insert setting three of the four columns.
- One `llm_call_usage` row per image call that reached the provider, `purpose = 'image.generate'`,
  with the right `credential_source`, `ok`/`failure_kind`, and token counts **only** when the stub
  reported them (null otherwise, never zero).
- **No** usage row for: no storage, no provider configured, an over-length prompt, an editor, a
  cross-project request, an undecryptable key.
- Project isolation: a generated asset and its prompt in project A are invisible from project B by
  list, search, direct `get` and provenance read.

## 6. Every prompt carries the real-people instruction — **SC-010**

```bash
pnpm vitest run tests/integration/llm/image-prompt.test.ts
```

**Expect** — asserted **directly**, not inferred: for a plain prompt, a prompt already mentioning a
person, and a prompt at the 1000-character limit, the string the adapter received ends with
`NO_REAL_PEOPLE`, and contains **nothing else** beyond the person's words — no brand tagline, no
description, no website, no voice profile, no post text, no platform rule (FR-015).

## 7. Provider mapping and error shapes — mocks only

```bash
pnpm vitest run src/server/llm/openai-image.test.ts src/server/llm/image-messages.test.ts src/server/llm/config.test.ts
```

**Expect**, with `createFakeLlmFetch`:

- The request body is exactly `{ model, prompt, n: 1, size, output_format: "png" }` — nothing else,
  and no `max_output_tokens`.
- `square → 1024x1024`, `landscape → 1536x1024`, `portrait → 1024x1536`; an explicit size goes out
  as `WIDTHxHEIGHT`.
- 200 with `b64_json` → bytes; 200 with `data: []`, or an item with no `b64_json` → `invalid_output`.
- 401 → `auth`; 429 with `type: "insufficient_quota"` → `credit_exhausted`; plain 429 →
  `rate_limited`; 400 with an **unknown** code → `bad_request`; 400 with a code supplied through
  the `markers` parameter → `refused`; 500 → `unavailable`; an aborted timeout → `timeout`.
- The client is built with `maxRetries: 0` — one 500 produces exactly **one** HTTP call.
- `IMAGE_FAILURE_MESSAGES` and `LLM_FAILURE_MESSAGES` are each keyed by every value of
  `LLM_FAILURE_KINDS`.
- The config parse table in [contracts/config.md](./contracts/config.md) § 3, row by row, including
  that no reason contains a value.

## 8. Secrets — **SC-005**

```bash
pnpm vitest run tests/integration/security/secret-scan.test.ts tests/integration/no-plaintext.test.ts
```

**Expect** — the existing scanned run, **extended** (never exempted): it now generates one image
through a fake provider and renders the Media page for owner, admin and editor. No distinctive fake
key, no SDK error text and no raw provider payload appears in any rendered page, any returned
message, any log line or any dumped table. `no-plaintext.test.ts` dumps every table, so the four
new columns are covered the moment a generated row exists.

## 9. The guard tests stay green — **SC-007**, FR-003, FR-004

```bash
pnpm vitest run src/server/llm/no-model-literal.test.ts src/server/llm/key-reads.test.ts \
  src/server/llm/no-missing-usage-purpose.test.ts src/server/auth/access.test.ts \
  src/server/llm/image-generation.test.ts tests/lint/env-coverage.test.ts
```

**Expect**

- No model id anywhere in `src/` outside comments — unchanged and green.
- `OPENAI_API_KEY` still read only in `src/server/llm/config.ts`; the ciphertext column still named
  only in the schema, `dal/project-llm.ts` and `llm/resolve.ts` — **both unchanged** (that is why
  image resolution lives in `resolve.ts`, **P3**).
- The usage-purpose closed set names exactly **eight** call sites.
- The access matrix names `media:generate` for owner and admin, and denies it for editor.
- `image-generation.ts` exports the vocabulary and **no vendor value**.
- `.env.example` documents both new variables with description, marker and default.

## 10. Swapping the provider is an adapter change — **SC-007**

Not a test run; a reviewable assertion, checked by `grep` and by one test:

```bash
grep -rn "1024x1024\|1536x1024\|1024x1536\|b64_json\|output_format" src/ --include=*.ts --include=*.tsx \
  | grep -v "openai-image"
```

**Expect** no hits outside `src/server/llm/openai-image.ts` (and its test). Plus a test that drives
the whole generator through a **non-OpenAI stub** `ImageProvider` installed via
`setImageProviderForTests` and gets a complete asset with provenance — proving the media library,
the hold, the ledger, the UI and the contract never learn a vendor.

---

## Real-app walkthrough (manual, once)

With storage configured, `LLM_IMAGE_PROVIDER=openai`, a real `LLM_IMAGE_MODEL` and a funded key:

1. `pnpm dev`, sign in as an owner, open **Media**.
2. "Generate an image" → type a prompt → choose Landscape → Generate.
3. The button shows its pending state; a screen reader announces "Generating an image…", then
   "Image added to the library."
4. The new tile appears without a reload, with a thumbnail, the "Generated" badge and the prompt
   under **Prompt**.
5. **Settings → Usage** shows one more call under "Generated image".
6. Sign in as an editor: no "Generate an image" control anywhere on Media.

Anything proven only by steps 1–9 above is reported as **"verified with mocks only"** until
someone runs this walkthrough.

**Outcome (T045): unachievable in an automated implement pass.** This phase runs headless, with no
browser, no `pnpm dev` session and no funded OpenAI key — the three things this walkthrough names as
prerequisites. Everything it would prove is covered only "verified with mocks only" by the automated
test suite until a person with those three things runs it by hand.

## Done when

- [X] `pnpm db:check` green with the committed migration.
- [X] Checks 1–9 pass; check 10's `grep` is empty.
- [X] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green in the final pass.
- [X] `docs/generator.md`, `docs/storage.md`, `docs/security.md`, `.env.example` and
      `docs/decisions.md` updated (FR-038).
- [X] The implement phase has **committed** its work — the pipeline never auto-commits.
