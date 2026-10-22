# Review: Threads replies and mentions land in the inbox

Reviewed 38 file(s) changed across 9 commit(s), against
`e3262fb9651e2d7f80f967d2845b8242023ca5c7...HEAD` (28 of those files outside `specs/`).

Read in full: `src/providers/threads/engagement.ts`, `src/providers/threads/engagement.test.ts`,
`src/providers/threads/index.ts`, `src/lib/docs.ts`, `src/lib/docs.test.ts`,
`src/server/dal/engagement-read-claims.ts`, `src/server/scheduler/engagement-read.ts`,
`src/server/services/accounts.ts`, `src/app/p/[projectSlug]/inbox/page.tsx`,
`src/app/p/[projectSlug]/inbox/[itemId]/page.tsx`, `src/app/p/[projectSlug]/accounts/page.tsx`,
`src/components/insights/TargetMetrics.tsx`, `src/components/targets/PerformancePanel.tsx`,
`src/providers/registry.test.ts` (new block), all five new/edited test files, and every one of the
five documentation files. Also read, unchanged, as the context the diff depends on:
`src/providers/registry.ts` (`assertEngagementDeclaration`),
`src/server/services/engagement/inbox.ts` (`resolveParent`, `toView`),
`src/server/dal/targets.ts` (`effectiveContent`), `src/server/scheduler/engagement-send.ts`
(`fatal_error` arm), `tests/integration/engagement/scope-gate.test.ts`,
`tests/integration/engagement/provider-seam.test.ts`,
`tests/integration/docs/published-docs.test.ts`, `tests/setup/global-setup.ts` and
`tests/setup/worker-db.ts`.

Sampled: `src/providers/bluesky/engagement-map.test.ts` (the pre-existing parentless-mention
mapping proof), `docs/decisions.md` (the new `## 086` section only).

Not reviewed: the 10 spec artefacts under `specs/086-…/` were read as the obligation inventory, not
judged as deliverables; `CLAUDE.md`'s one-line SPECKIT pointer is tooling-owned.

## Verdict

The work is honest, well-aimed and almost entirely sound: the Threads declaration says exactly what
the research supports and no more, the no-call guarantee is real (no Threads import, no state row, no
claim, no decrypt) and is proven by a tick that fails if `fetch` is touched, the three parent
contexts are now genuinely three in the view as well as in the service, and the documentation closes
the roadmap with a verdict and a reason for every surface it set out to fill. The `docsHref` fix is a
net simplification that repairs a link broken since 085, and the panel tests now expect the repaired
URL. **One defect blocks the merge, and it is a cross-pass one of exactly the kind this phase exists
to catch**: the new `counts.unavailable` contribution is a *global, cross-project* count, and an
existing test one directory away asserts that same field is `0`. I reproduced the failure directly
(see F1) — it is not theoretical, and it means `pnpm test` cannot be relied on to go green. Fix F1
(a two-line change in the existing test, plus restoring the exact assertion in this entry's own
test), and this is ready to merge; the three MINORs are small, real, and worth taking in the same
pass rather than deferring.

## Findings

