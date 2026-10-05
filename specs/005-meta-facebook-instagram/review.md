# Review: Facebook Pages and Instagram providers (Meta, part 1), second re-review after remediation

**This is a scoped re-review**, as constitution v1.4.0 requires ("Review is exhaustive once, then scoped", `.specify/memory/constitution.md:115-128`). It checks only two things:

- whether the one blocking finding still open after the first re-review (MAJOR F1) is now fixed;
- whether the files the remediation changed introduced a regression.

It opens no new lines of inquiry. Anything new is recorded as MINOR, for the hardening entry.

Earlier review texts are in git:

- the first, exhaustive review is at `b65778d` (`git show b65778d:specs/005-meta-facebook-instagram/review.md`);
- the first re-review is at `489e823`.

Their findings are kept below. A `re-review 2:` line has been added to each finding this pass looked at.

**What I reviewed.** The feature merged to `main` as PR #10 (`4285587`). Later entries 006–010 have also landed on `main`. The remediation for T078 is one commit made directly on `main`:

- `86dc1b7`, "fix(meta): name the needed permissions when a login finds no Pages", which changed `src/providers/meta/connect-group.ts` (+3) and `tests/integration/connect/callback-hint.test.ts` (+7).

So this pass is about one commit and 10 changed lines. I judged F1 against the present state of `main` (HEAD `86dc1b7`). That is the code the person will actually run.

**Read in full:**

- `git show 86dc1b7`;
- `src/providers/meta/connect-group.ts:1-40`;
- `src/providers/meta/candidates.ts:60-77`;
- `src/server/services/connect.ts:295-372`, covering the callback outcome, `back()`, and the paste path's empty list;
- `src/app/connect/callback/route.ts:24`;
- `src/app/p/[projectSlug]/accounts/page.tsx:25-57`;
- `tests/integration/connect/callback-hint.test.ts:40-100`;
- `tests/integration/connect/meta-connect.test.ts:1-20, 70-104`.

**Not re-reviewed:**

- MINOR F3–F5 and NOTEs F6–F7: out of scope for a re-review.
- Everything else 006–010 changed.

**Run:** following the constitution, I did not re-run the full suite, lint, typecheck or build. I ran only the affected tests: `pnpm vitest run tests/integration/connect/{callback-hint,meta-connect,paste}.test.ts tests/integration/meta/engine-unchanged.test.ts src/providers/meta/candidates.test.ts`. That is 5 files and 26 tests, and all of them passed.

## Verdict

**F1 is fixed. No blocking findings remain, so `tasks.md` is unchanged and the feature is ready to merge.**

`metaConnectGroup` now has a `callbackHint` that names all five permissions. The OAuth "no Pages" path goes through these steps:

1. `listPageCandidates` returns an empty list (`src/providers/meta/candidates.ts:72-76`).
2. The callback returns `no_candidates`, together with the stored `groupKey` (`src/server/services/connect.ts:298-303`, `:329`).
3. The route redirects to `?connect=no_candidates&group=meta` (`src/app/connect/callback/route.ts:24`).
4. `page.tsx` adds the Meta hint to the banner (`src/app/p/[projectSlug]/accounts/page.tsx:39`, `:53-57`).

The new render test proves that the banner shows all five permission names for `group=meta`.

Not all of T078 was done. It also asked for two test additions:

- a `groupKey` assertion in the real-Meta-group callback test;
- a real-Meta-group paste case (F8).

Neither was added. Both are test-coverage gaps: the behaviour is correct by reading and is covered generically. They are recorded as MINOR for the hardening entry. T076–T078 are still unticked even though their behaviour has shipped (NOTE F9).

## Findings

