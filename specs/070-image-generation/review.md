# Review: Generate images into the media library, behind the existing ImageGenerator extension point

**This is a re-review after remediation**, and its scope is set by the constitution's own rule:
"a re-review after remediation checks ONLY that each earlier finding is fixed and that the files
changed by the remediation introduced no regression. It does not open new lines of inquiry;
anything else it notices is recorded as MINOR for the hardening entry, not BLOCKER/MAJOR."
The exhaustive first pass over the whole entry is the previous revision of this file, committed as
`8540cd8`; its coverage sweep is carried forward below rather than repeated. This revision judges
`4d98530` ("fix(media): address review remediation findings") against findings F1–F6.

Reviewed against `9a15100...HEAD` (`git merge-base HEAD origin/main`), 13 commits, 68 changed
files (20 of them spec artifacts).

Read in full for this pass: the whole of `4d98530` (6 files), plus the current state of
`src/app/p/[projectSlug]/media/GenerateImageDialog.tsx`, `src/lib/validation/media.ts`,
`tests/integration/media/generate-gates.test.tsx`, `tests/integration/media/generate.test.ts`,
`src/lib/validation/media.test.ts`, and — to judge regression reach and re-confirm the three
carried MINORs — `src/server/services/media-generate.ts`, `src/server/llm/image-provider.ts`,
`src/server/llm/openai-image.ts`, `src/server/llm/image-generation.ts`, `src/server/llm/usage.ts`,
`src/server/llm/resolve.ts`, `src/server/llm/config.ts` (diff),
`src/server/services/generation/credit.ts`, `src/server/services/media.ts`
(`prepareUpload`/`commitUpload`/`uploadMedia`), `src/server/media/process.ts:49-68`,
`src/components/ui/{Dialog,LiveRegion,Button}.tsx`, `src/app/p/[projectSlug]/media/page.tsx`,
`src/app/p/[projectSlug]/media/actions.ts`, `src/components/media/MediaCard.tsx` (diff),
`drizzle/0028_ambitious_dazzler.sql` + `src/server/db/schema/media.ts`,
`tests/integration/llm/image-hold.test.ts:40-70`, `tests/helpers/{fake-image,posts-env,images}.ts`,
`tests/helpers/factories.ts:56-74`, `tests/lint/{import-boundaries,ui-limit-literals}.test.ts`,
and `specs/070-image-generation/contracts/{ui,services}.md` plus `plan.md`'s decision tables.

Sampled: the `docs/*` and `.env.example` diffs (unchanged since the first pass, judged there).
Not reviewed again: everything the first pass read and the remediation did not touch — the
provider adapter's own tests, the secret-scan / no-plaintext extensions, `research.md`,
`data-model.md`. `drizzle/meta/0028_snapshot.json` (8,663 generated lines) is still unread; the
hand-written SQL was read instead.

