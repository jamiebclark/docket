# Review: TikTok provider (026), third review, after the second remediation

Reviewed 107 files changed across 10 commits plus the working tree, against `bbb9d30...HEAD` (the merge base with `origin/main`), with the uncommitted working tree on top.

**What the second remediation changed.** T058 and T059 are uncommitted. They touch three paths: `.env.example`, `tests/integration/limits/enforcement.test.ts` and `specs/026-tiktok-provider/tasks.md`. The evidence for this round is therefore `git diff` (working tree against HEAD) on top of `bbb9d30...HEAD`. HEAD itself has not changed since the second review, apart from that review's own commit (`7d1ce7d`).

This is a **re-review**. The constitution limits it to two things:

- confirming that each earlier blocking finding (F13 and F14) is fixed;
- confirming that the files the remediation changed introduced no regression.

Anything else is recorded as MINOR.

**Read in full:**

- the whole working-tree diff: `.env.example:311-326`, `tests/integration/limits/enforcement.test.ts:147-185` and `specs/026-tiktok-provider/tasks.md:185-188`;
- `tests/lint/env-coverage.test.ts` (all of it);
- the implement pass's final message (`specs/026-tiktok-provider/.pipeline/implement.result.json`).

**Sampled:**

- `src/providers/tiktok/validate.ts:12-30`, `src/providers/types.ts:332` (the issue `field` union) and `src/server/services/posts/index.ts:61-63`, `:462-536` (the `addToQueue` result shape);
- the other readers of `.env.example`: `tests/integration/docs/{tiktok,x,threads}-docs.test.ts` and `src/providers/registry.test.ts:184-192`.

**Not reviewed:**

- The other 104 files were not re-read. Rounds 1 and 2 read them, the remediation did not touch them, and the constitution scopes this round to the remediation.
- `drizzle/meta/0018_snapshot.json` (generated) and the `specs/**` inputs were also skipped.

**Checks I ran.** A Postgres is reachable on `:5433`.

- `pnpm vitest run tests/lint/env-coverage.test.ts`: **6 of 6 passed**. In round 2 this failed with 8 problems.
- `pnpm vitest run tests/integration/limits/enforcement.test.ts`: **173 of 173 passed**. In round 2, 7 failed.
  - A verbose run filtered to "video adapt rows" shows all 7 `tiktok:` adapt rows passing.
- **A probe on a throwaway copy of the enforcement test.** The copy lived in `$TMPDIR` and is now deleted; nothing was written in the tree. It logged what each TikTok adapt row's `addToQueue` actually returns.
  - All 7 return `{ ok: false, code: "validation" }`.
  - The only `error` in each is `posting_required` on field `posting`.
  - The media issues are all `info` on `media.0`: `video_will_reencode`, `video_will_cut`, `video_will_resize` and `video_will_change_frame_rate`.
  - So the new assertion runs against real issues; it does not pass vacuously on today's data (see F21 for the case where it could).
- The other readers of `.env.example`: `tiktok-docs`, `x-docs`, `threads-docs` and `src/providers/registry.test.ts`. **4 files and 35 tests, all passed.**
- `tests/integration/media/video-publish-adapted.test.ts`, the F18 flake: **passed** when run alone.
- `npx tsc --noEmit`: no errors. `npx eslint tests/integration/limits/enforcement.test.ts`: no problems.
- `gh api repos/jamiebclark/docket/commits/main`: main is still `24e199f`. `gh pr list --head 026-tiktok-provider --state all` returned nothing, so CI has never run on this branch.
- `git diff --name-only bbb9d30 24e199f`: main's 6 changed files share none of the remediation's paths.

**Checks I did not run:**

- The full suite, `pnpm lint`, `pnpm build` and `pnpm db:check`. The constitution says review does not re-run them, and the remediation is a comment-only `.env.example` change plus one test assertion. No schema, route or config changed.
- `git merge-tree --write-tree`: the sandbox's permission classifier refused it. Round 2's clean merge-tree result on HEAD still applies, and main has not touched the remediation's files.