- [x] MAJOR F1 — An OAuth login that yields no Pages shows the "check app id/secret/redirect" banner, not the needed permissions
      where:  src/providers/meta/candidates.ts:71-76, src/providers/meta/connect-group.ts:21-23, src/server/services/connect.ts:329, src/app/p/[projectSlug]/accounts/page.tsx:34, src/app/p/[projectSlug]/accounts/page.tsx:53-57
      why:    (first review) An empty `/me/accounts` was mapped to `exchange_failed`. (first re-review) Routing had been fixed to `no_candidates`, but the banner still named no permissions, because `metaConnectGroup` had no `callbackHint`.
      re-review 2: **Fixed.**
        - **The hint now exists.** `86dc1b7` adds a `callbackHint` at src/providers/meta/connect-group.ts:21-23. It names `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic` and `instagram_content_publish`, and it says at least one Page must be selected.
        - **The hint reaches the banner on the real path.** `back()` carries `found.groupKey` (src/server/services/connect.ts:298-303). The route puts it into `&group=` (src/app/connect/callback/route.ts:24). page.tsx:53-57 looks up the registered group's hint for `no_candidates`, `platform_error` and `exchange_failed`.
        - **The tests cover both halves.** That the generic route carries `group` is proven at tests/integration/connect/callback-hint.test.ts:66-71. That the banner shows the Meta permissions is proven at tests/integration/connect/callback-hint.test.ts:88-94, which checks every one of the five names.
        - **The wording reads sensibly after all three banners.** For example, after `exchange_failed`: "…Check the app id, secret and redirect address in the setup guide. Facebook must grant pages_show_list, … and at least one Page must be selected in the login dialog."
        - **The comment is now accurate.** At src/providers/meta/candidates.ts:71, "the callback shows the permissions banner" is true now that the hint exists. No edit was needed.
        - **No regression.** The FR-002 scan (tests/integration/meta/engine-unchanged.test.ts) still passes, because the permission strings live under `src/providers/meta/`, outside the scanned UI roots. The hint-less and unknown-group cases still show no hint (callback-hint.test.ts:95-100).
      traces: Edge case "Person deselects Pages or permissions", US2 AS4, FR-009, contracts/connect.md:68

- [x] MAJOR F2 — The generic connect UI hard-codes Meta's permission names, and the FR-002 guard test does not scan that code
      where:  src/app/p/[projectSlug]/accounts/ConnectGroupSection.tsx:83, tests/integration/meta/engine-unchanged.test.ts:63
      why:    (first review) The generic paste hint appended Meta's five permission names, and the FR-002 scan did not cover the accounts UI.
      re-review: **Fixed** (first re-review). The generic section renders `paste.help` only. The scan roots now include the accounts and connect UI, and the scan forbids `pages_*`/`instagram_*` there.
      re-review 2: `86dc1b7` does not touch these files. engine-unchanged.test.ts still passes.
      traces: FR-002, SC-008, Constitution V

- [ ] MINOR F3 — Facebook attempt summaries leave out the step detail that FR-033 requires, and are inconsistent with Instagram's
      where:  src/providers/facebook/publish.ts:67, src/providers/facebook/publish.ts:75, src/providers/instagram/publish.ts:21-32
      why:    (first review, unchanged, not re-reviewed) Facebook records only `graphSummary`, with no step, image index or photo ids.
      traces: FR-033

- [ ] MINOR F4 — Candidates are not validated or de-duplicated as contracts/providers.md specifies
      where:  src/server/services/connect.ts:157-158, src/server/services/connect.ts:219-237
      why:    (first review, unchanged, not re-reviewed) Only foreign provider keys are dropped. Invalid settings throw inside the chooser transaction, and duplicates are upserted twice. This is latent for Meta.
      traces: contracts/providers.md G5 rules

- [ ] MINOR F5 — decisions.md says expired attempts are purged on callback traffic, but the callback never purges
      where:  docs/decisions.md:263, src/server/services/connect.ts:262-320
      why:    (first review, unchanged, not re-reviewed) This is a documentation inaccuracy, not a leak, because expired rows are unreadable anyway.
      traces: FR-010, FR-040

