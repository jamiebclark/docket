# Review: Generate images into the media library, behind the existing ImageGenerator extension point

Reviewed 57 changed files across 6 implementation commits (`a4ba69c`…`102b5cf`), against
`9a15100...HEAD` (`git merge-base HEAD origin/main`). Spec artifacts excluded from the count.

Read in full: `src/server/llm/image-generation.ts`, `image-provider.ts`, `image-messages.ts`,
`openai-image.ts`, the `config.ts` / `resolve.ts` / `usage.ts` / `openai.ts` / `images.ts` diffs,
`src/server/services/media-generate.ts`, `src/server/services/generation/credit.ts`,
`src/server/services/media.ts` (changed regions plus `prepareUpload`/`commitUpload`/`uploadMedia`/
`deleteMedia`), `src/server/media/process.ts`, `src/server/db/schema/media.ts` +
`drizzle/0028_ambitious_dazzler.sql`, `src/lib/validation/media.ts`,
`src/app/p/[projectSlug]/media/{page.tsx,actions.ts,GenerateImageDialog.tsx}`, `run-action.ts`,
`src/components/media/MediaCard.tsx`, `src/components/ui/{Dialog,LiveRegion,Button}.tsx`,
`src/server/auth/access.ts`, `src/server/startup/validate.ts`, `src/server/storage/index.ts`, and
every new or extended test file (`tests/integration/media/*`, `tests/integration/llm/image-*`,
`tests/helpers/fake-image.ts`, `src/server/llm/openai-image.test.ts`, `image-messages.test.ts`,
`image-generation.test.ts`, `no-model-literal.test.ts`, `key-reads.test.ts`,
`no-missing-usage-purpose.test.ts`, `src/lib/validation/media.test.ts`,
`tests/lint/env-coverage.test.ts`, the `secret-scan.test.ts` / `no-plaintext.test.ts` diffs).

Sampled: `src/components/ui/ChoiceField.tsx` (first 60 lines, to confirm `SegmentedControl` and
not a native `<select>`); the `docs/*` and `.env.example` diffs read in full but judged for
coverage rather than prose; `src/server/llm/config.test.ts` and `startup/validate.test.ts` read as
diffs only.

Not reviewed: `drizzle/meta/0028_snapshot.json` (8,663 generated lines — the hand-written
`0028_ambitious_dazzler.sql` was read instead), and the unchanged bodies of
`media-variants.ts` / `media-fit.ts` / `src/providers/media.ts` (FR-024 asks that they *not*
change, and `git diff --stat` confirms they did not).

Verification run: `pnpm vitest run` over the nine unit/guard files this entry adds or touches —
9 files, 167 tests, all passing (`openai-image`, `image-messages`, `image-generation`, `config`,
`no-model-literal`, `key-reads`, `no-missing-usage-purpose`, `auth/access`, `validation/media`).
Per the constitution's "review: do not re-run the full suite" rule, the Postgres-backed
integration suite, `pnpm build` and `pnpm db:check` were not re-run; T044 records them green on
this code and there is no PR yet, so no CI run exists to read.

## Verdict

The engine is right. The three layers the plan promised are all there and they fit: everything
vendor-specific really is confined to `openai-image.ts` (the T043 grep is clean), the generated
bytes go through the untouched `prepareUpload`, so a generated asset is genuinely an ordinary one
downstream, and the hold and ledger are *shared* code rather than copies — `applyCreditOutcome`
is one function with two thin wrappers, and the four provenance columns ride on `media_assets`'s
existing scoped surface. Thirty-five of the thirty-eight functional requirements are satisfied
with a citation. What has not landed as well is the **front edge**: the one user-visible entry
point is the least verified thing in the entry. Nothing — no test, and not the human walkthrough,
which T045 records as unachievable — ever renders the Media page with image generation configured,
so the claim "an owner can start a generation from the Media page" rests entirely on reading; and
the success announcement that FR-033 and US1-3 require is written into a live region that sits
inside the `<dialog>` the same state update closes, so it cannot reach a screen reader.
Separately, the declared contract's optional `aspect` was never given its documented default, so
`createImageGenerator(...).generate({ projectId, prompt })` throws instead of generating a square.
Three MAJORs, all in the top ~150 lines of UI and validation; the service and provider layers
below them I would merge as they stand.

## Findings