## Verdict

**Ready to merge. There are no blocking findings.** Both round-2 blockers are fixed, and the remediation introduced no regression.

- **F13 (env-coverage):** fixed. The TikTok variables in `.env.example` now carry their own description, marker and default.
- **F14 (limits enforcement):** fixed. For a provider that declares posting fields or consent, the gate check now asserts that nothing blocks on media and that every blocker is a posting or consent issue. Every other provider still has to queue with `{ ok: true }`.

Both deterministic `pnpm test` failures from round 2 now pass. With them gone, the round-2 full run's only remaining failure is the F18 flake, which passes alone.

Two MINOR items are new in this round:

- **F20:** the remediation is uncommitted. The roadmap's auto-merge step will commit it before the push.
- **F21:** the new TikTok branch of the assertion would also pass on a refusal that carries no issues.

Neither blocks. The round-1 and round-2 MINORs (F6–F10, F15–F17) remain open for the hardening entry.

CI on the pull request will be the first full `pnpm test` that includes this remediation, so a human should look at it before merging.

## Findings

### Earlier blocking findings

- [x] MAJOR F1–F5 (round 1): fixed, as confirmed in round 2. The remediation did not touch their files: `src/providers/tiktok/{publish,posting}.ts`, `src/components/compose/PostingFieldsPanel.tsx`, `tests/integration/tiktok/failures.test.ts` and `docs/limits.md`.
      where:  src/providers/tiktok/publish.ts:124-147, src/providers/tiktok/posting.ts:87-92, tests/integration/tiktok/failures.test.ts:208-277, docs/limits.md:208-212

- [x] MAJOR F13 — fixed. Each TikTok variable has its own documented block in `.env.example`.
      where:  .env.example:316-318, .env.example:320-322, .env.example:324-326, tests/lint/env-coverage.test.ts:70-85
      check:  `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` are each preceded by:
              - a `Group.` description;
              - `No default.`;
              - for the secret, "Never logged."

              `TIKTOK_APP_AUDITED` is preceded by `Optional.`, a description of at least 20 characters and `Default false.`. The X block at `.env.example:303-309` has the same shape.

              The section header and the three explanatory lines at `:311-314` are kept. The test's backward scan stops at the first non-comment line, so each block is now judged on its own.

              `env-coverage.test.ts` passes 6 of 6. `docker-compose.yml` is unchanged, so operators need no compose edit.

- [x] MAJOR F14 — fixed. The generic "video adapt rows" gate check now accepts a TikTok refusal caused only by posting fields or consent, without weakening the check for the other providers.
      where:  tests/integration/limits/enforcement.test.ts:178-183, src/providers/tiktok/validate.ts:27-28
      check:  When `provider.posting || provider.consent` is set, the test collects the `error` issues and makes two assertions:
              - none of them is on `media` or `media.*` (`:181`);
              - every one of them is on `consent`, `posting` or `posting.*` (`:182`). This also catches a `text` or `postType` blocker.

              Every other provider still asserts `{ ok: true }` (`:183`), and `validate.ts` is unchanged, as T059 required.

              173 of 173 pass. The probe confirms that the TikTok rows reach this branch with real data: `posting_required` is the only error, and the adapted-media issues are `info` on `media.0`.

### Still open from earlier rounds (MINOR; the remediation did not touch their files)

- [ ] MINOR F6 — A new TikTok target in the composer says "Open this post in the composer…".
      where:  src/providers/tiktok/validate.ts:27-28, src/server/services/posts/compose.ts:143
- [ ] MINOR F7 — The unaudited explanation drops "only the account owner can see it" from the D6 and FR-018 text.
      where:  src/providers/tiktok/posting.ts:75