- [ ] MINOR F8 — No test pastes a token into the real Meta group when `/me/accounts` is empty
      where:  tests/integration/connect/paste.test.ts:13, tests/integration/connect/paste.test.ts:83-88, src/server/services/connect.ts:366
      why:    (first re-review) The paste "no Pages" test stubs a throwaway group that returns `{ ok: false, message: NO_PAGES }`. The real Meta group no longer produces that shape. Behaviour is correct by reading: for an empty list, connect.ts:366 appends `paste.help`, and that text lists the permissions.
      re-review 2: **Still open.** T078 asked for this case to be added to `meta-connect.test.ts`, and `86dc1b7` did not add it. It stays MINOR.
      owed:   Add a real-Meta-group paste case to `tests/integration/connect/meta-connect.test.ts`, with `/me/accounts` → `{ data: [] }`, and assert that the message contains `pages_show_list`.
      traces: US8 AS3

- [ ] MINOR F10 — The real-Meta-group OAuth "no Pages" test still does not assert the outcome's `groupKey`
      where:  tests/integration/connect/meta-connect.test.ts:78-94
      why:    New in this re-review, for the hardening entry. T078 asked for this test to assert `groupKey: "meta"`. It still checks only `JSON.stringify(out)` for `no_candidates` and not `exchange_failed`.
        - The chain is covered in pieces: the route carries the group generically (callback-hint.test.ts:66-71), and the banner renders the Meta hint (callback-hint.test.ts:88-94).
        - No single test drives the real Meta group from the callback through to `group=meta`.
        - Safe to ship, because `back()` always uses the stored `found.groupKey` (connect.ts:301).
      owed:   Replace the stringified check with `expect(out).toMatchObject({ kind: "accounts", groupKey: "meta", code: "no_candidates" })`.
      traces: US2 AS4, edge case "Person deselects Pages or permissions"

- NOTE F6 — The uncommitted working tree that the first review found was resolved before the merge (`ee07e17`, `18d125b`, `1f5d738`). No change since.

- NOTE F7 — `check_quota` deliberately goes ahead on any non-190 failure (first review, unchanged).

- NOTE F9 — In specs/005-meta-facebook-instagram/tasks.md, `T076` (line 257), `T077` (line 258) and `T078` (line 262) are all still unticked, but the behaviour they ask for has shipped (F1 and F2 above). The only parts of T078 not done are the two test additions in F8 and F10. Review may not re-tick existing tasks. A human, or the hardening entry, should tick T076–T078 so that `tasks.md` stops understating what landed. T075 is the owner-only live Meta check and stays open.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Blocking findings open before this pass (F1) | 1 | 1 | 0 | 0 | 0 |
| Blocking findings fixed earlier, re-checked for regression (F2) | 1 | 1 | 0 | 0 | 0 |
| Remediation commits checked for regression (`86dc1b7`) | 1 | 1 | 0 | 0 | 0 |
| Obligations F1 traces to (edge case "deselects Pages", US2 AS4, FR-009, contracts/connect.md:68) | 4 | 4 | 0 | 0 | 0 |
| T078 sub-items (hint, comment, groupKey assertion, paste case, ticks) | 5 | 2 (hint, comment) | 0 | 3 (F10, F8, F9) | 0 |

For coverage of FR-001–FR-040, the success criteria and the constitution as a whole, see the first review at `b65778d`. This scoped pass does not re-derive it.

## What I could not check

- **The rendered banner in a browser.** I checked it with `renderToStaticMarkup` (callback-hint.test.ts:88-94) and by reading page.tsx:53-57. I did not view it in the running app.
- **A live Meta login with every Page deselected.** I could not confirm that the real `/me/accounts` returns `{ data: [] }` there, rather than an error. If it returns an error, the person sees `exchange_failed`, and the same hint is still added to that banner. Confirming this needs a real Meta app, which is owner task T075.
- **Whether F3–F5 were fixed by later entries.** That is out of scope for this re-review.
- **The full gate set** (`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`). The constitution leaves these to implement's final pass and CI. `86dc1b7` was committed directly to `main`, so it has no PR, and I found no CI run to read. I ran only the 5 affected test files.