- [ ] MAJOR F1 — The success announcement is placed inside the dialog that the same update closes, so it is never announced
      where:  src/app/p/[projectSlug]/media/GenerateImageDialog.tsx:62, src/app/p/[projectSlug]/media/GenerateImageDialog.tsx:50
      why:    `<LiveRegion>` is rendered as a child of `<Dialog>` (line 62), and `Dialog` renders a
              native `<dialog>` whose open state is driven imperatively
              (`src/components/ui/Dialog.tsx:48-57`). On success the transition sets the
              announcement and closes the dialog in the same batch (lines 50-52), so the commit
              that first renders "Image added to the library." is the commit that drops the `open`
              attribute. A `dialog:not([open])` is `display: none` per the UA stylesheet —
              `src/app/globals.css` only styles `dialog::backdrop` and does not override it — so
              that subtree leaves the accessibility tree and `aria-live` has nothing to announce
              from. Failure and in-flight announcements do work (the dialog stays open), which is
              why this reads as correct on a casual pass. Every other panel in the codebase puts
              `LiveRegion` at the component's top level, outside any dialog
              (`src/app/p/[projectSlug]/settings/api-keys/ApiKeysPanel.tsx:20`,
              `src/app/p/[projectSlug]/settings/webhooks/WebhooksPanel.tsx:32`); this is the only
              one that does not.
      owed:   Move `<LiveRegion message={announcement} />` out of `<Dialog>` into the enclosing
              fragment, beside the trigger button, so it stays mounted and exposed to assistive
              technology whether the dialog is open or closed.
      traces: FR-033, US1-3, constitution "Engineering: accessibility"

- [ ] MAJOR F2 — Nothing anywhere verifies that the generate control is ever rendered; the gate suite is all-negative
      where:  tests/integration/media/generate-gates.test.tsx:40, tests/integration/media/generate-gates.test.tsx:55, tests/integration/media/generate-gates.test.tsx:77
      why:    All three page assertions in the gate suite are
              `expect(html).not.toContain("Generate an image")`, and
              `grep -rn "Generate an image" src tests` finds no positive assertion anywhere in the
              repository. No test environment sets `LLM_IMAGE_PROVIDER` — the only three
              `process.env` assignments live in `image-hold`/`image-usage`, which never render a
              page — and the secret-scan extension explicitly calls
              `setImageProviderForTests(null)` before rendering the Media page
              (`tests/integration/security/secret-scan.test.ts:575`), so the trigger is absent in
              that render too. The suite therefore passes identically if `canGenerateImage`
              (`src/app/p/[projectSlug]/media/page.tsx:60`) is wired wrong, if
              `<GenerateImageDialog>` is never rendered, or if that component throws on render — it
              has no failing case for the requirement it is named after. T045, the one check that
              would have covered this, is recorded in tasks.md as "unachievable in this automated
              implement pass", so FR-031's positive half and SC-001 end to end are currently
              asserted by nothing that ran. `docs/security.md:29` already states "Owner and admin
              reach it" and cites this file as its evidence.
      owed:   Add a fourth case to `generate-gates.test.tsx`: storage on,
              `setImageProviderForTests` set to a fake, acting as the owner (and again as the
              admin) — render the page and assert the trigger *is* present, including in the
              empty-library branch (plan P21). That one positive control is what makes the three
              negative ones mean something.
      traces: FR-031, SC-001, constitution II ("Nothing is 'working' unless it ran")

- [ ] MAJOR F3 — The declared contract's optional `aspect` has no default, so a legal request throws instead of generating a square
      where:  src/lib/validation/media.ts:91, src/server/services/media-generate.ts:37
      why:    `ImageGenerationRequest.aspect` is optional
              (`src/server/llm/image-generation.ts:5`), spec.md's Key Entities say "either an
              aspect (square, portrait or landscape; square when unstated)", and
              `DEFAULT_IMAGE_ASPECT = "square"` exists for exactly that — but
              `grep -rn DEFAULT_IMAGE_ASPECT src` shows its only consumer is the dialog's local
              `useState`; no server path reads it. `generateImageSchema` declares
              `aspect: z.enum(IMAGE_ASPECTS)` with no `.optional()` and no `.default()`, so
              `generateImage`'s `.parse(input)` (media-generate.ts:37) throws `ZodError` for a
              request that omits it. Concretely,
              `createImageGenerator(scope).generate({ projectId: scope.project.id, prompt: "a cat" })`
              — a request valid against the very contract this entry exists to implement — is
              rejected with a field error instead of producing a 1024x1024 image. The server action
              advertises the same shape (`src/app/p/[projectSlug]/media/actions.ts:37` types
              `aspect?: ImageAspect`), so a type-correct caller gets "Check the highlighted
              fields." It is not reachable from the shipped dialog, which always sends an aspect,
              and every call site across the new tests passes `aspect: "square"` explicitly, which
              is why nothing caught it.
      owed:   `aspect: z.enum(IMAGE_ASPECTS).default(DEFAULT_IMAGE_ASPECT)` (or `.optional()` with
              the default applied in `generateImage`), plus one assertion that a request with no
              aspect succeeds and maps to the square size.
      traces: FR-008, spec.md Key Entities ("square when unstated")