**Verification run** (targeted, per the constitution's review rule — not the full suite):
`npx vitest run src/lib/validation/media.test.ts tests/integration/media/generate-gates.test.tsx
tests/integration/media/generate.test.ts` against the local Postgres on port 5555 —
**3 files, 40 tests, all passing**. Those are exactly the three files `4d98530` changed, so the
remediation's own claims ran rather than being read. Lint, typecheck, `pnpm build`, `pnpm db:check`
and the rest of the suite were not re-run (T044 records them green on this code; there is no PR, so
no CI run to read either).

## Verdict

All three MAJOR findings are genuinely fixed, and verified by execution rather than by reading: the
live region now sits outside the `<dialog>` it used to die with
(`GenerateImageDialog.tsx:61` is a sibling of the `<Dialog>` that opens on line 62); the gate suite
now has a positive control that renders the Media page as owner *and* as admin, in both the empty
and the populated branch, and asserts the trigger is there (`generate-gates.test.tsx:49-66` — the
first thing in this entry that has ever rendered the page with image generation switched on); and
`generateImageSchema`'s `aspect` carries `.default(DEFAULT_IMAGE_ASPECT)`, so
`generate({ projectId, prompt })` now produces a square instead of a `ZodError`, asserted at both
the schema (`media.test.ts:78-82`) and the service (`generate.test.ts:44-52`). The remediation is
small, surgical and touches nothing it did not need to: two source lines, three test additions and
three task checkboxes. I found no regression — the only non-test source change beyond the schema
default is moving one JSX element up two lines, `sr-only` is `position: absolute` so the moved
element is not a flex item and the page's layout is unaffected, and `generateImageSchema` has
exactly one non-test consumer (`media-generate.ts:37`), which passes `unknown` in and reads the
parsed output, so widening the schema's *input* type breaks nothing.

What remains is six MINORs: the three the first pass raised and deliberately did not append as
tasks (F4–F6, all still exactly as described), and three noticed in this pass and capped at MINOR by
the re-review rule — two of them test-precision gaps that sit right beside the remediation's own
work, one a boundary convention. None of them blocks. `tasks.md` is therefore unchanged, and this
entry is ready for a human to merge, with the browser walkthrough (T045) still the one thing nobody
has done.

## Remediation verification

- [X] MAJOR F1 — **Fixed.** `<LiveRegion>` moved out of `<Dialog>` into the enclosing fragment.
      where:  src/app/p/[projectSlug]/media/GenerateImageDialog.tsx:61
      how:    It is now a sibling of `<Dialog>` (line 62), so it stays mounted and in the
              accessibility tree when `setOpen(false)` runs in the same batch as
              `setAnnouncement("Image added to the library.")` (lines 50-52). `LiveRegion` is a
              bare `div[role=status][aria-live=polite].sr-only`
              (`src/components/ui/LiveRegion.tsx:5-10`), and a closed `<dialog>`'s `display: none`
              can no longer reach it. This now matches every other panel in the codebase
              (`settings/api-keys/ApiKeysPanel.tsx:20`,
              `settings/webhooks/WebhooksPanel.tsx:32`). The new positive gate test renders this
              component for real and passes, which also proves it does not throw on render.
      traces: FR-033, US1-3, constitution "Engineering: accessibility"

- [X] MAJOR F2 — **Fixed.** The gate suite now has a positive control.
      where:  tests/integration/media/generate-gates.test.tsx:49-66
      how:    `it.each(["owner", "admin"])` sets storage on, sets
              `setImageProviderForTests(createFakeImageProvider([]))`, acts as the role, and asserts
              `expect(emptyHtml).toContain("Generate an image")` (line 60) and the same on the
              populated branch after an upload (line 64) — plan P21's "both storage-on branches".
              `grep -rn "Generate an image" src tests` now finds positive assertions, not only
              `not.toContain`. The three negative cases in the same file render the same page
              through the same helper and still pass, which is what gives the positive assertion a
              failing case: the string's presence really does track `canGenerateImage`
              (`page.tsx:60`). `env.admin` exists (`tests/helpers/factories.ts:69-73`) and `png`
              exists (`tests/helpers/images.ts:20`), and the file runs green. See MINOR F7 for the
              one thing this assertion still cannot distinguish.
      traces: FR-031, SC-001, constitution II

- [X] MAJOR F3 — **Fixed.** The optional `aspect` has its documented default.
      where:  src/lib/validation/media.ts:91
      how:    `aspect: z.enum(IMAGE_ASPECTS).default(DEFAULT_IMAGE_ASPECT)`, with
              `DEFAULT_IMAGE_ASPECT` now imported (line 2). `media.test.ts:78-82` asserts
              `safeParse({ prompt: "x" })` succeeds with `aspect === "square"`, and
              `generate.test.ts:44-52` asserts the service reaches the provider with
              `aspect: "square"` when the request omits it — so the mapping to the square size, not
              only the parse, is covered. Rejection of an unknown aspect (`"panoramic"`, line 75)
              and of an absent or over-length prompt still hold; all 13 `generateImageSchema`
              assertions pass.
      traces: FR-008, spec.md Key Entities ("square when unstated")

## Findings

Six MINORs, none blocking. F4–F6 are carried verbatim-in-substance from the first pass (re-confirmed
against the current tree, with line numbers refreshed); F7–F9 are new in this pass and capped at
MINOR by the constitution's re-review rule.

- [ ] MINOR F4 — `getImageProvider` is still dead code, and still carries a second copy of the
      missing-settings rule
      where:  src/server/llm/image-provider.ts:75, src/server/llm/image-provider.ts:81
      why:    `grep -rn "getImageProvider\b" src tests` (excluding
              `createImageProviderForConfig`) finds only the definition — no caller anywhere. The
              live path resolves through `createImageProviderForConfig` from `resolve.ts:138,153`
              and the page gate uses `getImageStatus`. So the function, its `cached` memo (lines
              47, 86-89) and its `ImageNotConfiguredError` expansion never run, and lines 81-83
              duplicate `missingLlmImageSettings` (`resolve.ts:158-162`) verbatim. Two copies of
              one rule, one unreachable: a future change to what a lone `LLM_IMAGE_PROVIDER`
              problem expands to will be made in one place and silently not the other.
      owed:   Delete `getImageProvider` and its cache, or have it call `missingLlmImageSettings`
              so the rule exists once.
      traces: constitution IV ("no duplicated logic per caller")

- [ ] MINOR F5 — `imageGenerationEnabled` still checks `media:["view"]`, so its name over-promises
      where:  src/server/services/media-generate.ts:20
      why:    The function is "Whether the Media page may offer the action at all" but tests
              `scope.can({ media: ["view"] })`, which every editor has
              (`src/server/auth/access.ts:58`), so it returns `true` for an editor. The gate is
              correct only because `page.tsx:60` separately ANDs `scope.can({ media: ["generate"] })`
              — the authorization half lives in the caller while the function's name claims it. A
              second caller that trusts the name would offer an editor a control the server then
              refuses. (The doc comment does say "Needs media:['view']", so the code is honest;
              the name is not.)
      owed:   Check `media: ["generate"]` inside `imageGenerationEnabled` so the page's `&&`
              becomes belt-and-braces, or rename it to say it reports configuration only.
      traces: FR-031, G23

- [ ] MINOR F6 — The library's own too-large sentence is still asserted by nothing
      where:  tests/integration/media/generate.test.ts:77, tests/integration/llm/image-hold.test.ts:56
      why:    `generate.test.ts:73-79` is named "rejects oversized bytes from the provider without
              orphaning a storage object" and feeds `Buffer.alloc(21 * 1024 * 1024, 1)`, but
              asserts only `expect(result.ok).toBe(false)` — which passes for any rejection reason
              (`unsupported_type`, `unreadable`, a thrown error), so US1-6's "the library's own
              existing limit sentence" is never checked. The behaviour is in fact right:
              `processUpload` tests `bytes.length > limits.maxBytes` before sniffing
              (`src/server/media/process.ts:53-55`), so the real answer is `too_large` with
              "The file is larger than 20 MB." — the test just never looks. Correcting the first
              pass on the second half: `image-hold.test.ts:52-58` is still named "... and returns
              the fixed sentence" while asserting only `result.ok === false`, but the
              `credit_exhausted` sentence *is* asserted exactly, in another file
              (`generate.test.ts:65-71`, `it.each(LLM_FAILURE_KINDS)` →
              `toEqual({ ok: false, message: imageFailureMessage(kind) })`). That half is a naming
              mismatch, not a coverage hole.
      owed:   Assert the `too_large` message in `generate.test.ts`; either assert
              `imageFailureMessage("credit_exhausted")` in `image-hold.test.ts` or rename that case
              to what it actually proves (the hold row).
      traces: FR-022, US1-6, US3-1

- [ ] MINOR F7 — The new positive gate assertion matches a string the component renders twice, so
      it proves the component rendered rather than that the trigger exists
      where:  tests/integration/media/generate-gates.test.tsx:60, tests/integration/media/generate-gates.test.tsx:64
      why:    `toContain("Generate an image")` matches the trigger's label
              (`GenerateImageDialog.tsx:59`) **and** the dialog's `title`
              (`GenerateImageDialog.tsx:62`), which `Dialog` renders unconditionally into its
              header `<h2>` whether or not it is open (`src/components/ui/Dialog.tsx:103-119`;
              `open` is applied imperatively in a `useEffect` that never runs under
              `renderToStaticMarkup`). So a regression that deleted the `<Button>` but kept the
              `<Dialog>` would still pass. This is a precision nit, not a hole — the assertion is
              far stronger than the all-negative suite it replaced, and it does prove the gate
              computes `true` and the component renders without throwing, which is what F2 asked
              for.
      owed:   Match something only the trigger produces (e.g. the rendered
              `>Generate an image</button>`, or assert the string occurs twice).
      traces: FR-031, SC-001

- [ ] MINOR F8 — No test ever drives `generateImageAction` to success, so the action's success
      branch — the `refresh()` that FR-034 depends on — has never executed
      where:  src/app/p/[projectSlug]/media/actions.ts:39, tests/integration/media/generate-gates.test.tsx:43
      why:    `grep -rn generateImageAction src tests` finds exactly two test call sites, both in
              refusal states: storage off (line 43) and no image provider configured (line 77).
              The service beneath it is well covered on the happy path
              (`generate.test.ts:33-41` creates the asset and asserts two storage objects), and the
              page render is now covered by F2's fix, but the five lines that join them —
              `runAction` returning `{ ok: true, data: { ok: true, mediaAssetId } }` and the
              `if (result.ok && result.data.ok) refresh()` — are the one seam in the P1 flow with no
              executed case. `refresh()` is mocked in tests (`helpers/actions.cacheModule`), so the
              most a test can prove is that the branch is taken; that is still more than zero.
      owed:   One case in `generate-gates.test.tsx` (or a new `generate-action` test): storage on,
              fake provider returning real PNG bytes, acting as the owner — assert the action
              returns `{ ok: true, data: { ok: true, mediaAssetId: expect.any(String) } }` and the
              asset is listable.
      traces: FR-034, SC-001, constitution II

- [ ] MINOR F9 — `GenerateImageDialog` is the only client component in the repo with a runtime
      value import from `@/server/**`
      where:  src/app/p/[projectSlug]/media/GenerateImageDialog.tsx:9, src/lib/validation/media.ts:2
      why:    Every other `"use client"` file that reaches into `@/server/**` does so with
              `import type`, which erases (18 of them: `Composer.tsx:19`, `MediaPicker.tsx:8`,
              `UploadDropzone.tsx:4`, `TryItPanel.tsx:8`, …). This one imports the values
              `DEFAULT_IMAGE_ASPECT` and `IMAGE_PROMPT_MAX`, pulling
              `src/server/llm/image-generation.ts` into the client bundle. Harmless **today** —
              that module imports nothing and holds four constants and a sentence — but nothing
              guards it: `tests/lint/import-boundaries.test.ts:25-37` covers only
              `src/providers/** → src/server/**` and `src/server/scheduler/** → next/*`, so the day
              someone adds a config read to `image-generation.ts` to derive a default, server code
              follows it into the browser and no test says so. Sanctioned in spirit by plan **P16**
              ("the UI needs the aspect list"), but P16 does not say the vocabulary must live under
              `src/server/`.
      owed:   Either move the four contract constants to `src/lib/` (where `src/lib/validation/media.ts`
              already re-exports their effects) and have the LLM layer import them, or extend
              `import-boundaries.test.ts` with a `"use client"` → non-type-`@/server` rule that
              allow-lists this file.
      traces: constitution VII (defence in depth), constitution "server components by default"

- NOTE F10 — The hint's "Up to 1000 characters" is a literal beside `maxLength={IMAGE_PROMPT_MAX}`
  (`GenerateImageDialog.tsx:73,76`). `contracts/ui.md` § 4 specifies that sentence verbatim, so it
  is as designed, and `tests/lint/ui-limit-literals.test.ts` does not cover this file or this
  constant — but it is the exact class of drift that test exists to prevent.

- NOTE F11 — Carried: the provider-swap test cannot prove what it claims, because
  `LlmImageProviderName` is the closed union `"openai"` (`src/server/llm/config.ts:12`), so the
  "non-OpenAI stub" at `tests/integration/media/generate-provider-swap.test.ts:28-29` still declares
  `name: "openai" as const`. SC-007 still holds on the evidence that matters (the T043 grep finds no
  pixel size, `b64_json` or `output_format` outside `openai-image.ts`, and `--stat` shows zero
  changes to the media library, UI, hold, ledger or contract).

- NOTE F12 — Carried: one spec edge case is deliberately contradicted and `spec.md` was never
  updated. `spec.md:203` says a half-configured image group leaves "image generation off while
  everything else keeps working"; the shipped behaviour stops startup with the name and the reason
  (`src/server/startup/validate.ts:23`, `src/server/llm/config.ts:126-134`). `plan.md:262-269`
  resolves this in FR-005's favour (**P2** — one rule, not two), and I agree with the resolution.

- NOTE F13 — Carried: provenance survives a delete, because the row does. `deleteMedia` soft-deletes
  (`src/server/services/media.ts:435`), so `generation_prompt` stays in `media_assets` after an
  asset is "deleted". That is the spec's own rule ("provenance adds no new deletion case"), but an
  operator asked to erase a prompt has to go where the soft-deleted rows live.

- NOTE F14 — Carried: `wrap` and `wrapImage` (`src/server/llm/usage.ts:43-61`, `62-80`) have
  byte-identical bodies; only the parameter type differs. Sanctioned by plan **P8**, and the same is
  true of `withCreditHold`/`withImageCreditHold` (`generation/credit.ts:25-45`), which at least
  share `applyCreditOutcome`. The two `wrap`s will drift the first time the buffered row shape
  changes.

- NOTE F15 — `plan.md:286-287`'s prose says `NO_REAL_PEOPLE` is "appended by the adapter layer"; the
  code appends it in the service (`media-generate.ts:58`) and `ImageProviderRequest`'s own comment
  says "The adapter appends nothing" (`image-provider.ts:14`). The code matches the binding
  artifact — `contracts/services.md` § 7 step 7 specifies exactly the service-level append — so
  this is loose narrative prose, not a defect, and FR-014/SC-010 hold because `generateImage` is the
  only path to a provider.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001…FR-038) | 38 | 38 | 0 | 0 | 0 |