- [ ] 🛑 BLOCKER F1 — `counts.unavailable` is now a global cross-project count, and
      `scope-gate.test.ts` asserts it is zero, so `pnpm test` fails whenever any active Threads
      account exists in the same worker database
      where:  src/server/scheduler/engagement-read.ts:66, src/server/dal/engagement-read-claims.ts:132,
              tests/integration/engagement/scope-gate.test.ts:413
      why:    `countAccountsOnUnavailableEngagement(["threads"])` counts **every** active,
              non-removed Threads account in the database, across all projects — correctly, by
              design, mirroring `countAccountsMissingEngagementScopes`. But
              `tests/integration/engagement/scope-gate.test.ts:413` asserts
              `expect(counts.unavailable).toBe(0)` on a real `runEngagementRead`, and the test
              database is **not** truncated between files: `tests/setup/global-setup.ts` makes one
              clone per worker (4 by default) and ~200 of the suite's 817 files accumulate rows in
              each. Thirteen test files create a Threads account
              (`tests/helpers/threads-publish.ts`, `tests/integration/threads/connect.test.ts`,
              `tests/integration/insights/four-platform.test.tsx`, this entry's own two, and more),
              and `parkAllEngagementReads` — the guard this file already uses against exactly this
              class of leakage — only moves `read_not_before`, so it does not affect a `count(*)`.
              Before this entry `counts.unavailable` could only be raised by an account this file's
              own tick claimed, so the assertion was stable.
              **Reproduced, not inferred**: `KEEP_TEST_DB=1 DOCKET_TEST_WORKERS=1 pnpm vitest run
              tests/integration/engagement/threads-unavailable.test.ts` leaves one
              `provider_key='threads', status='active', removed_at IS NULL` row in `..._w1_test`;
              re-running `scope-gate.test.ts` against that database
              (`DOCKET_SKIP_DB_SETUP=1 DATABASE_URL=..._w1_test`) fails with
              `AssertionError: expected 1 to be +0` at `scope-gate.test.ts:413` — with line 412
              passing, so this is the new breakage in isolation from the pre-existing flake beside
              it. Whether it fires in a given run depends on which files share a worker database,
              which is why Phase 7's single full-suite run did not show it: that run died on line
              **412** first (`accountsSkippedNoPermission` 55 vs 1 — the same shared-state class, but
              pre-existing and not caused by this entry), and after the fixes only the two affected
              files were re-run, never the whole suite.
      owed:   Make `scope-gate.test.ts:413` order-independent — its intent is "the skipped-permission
              count stays distinct from unavailable", which a baseline delta or a direct
              `countAccountsOnUnavailableEngagement` comparison expresses without asserting a global
              zero. Then restore the exact assertion in
              `tests/integration/engagement/threads-unavailable.test.ts:54,85`, which was weakened to
              `toBeGreaterThanOrEqual(1)` for this same reason and so can no longer detect
              over-counting (T014 specified `=== 1`). Do not narrow the production count: it is
              correct as written and FR-016 wants it.
      traces: FR-016, SC-002, constitution → Development Workflow → Quality gates (`pnpm test` green
              before merge), constitution II

- [ ] MINOR F2 — the resolved-parent arm renders the post's text with no fallback, so a brand post
      with an empty caption shows "On your post" above a blank line
      where:  src/app/p/[projectSlug]/inbox/[itemId]/page.tsx:70
      why:    `EffectiveContent.text` is `overrideText ?? baseText` and `posts.base_text` is
              `DEFAULT '' NOT NULL` (`src/server/db/schema/posts.ts:65`), so a media-only post —
              allowed: `ProviderCapabilities` has `media.required` and `textOnlyAllowed` but no
              text-required flag — resolves to `{ kind: "docket_post", text: "" }` in
              `resolveParent` (`src/server/services/engagement/inbox.ts:93`), which is truthy, so
              state A is entered with nothing to show. The replaced code guarded this with
              `?? item.parent.externalId ?? "—"`; the three-arm render dropped it because
              contracts/parent-context.md §5 reasoned "in A the text is resolved or the item is in
              B", which does not hold for the empty string. Twelve lines below, the same file already
              handles the identical case as `{item.text || "(no text)"}` (:82), so the feature is
              inconsistent with itself.
      owed:   Give the A arm the same `||` fallback the item's own text uses, or fall through to the
              external reference. A blank body under a heading is the "shown as a blank" SC-004 rules
              out.
      traces: FR-021, SC-004

- [ ] MINOR F3 — FR-015's two precedence guards are dead branches that no test exercises; both tests
      that cite FR-015 pass unchanged if the guards are deleted
      where:  src/app/p/[projectSlug]/accounts/page.tsx:239,
              src/app/p/[projectSlug]/inbox/page.tsx:93, src/app/p/[projectSlug]/inbox/page.tsx:97,
              tests/integration/accounts/accounts-page-engagement.test.ts:53,
              tests/integration/engagement/threads-unavailable.test.ts:90
      why:    For Threads the permission notice can never render anyway:
              `engagementPermissionForAccount` returns `null` the moment `readScopes` is empty
              (`src/server/services/accounts.ts`), and the registry refuses `unavailable` +
              `readScopes` together. So `expect(html).not.toContain("Inbox needs a reconnect")` and
              `expect(afterView?.readPermission).toBeNull()` both pass against a build with no guards
              at all — they assert the invariant, not the guard. contracts/parent-context.md §6.3
              anticipated this precisely ("the render does not depend on it... built with
              `registerTestProvider`, which bypasses `assertEngagementDeclaration` — which is exactly
              why the guards are worth having") and prescribed one test per guard; neither was
              written. FR-033 asks for every behaviour to be demonstrated by a test, and this one is
              not.
      owed:   One `registerTestProvider` fixture declaring both `unavailable` and a non-ok read
              permission, rendered through each of the two pages, asserting the unavailability wins
              and no reconnect is offered.
      traces: FR-015, FR-033

- [ ] MINOR F4 — `DOC_PAGES` duplicates the `DocPage` union, so a page added to the type but not the
      set silently degrades every provider-declared link on it to the docs root
      where:  src/lib/docs.ts:27, src/lib/docs.ts:53
      why:    `new Set<DocPage>([...])` type-checks whether or not it is exhaustive, so the two lists
              can drift with nothing failing: `docsHref` would return `DOCS_BASE_URL` for a real page
              and the member gets the documentation index instead of the section the declaration
              named. The entry's own test only covers one deliberately-unknown page
              (`src/lib/docs.test.ts:13`), which cannot see drift. Deriving the union from a single
              `as const` array removes the second source of truth entirely — and `docsHref` is now
              the only reader of either, so nothing else has to change.
      owed:   `const DOC_PAGES = [...] as const; export type DocPage = (typeof DOC_PAGES)[number];`
              and drop the duplicate literal list.
      traces: constitution IV (one implementation), FR-003

- NOTE F5 — provider-declared `docsPath` anchors are outside the only test that checks docs links.
  `tests/integration/docs/published-docs.test.ts:27` scans `src/` for literal
  `docsUrl("page", "anchor")` calls and verifies the page and heading exist; it cannot see
  `"meta-setup#engagement"` (`src/providers/threads/engagement.ts:9`, and the same string on
  Facebook and Instagram) because that is a declared string, not a call. The anchor is correct today
  — `docs/meta-setup.md:411` is `## Engagement` — but FR-003's link is now load-bearing for a surface
  whose whole member-visible value is the reason-plus-link, and a renamed heading would dangle it
  silently. Extending that scan to every declared `docsPath` is a one-test hardening job.

- NOTE F6 — no green full suite exists for this branch. Phase 7's single
  `pnpm lint && pnpm typecheck && pnpm test && pnpm build` ended `Test Files 2 failed | 807 passed`,
  `Tests 3 failed | 7640 passed`; two `panel.test.tsx` assertions were then corrected and only those
  two files re-run (15 and 10 tests). That is the right economy for a flake, but it means F1 was
  masked rather than absent, and `pnpm test` has not been observed passing end to end on this code.
  CI on the PR is the place to confirm it once F1 lands.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001…FR-035) | 35 | 33 | 2 | 0 | 0 |
| Success criteria (SC-001…SC-008) | 8 | 7 | 1 | 0 | 0 |
| Constitution principles (I…VII) | 7 | 6 | 1 | 0 | 0 |
| User stories (US1…US5) | 5 | 5 | 0 | 0 | 0 |
| Spec edge cases | 8 | 8 | 0 | 0 | 0 |

The two partial FRs are **FR-015** (true by construction, unproven — F3) and **FR-033** (every
behaviour demonstrated by a test: FR-015's guards are not). The partial SC is **SC-004** (three
visibly different contexts, but state A's body can be blank — F2). The partial principle is **II**
(nothing is "working" unless it ran): every behaviour this entry adds did run under test, but the
quality gate it has to pass was reported green on a run that ended with three failures — F6, and F1
is why that matters.

Checks worth recording as genuinely verified rather than asserted:

- **No path from a tick to a Threads call.** `runEngagementRead` filters `unavailable` providers out
  of the rule list before `claimDueEngagementReads` sees it
  (`src/server/scheduler/engagement-read.ts:60`), and `threads-unavailable.test.ts` proves no
  `engagement_account_states` row, no decrypt, `claimed: 0`, and a stubbed `fetch` that would throw.
  `src/providers/threads/engagement.ts:1` imports only `zod`, `../types` and `./settings` — no
  Threads client, so FR-009's "must not depend on an endpoint path" is checkable by reading the
  import list.
- **FR-005 is machine-enforced and the test proves both directions**
  (`src/providers/registry.ts:138`, `src/providers/registry.test.ts:257`): the shipped declaration
  passes, the same declaration plus `readScopes` throws.
- **FR-013 needs no new code, and I confirmed why**: the account filter already excludes unavailable
  accounts (`src/app/p/[projectSlug]/inbox/page.tsx:126`), so declaring Threads is what removes it.
- **FR-008's "never retried" holds at the scheduler, not just the provider**:
  `src/server/scheduler/engagement-send.ts:257` releases the claim as `definite_failure`, rejects the
  draft and never schedules a retry; `flagAccount` is absent from the Threads result.
- **FR-024's provider-independence**: the stored-row proofs run through the mock
  (`tests/integration/engagement/parentless-ingest.test.ts:40`), and the Bluesky half of the spec's
  own independent test is already covered by `src/providers/bluesky/engagement-map.test.ts:28`,
  which asserts a mention maps to `parentExternalId: null`.
- **Constitution V intact**: the diff adds the string `threads` only inside
  `src/providers/threads/**` and test files — the DAL takes provider *keys* computed from the
  registry, so a second unavailable surface needs no further change, and
  `tests/integration/engagement/provider-seam.test.ts:87`'s "no provider key in the seam modules"
  check still holds.
- **The `docsHref` fix changed real behaviour**, not just types:
  `tests/integration/insights/panel.test.tsx:210` and `:232` had to move from
  `pinterest-setup#insights` to `pinterest-setup/#insights`. No `as DocPage` cast survives anywhere
  (`grep -rn "as DocPage" src/` → only the type guard at `src/lib/docs.ts:45`), and every render site
  goes through `docsHref`.
- **FR-025/SC-005 against the roadmap's actual scope**: the roadmap
  (`.specify/roadmaps/read-instagram-comments-facebook-page-co.json`) set out to fill Instagram
  comments, Facebook Page comments, and Threads replies **and** mentions; all four plus Bluesky carry
  a verdict and a reason in `docs/engagement.md:8`, and the DM column is `Not yet` on every row.
- **The declaration's reason is 217 characters** (`src/providers/threads/engagement.ts:5`), inside
  `assertEngagementDeclaration`'s 1–300 bound, and contains none of the words FR-004 forbids.

## What I could not check

- **CI.** No PR exists for this branch, so there is no CI run to read. F1 predicts a `pnpm test`
  failure there; I did not run the full suite myself (constitution: review does not re-run it) and
  instead reproduced the specific failure against a seeded worker database, which is stronger
  evidence for F1 but says nothing about the other 816 files.
- **The browser.** Every UI claim here is from `renderToStaticMarkup` output and from reading the
  JSX — SC-001's "within one screen", the muted-text styling of the parentless block, focus order and
  the accounts-page block's position relative to the insights blocks were not seen rendered in a real
  page. The notice wording and the absence of a reconnect control *are* asserted on real markup.
- **The published documentation site.** `docs/meta-setup.md:411`'s heading slugs to `engagement` by
  the same rule `published-docs.test.ts` uses, but mkdocs builds only in CI, so the live
  `…/meta-setup/#engagement` URL was not fetched.
- **Whether the Threads read endpoints are genuinely unconfirmed.** This phase has no web access, so
  the research verdict the whole entry rests on is taken as given; `docs/research/engagement.md:189`
  now records the 2026-10-19 re-check, what was searched, and the Keyword Search fact found and
  rejected, which is what makes it auditable rather than merely asserted.
- **The empty-caption parent in practice.** F2 is derived from the schema default, `effectiveContent`
  and `ProviderCapabilities` having no text-required flag; I did not publish a caption-less post and
  ingest a comment on it to see the blank line.