- [ ] MINOR F4 — `getImageProvider` is dead code, and it carries a second copy of the missing-settings rule
      where:  src/server/llm/image-provider.ts:75, src/server/llm/image-provider.ts:81
      why:    `grep -rn getImageProvider src tests` finds no caller: the live path resolves through
              `createImageProviderForConfig` from `src/server/llm/resolve.ts:138,153`, and the page
              gate uses `getImageStatus`. So the function, its `cached` memo (lines 47, 86-89) and
              its `ImageNotConfiguredError` expansion are never exercised — and lines 81-83
              duplicate `missingLlmImageSettings` (`src/server/llm/resolve.ts:158-162`) verbatim.
              Two copies of one rule, one of them unreachable: a future change to what a lone
              `LLM_IMAGE_PROVIDER` problem expands to will be made in one place and silently not
              the other.
      owed:   Delete `getImageProvider` and its cache, or have it call `missingLlmImageSettings` so
              the rule exists once.
      traces: constitution IV ("no duplicated logic per caller")

- [ ] MINOR F5 — `imageGenerationEnabled` checks `media:["view"]`, not the permission its own comment names
      where:  src/server/services/media-generate.ts:20
      why:    The function is documented as "Whether the Media page may offer the action at all"
              but tests `scope.can({ media: ["view"] })`, which every editor has
              (`src/server/auth/access.ts:57`), so it returns `true` for an editor. The gate is
              only correct because `src/app/p/[projectSlug]/media/page.tsx:60` separately ANDs
              `scope.can({ media: ["generate"] })` — the authorization half of the gate lives in
              the caller while the function's name and comment claim it. A second caller that
              trusts the name would offer an editor a control the server then refuses.
      owed:   Check `media: ["generate"]` inside `imageGenerationEnabled` (the page's `&&` then
              becomes belt-and-braces rather than load-bearing), or rename it to say it reports
              configuration only.
      traces: FR-031, G23

- [ ] MINOR F6 — Two assertions do not test what their names claim, so the library's limit sentence and the credit sentence go unasserted
      where:  tests/integration/media/generate.test.ts:68, tests/integration/llm/image-hold.test.ts:56
      why:    `generate.test.ts:64-70` is named "rejects oversized bytes from the provider without
              orphaning a storage object" and feeds `Buffer.alloc(21 * 1024 * 1024, 1)`, but
              asserts only `expect(result.ok).toBe(false)`. That passes for any rejection reason —
              `unsupported_type`, `unreadable`, a thrown error — so it does not show US1-6's "the
              library's own existing limit sentence". The behaviour is in fact right:
              `processUpload` checks `bytes.length > maxBytes` before sniffing
              (`src/server/media/process.ts:53-55`), so the real answer is `too_large` with "The
              file is larger than 20 MB." — the test just never looks. Likewise
              `image-hold.test.ts:52` is named "... and returns the fixed sentence" and asserts
              only `result.ok === false`, never comparing against
              `imageFailureMessage("credit_exhausted")`.
      owed:   Assert the message in both: the `too_large` sentence in the first,
              `imageFailureMessage("credit_exhausted")` in the second.
      traces: FR-022, US1-6, US3-1

- NOTE F7 — The provider-swap test cannot prove what it claims. `LlmImageProviderName` is the
  closed union `"openai"` (`src/server/llm/config.ts:12`), so the "non-OpenAI stub" at
  `tests/integration/media/generate-provider-swap.test.ts:28-29` still declares
  `name: "openai" as const` and `provider: "openai" as const` — its own comment ("carrying none of
  OpenAI's vocabulary") is not true of the value it builds. SC-007 still holds on the evidence that
  matters (the T043 grep finds no pixel size, `b64_json` or `output_format` outside
  `openai-image.ts`, and `--stat` shows zero changes to the media library, UI, hold, ledger or
  contract), but a real second-vendor proof needs the union widened — which is itself the
  one-file-plus-config change SC-007 describes.

- NOTE F8 — One spec edge case is deliberately contradicted, and spec.md was never updated.
  spec.md:202 says a half-configured image group leaves "image generation off while everything
  else keeps working"; the shipped behaviour stops startup with the name and the reason
  (`src/server/startup/validate.ts:21`, `src/server/llm/config.ts:126-134`). plan.md:281-289
  resolves this in FR-005's favour (P2 — one rule, not two), and I agree with the resolution; it is
  recorded here only so the next reader does not take that spec line as a defect report.

- NOTE F9 — Provenance survives a delete, because the row does. `deleteMedia` soft-deletes
  (`src/server/services/media.ts:435`), so `generation_prompt` stays in `media_assets` after an
  asset is "deleted"; `tests/integration/media/generated-is-ordinary.test.ts:100` asserts
  read-invisibility, not removal. That is exactly the spec's own rule ("exactly the existing media
  deletion rules apply … provenance adds no new deletion case"), so it is not a defect — it does
  mean an operator asked to erase a prompt has to go where the soft-deleted rows live.

- NOTE F10 — `wrap` and `wrapImage` (`src/server/llm/usage.ts:43-61`, `62-80`) have byte-identical
  bodies; only the parameter type differs. Sanctioned by plan P8 and harmless today, but the two
  will drift the first time the buffered row shape changes. One generic helper over
  `{ usage, latencyMs, provider, model, ok }` would collapse them.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001…FR-038) | 38 | 35 | 3 | 0 | 0 |