- [ ] MINOR F8 — The generic `PostingFieldsPanel` hard-codes "Read how TikTok's audit works".
      where:  src/components/compose/PostingFieldsPanel.tsx:48
- [ ] MINOR F9 — Some consent paths have no test:
      - approve, and retry without consent;
      - staleness after an override, or after a media or video-edit change;
      - US2 #9 through the services.
      where:  tests/integration/posts/consent.test.ts:86-97, tests/integration/posts/consent.test.ts:124-135
- [ ] MINOR F10 — `fitState` is called only by its test.
      where:  src/providers/tiktok/state.ts:103, src/providers/tiktok/state.test.ts:70
- [ ] MINOR F15 — A may-publish step with unreadable credentials or no TikTok configuration returns `ambiguous`, although nothing was sent. The message also says "Reconnect" twice.
      where:  src/providers/tiktok/publish.ts:124, src/providers/tiktok/publish.ts:128-130, src/server/scheduler/publishing.ts:524-525
- [ ] MINOR F16 — Three FR-038 tests are weaker than their names:
      - the final-`PUT` "times out" case models a refused connection;
      - the refused-refresh case asserts only `not.toBe("published")`;
      - the unit test that routes `check_status` before the config check uses a null state.
      where:  tests/integration/tiktok/failures.test.ts:209-215, tests/integration/tiktok/failures.test.ts:262-276, src/providers/tiktok/publish.test.ts:212-216
- [ ] MINOR F17 — TikTok has no platform mark, so it shows the offline mock's flask glyph.
      where:  scripts/generate-icons.mjs:51-57, src/components/ui/Icon.tsx:45-56

### New in this round

- [ ] MINOR F20 — The second remediation (T058, T059) is uncommitted, though both tasks are ticked
      where:  .env.example:316-326, tests/integration/limits/enforcement.test.ts:178-183, specs/026-tiktok-provider/tasks.md:187-188
      why:    The constitution's Development Workflow says "Commit after each completed task". The implement pass's final message says: "The only after-implement hook is the optional auto-commit; I didn't run it, so nothing is committed."

              `git status --short` shows exactly these three paths modified. HEAD still contains the `.env.example` block that fails `env-coverage`, and still has no `enforcement.test.ts` change. A push of HEAD alone would therefore be red on exactly F13 and F14.

              This is the same problem as round 1's F3. It is MINOR here for two reasons: the re-review rule, and a mitigation. spec-roadmap's auto-merge (`lib/roadmap.sh:483-495` in the speckit-pipeline plugin) commits every path the pipeline left uncommitted before it pushes.
      owed:   before pushing, commit the three paths explicitly, for example:
              ```
              git add .env.example tests/integration/limits/enforcement.test.ts specs/026-tiktok-provider/tasks.md
              git commit -m "fix(tiktok): document TikTok env vars and make the limits gate test posting-aware"
              ```
              Otherwise, accept the auto-merge sweep commit.

- [ ] MINOR F21 — The new TikTok branch of the "video adapt rows" assertion would also pass a refusal that carries no issues
      where:  tests/integration/limits/enforcement.test.ts:180-182, src/server/services/posts/index.ts:61-63, src/server/services/posts/index.ts:502-515
      why:    `blockers` comes from `queued[0].issues ?? []`. Some refusals return `{ ok: false, code, message }` with no `issues`:
              - a `queueableGate` block;
              - a non-validation `gate` failure;
              - a slot-allocation failure from `allocateNextFree`.

              On any of these, `blockers` is empty and both `expect`s pass, although the media was never judged.

              Today this does not happen: the probe shows every TikTok row returning `code: "validation"` with `posting_required`. But a later change that refused TikTok targets earlier would leave these 7 rows green without checking anything.
      owed:   on the posting or consent branch, also assert
              `expect(queued[0]).toMatchObject({ ok: false, code: "validation" })`
              and that at least one blocker is present, for example `expect(blockers.length).toBeGreaterThan(0)`.