| Success criteria (SC-001…SC-010) | 10 | 10 | 0 | 0 | 0 |
| Constitution principles (I…VII) | 7 | 7 | 0 | 0 | 0 |

The first pass's sweep stands as the denominator; this pass re-judged only what the remediation
moved. The three obligations it recorded as partial are now satisfied: **FR-008** (F3 — default
applied and asserted at two levels), **FR-031** (F2 — the positive half now has an executed
assertion for owner and admin, in both branches), **FR-033** (F1 — the success announcement can now
reach assistive technology), and with them **SC-001** and **constitution II**, whose only gap was
that the P1 page flow had never been rendered. Two caveats on those marks, both recorded as MINORs
rather than partials because the requirement's code is right and it is the *test* that stops short:
the page render asserts a string the component emits twice (F7), and the server action's success
branch has still never run (F8). Neither leaves a requirement unimplemented.

Not re-swept this pass, by the constitution's re-review rule: concurrency and locking, idempotency
and retries, authorization and project scoping, time zones and DST, error/timeout/ambiguous paths,
and secrets in logs and responses. All six were swept exhaustively in the first pass with nothing
found worth reporting, and the remediation touched none of their code — the only non-test source
changes are one JSX move and one Zod default. The guards FR-003 and FR-004 name
(`no-model-literal.test.ts`, `key-reads.test.ts`) were run green in the first pass on code the
remediation did not touch.