| Success criteria (SC-001…SC-010) | 10 | 9 | 1 | 0 | 0 |
| Constitution principles (I…VII) | 7 | 6 | 1 | 0 | 0 |

Partial: **FR-008** (optional `aspect` has no default — F3), **FR-031** (positive half unverified —
F2), **FR-033** (success outcome not announced — F1), **SC-001** (never executed end to end — F2),
**constitution II** (the P1 page flow has not run, by test or by hand — F2). Everything else
carries a citation above or in the file list. The two guards FR-003 and FR-004 name
(`no-model-literal.test.ts`, `key-reads.test.ts`) I ran, and they are green unchanged; the
`llm_usage_purpose` widening is closed by `no-missing-usage-purpose.test.ts`, whose second test now
passes because `label: "image.generate"` exists at `src/server/services/media-generate.ts:57`.

Swept per the constitution's exhaustive-first-review list, with nothing found worth reporting:
**concurrency and locking** — no locks taken, and each request gets its own `randomUUID` and
`mediaKeys` prefix (`src/server/services/media.ts:216-217`), so two simultaneous generations for
one project cannot collide; **idempotency and retries** —
`maxRetries: opts.maxRetries ?? 0` (`src/server/llm/openai-image.ts:53`), asserted at
`openai-image.test.ts:100`, and there is no queue, no tick and nothing claimable;
**authorization and project scoping** — `requirePermission` runs first,
`createImageGenerator` refuses a foreign `projectId`, and `generateImage` ignores any
caller-supplied project entirely (it only ever reads `scope.project.id`), while `media:["generate"]`
is absent from the API-key grant map (`src/server/dal/scope.ts:80`), so no key can reach it;
**time zones and DST** — `generated_at` is `timestamptz` taken from `clock.now()` and no wall-time
arithmetic exists in this feature; **error, timeout and ambiguous paths** — every
`LlmFailureKind` has a sentence and is exercised by `it.each(LLM_FAILURE_KINDS)`
(`tests/integration/media/generate.test.ts:56`), and a timeout clears the hold rather than setting
it (`src/server/services/generation/credit.ts:14-18`); **secrets in logs and responses** — the key
is read only in `config.ts` and decrypted only in `resolve.ts`, both guards unchanged, `logLlmCall`
emits fixed fields only, and both the secret scan and the all-tables plaintext scan were extended
rather than exempted.

## What I could not check

- **The real app.** No browser, no `pnpm dev`, no funded key. The live-region behaviour in F1, the
  focus trap and return, visible focus on the segmented control, and the new tile appearing without
  a reload are all reasoned from source and from the shared components' own code, not observed.
  T045 is still owed and is the only thing that closes this.
- **The Postgres-backed integration suite, `pnpm build` and `pnpm db:check`.** Not re-run here, per
  the constitution's review rule; T044 records them green on this commit, and no PR exists yet, so
  there is no CI run to read either. Note that local runs are weaker than CI on this repo, and that
  the integration suite needs the test database on port 5555.
- **A real provider response.** Every image in every test comes from a stubbed `ImageProvider` or
  from `createFakeLlmFetch`; the adapter's `size`, `output_format: "png"` and `b64_json` handling is
  verified against the installed SDK's declarations and mocked HTTP only — "verified with mocks
  only" in the constitution's sense. Whether the configured model actually accepts `output_format`
  is untested against the live endpoint, and the two refusal marker sets ship deliberately empty
  (plan P6), so a real content refusal will surface as `bad_request` until someone observes the
  marker and adds it.
- **FR-023's discard path for a generated asset specifically.** The code is the untouched
  `uploadMedia` catch (`src/server/services/media.ts:290-295`), and the refusal tests prove no
  object is written when the rejection happens before `storage.put`, but no test forces a
  *row-write* failure after both objects are already stored on the generated path.
- **Whether `drizzle/meta/0028_snapshot.json` matches the schema.** That is `pnpm db:check`'s job
  and I did not re-run it; I read the hand-written SQL instead, and it matches
  `src/server/db/schema/media.ts` constraint for constraint.