- NOTE F22 — T051's `🛑 BLOCKED` reason is out of date: it says "no Postgres on :5433", but rounds 2 and 3 both ran Postgres suites here (`specs/026-tiktok-provider/tasks.md:149`).
      - **What the evidence shows:** round 2's full run found 9 failures. Seven were F14 and one was F13, and both are now fixed. The ninth is the F18 flake, which passes alone.
      - **What is still missing:** no one has run the full `pnpm test` since this remediation, so T051 is not literally done. The implement phase owns it, and CI on the PR is the natural place to close it.

- NOTE F12 — The round-1 concurrency note still holds. No remediation touched the consent seam (`src/server/services/posts/consent.ts`, `src/server/scheduler/publishing.ts:408-425`).

- NOTE F18 — `tests/integration/media/video-publish-adapted.test.ts:60` passed alone again this round. It has no TikTok code. If CI fails on it, re-run before blaming this branch.

- NOTE F19 — `origin/main` is still `24e199f` (PR #48). Its 6 changed files (connect cards, activity summary, user menu, and two tests) do not overlap the remediation, and main has not used migration number `0018`.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-043) | 43 | 43 | 0 | 0 | 0 |
| Success criteria (SC-001–SC-008) | 8 | 8 | 0 | 0 | 0 |
| User stories (US1–US7) | 7 | 7 | 0 | 0 | 0 |
| Spec decisions (D1–D16) | 16 | 16 | 0 | 0 | 0 |
| Constitution principles (I–VII) and workflow | 8 | 7 | 1 (workflow: commit per task, F20) | 0 | 0 |
| Round-2 blocking findings (F13, F14) | 2 | 2 fixed | 0 | 0 | 0 |
| Remediation files (working tree) | 3 | 3 clean (F21 is a strength gap, not a regression) | 0 | 0 | 0 |

Three items that were partial in round 2 are now satisfied:

- **FR-002 and constitution VII:** `.env.example` now documents every TikTok variable, and `env-coverage` passes.
- **FR-030:** the TikTok limits rows' cited enforcement tests pass.
- **SC-008:** both inventory suites pass with TikTok registered.
  - The env inventory is `tests/lint/env-coverage.test.ts`; the limits inventory is `tests/integration/limits/enforcement.test.ts`.
  - The doc-inventory, doc-link and no-secrets suites passed in round 2 and were not touched.
  - Existing providers' rows in `enforcement.test.ts` still assert `{ ok: true }` and pass.

**Two caveats on these ratings:**

- **SC-008** rests on round 2's full run plus this round's targeted runs over every test that reads the changed files. It does not rest on a fresh full run.
- **Constitution workflow row:** apart from F20, the CI-green gate is not yet demonstrated, because no PR exists. Locally, every check named in the round-2 findings now passes.

## What I could not check

- **CI on a pull request:** there is none. It will be the first run that includes the second remediation of:
  - the full `pnpm test`;
  - `pnpm lint`;
  - `pnpm build`;
  - the Docker image build;
  - `pnpm db:check`;
  - commitlint on the auto-merge commit.
- **A fresh `git merge-tree` against `origin/main`:** the sandbox's classifier refused it. I relied on round 2's clean result, and on main not touching the remediation's files.
- **The composer in a browser:** keyboard use and focus on the creator-disabled toggle that is now operable, how its help text reads next to the error, and the Retry flow. Unchanged since round 2.
- **Anything live at TikTok** (T052, quickstart §8): the reply envelope, chunk `PUT` repeat semantics, photo field names, the branded-content rule, and whether consent at scheduling passes TikTok's audit. All are verified with mocks only, by design (D16).
- **A 1 GiB upload at the default 10-second step limit:** this needs an operator to measure it.
- **Whether `docs/tiktok-setup.md` alone gets an operator to a connected account (SC-007):** its links resolve, but only a person following it can confirm.