## What I could not check

- **The real app.** No browser, no `pnpm dev`, no funded key. F1's fix is verified structurally and
  by a passing render, but nobody has heard the announcement; the focus trap and return, visible
  focus on the segmented control, and the new tile appearing without a reload are all still reasoned
  from source. **T045 remains owed and is the only thing that closes this** — it is recorded in
  `tasks.md` as unachievable inside an automated pass, so it needs a human.
- **Lint, typecheck, `pnpm build`, `pnpm db:check` and the rest of the suite.** Not re-run here, per
  the constitution's review rule; T044 records them green on this entry's code, and `4d98530`
  changed one JSX line, one Zod call and three test files since. No PR exists, so there is no CI run
  to read. Local green is also weaker than CI green on this repo, and the integration suite needs
  the test database on port 5555 (user `docket`, not `postgres`).
- **A real provider response.** Every image in every test comes from a stubbed `ImageProvider` or
  `createFakeLlmFetch`; the adapter's `size`, `output_format: "png"` and `b64_json` handling is
  "verified with mocks only" in the constitution's sense. The two refusal marker sets ship
  deliberately empty (plan **P6**), so a real content refusal surfaces as `bad_request` until
  someone observes the marker and adds it.
- **FR-023's discard path for a generated asset specifically.** The code is the untouched
  `uploadMedia` catch (`src/server/services/media.ts:295-297`); no test forces a row-write failure
  after both objects are already stored on the generated path.
- **Whether `drizzle/meta/0028_snapshot.json` matches the schema.** That is `pnpm db:check`'s job;
  the hand-written `0028_ambitious_dazzler.sql` was read instead and matches
  `src/server/db/schema/media.ts` constraint for constraint, including the `!~ '\s'` model check
  surviving the TS-template escaping.
- **Whether the three negative gate cases would still fail for the right reason.** I verified the
  positive assertion has a failing case by the file's own negative cases passing, not by inverting
  the gate — this phase may not write code, so I could not mutate `page.tsx:60` and watch the new
  test go red.
