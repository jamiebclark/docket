# Review: Facebook Pages and Instagram providers (Meta, part 1), re-review after remediation

**This is the scoped re-review that constitution v1.4.0 calls for** ("Review is exhaustive once, then scoped", `.specify/memory/constitution.md:115-128`). It checks only two things:

- whether each blocking finding from the first review (MAJOR F1, MAJOR F2) and the merge-gating NOTE F6 is fixed;
- whether the files the remediation changed introduced a regression.

It opens no new lines of inquiry. Anything new it noticed is recorded as MINOR, for the hardening entry.

The first review's full text is in git at `b65778d` (`git show b65778d:specs/005-meta-facebook-instagram/review.md`). Its file list, gates and coverage notes are there. Its findings are kept below, with a `re-review:` line added to each one in scope.

**What I reviewed.** The feature merged to `main` as PR #10 (`4285587`), from base `7c15677`. The remediation landed as two commits inside that PR, plus the three commits that carried the work F6 found uncommitted:

- `d712732` (F1): `src/providers/meta/candidates.ts`, `src/providers/meta/candidates.test.ts` and a new `tests/integration/connect/meta-connect.test.ts`;
- `08f53d0` (F2): `src/app/p/[projectSlug]/accounts/ConnectGroupSection.tsx`, `src/providers/meta/connect-group.ts` and `tests/integration/meta/engine-unchanged.test.ts`;
- `ee07e17`, `18d125b`, `1f5d738` (F6): Instagram validation, the no-secrets tests and the Meta docs, all now committed.

Since the merge, later entries changed some of the same files. `be617ae` (006, G12) added the per-group `callbackHint` that `page.tsx` shows for `no_candidates`. `f18b361` and `08b5a8b` also touch `connect.ts`, `page.tsx` and the connect group. So I judged F1 and F2 against the present state of `main` (HEAD `69cff5d`), not against the merge commit alone.

**Read in full:**

- `git show d712732 08f53d0`;
- `src/providers/meta/candidates.ts:60-77`;
- `src/providers/meta/connect-group.ts:1-50`;
- `src/server/services/connect.ts:310-370`, the callback result and the paste empty-list path;
- `src/app/p/[projectSlug]/accounts/page.tsx:30-58`, the banners and how the hint is chosen;
- `src/providers/threads/connect-group.ts:90-100`, to see how a sibling group uses `callbackHint`;
- `tests/integration/connect/meta-connect.test.ts`;
- `tests/integration/meta/engine-unchanged.test.ts`;
- `tests/integration/connect/paste.test.ts:83-88`.

**Not re-reviewed:**

- MINOR F3–F5 and NOTE F7: out of scope for a re-review.
- The rest of what 006–010 changed in these files, beyond the G12 hint path that F1 now depends on.

**Run:** following the constitution, I did not re-run the full suite, lint, typecheck or build. I ran only the affected tests: `pnpm vitest run src/providers/meta/candidates.test.ts tests/integration/connect/{meta-connect,paste,callback-hint}.test.ts tests/integration/meta/engine-unchanged.test.ts tests/integration/accounts-ui.test.ts`. That is 6 files and 34 tests, and all of them passed.

## Verdict

**F2 and F6 are fixed. F1 is only half fixed, so one MAJOR remains, and the fix is one line.**

- **F2 (fixed).** The generic `ConnectGroupSection` now renders only `paste.help`. The permission names have moved into the Meta group. The FR-002 scan now covers the accounts and connect UI, and it rejects `pages_*` and `instagram_*` tokens there. Nothing regressed.
- **F1, fixed part.** An OAuth login that lists no Pages now lands on `?connect=no_candidates` instead of `exchange_failed`. The person is no longer sent to check the app id and secret.
- **F1, open part.** That `no_candidates` banner still does not list the permissions. The spec edge case requires it, the contract's messages table requires it, and T076's own test requirement asks for it. The code comment added by the fix also says it is shown, and it is not.

The G12 `callbackHint` mechanism, added later in 006, makes the fix a single field on `metaConnectGroup` plus one assertion. One remediation task has been appended.

## Findings

- [ ] MAJOR F1 — An OAuth login that yields no Pages shows the "check app id/secret/redirect" banner, not the needed permissions
      where:  src/providers/meta/candidates.ts:73, src/providers/meta/connect-group.ts:13-14, src/server/services/connect.ts:314-315, src/app/p/[projectSlug]/accounts/page.tsx:29-36, tests/helpers/connect-group.ts:16
      why:    (first review) The Meta group returned `{ ok: false, message: NO_PAGES }` for an empty `/me/accounts`. `handleOAuthCallback` maps that to `exchange_failed`, so the banner sent the owner to the app id and secret. The spec edge case says "If no Pages come back, the chooser says so and lists the needed permissions". contracts/connect.md:68 maps `no_candidates` to "the group's message (for Meta, which permissions are needed)".
      re-review: **Partly fixed, still open.**
        - **Fixed.** `listPageCandidates` now returns `{ ok: true, candidates: [] }` (src/providers/meta/candidates.ts:71-76). The callback therefore routes to `no_candidates` (src/server/services/connect.ts:329), and tests/integration/connect/meta-connect.test.ts:78-94 proves this with the real Meta group.
        - **Open: the banner names no permissions.** `page.tsx` shows the generic `no_candidates` text, "No accounts were found for this login. Check the permissions you granted and try again." (src/app/p/[projectSlug]/accounts/page.tsx:34). It then appends the group's `callbackHint` (page.tsx:52-57), but `metaConnectGroup` defines none (src/providers/meta/connect-group.ts:16-50, unlike src/providers/threads/connect-group.ts:98).
        - **Result.** Someone who deselected every Page in the login dialog is never told which five permissions Docket needs.
        - **Misleading comment.** The comment the fix added at src/providers/meta/candidates.ts:71 says "the callback shows the permissions banner", and that is not true.
        - **Weak test.** The new test asserts only that the result contains `no_candidates`. It does not check the permissions message that T076 asked for.
        - **Paste path is fine.** connect.ts:366 appends `paste.help`, which lists the permissions.
      owed:   Give `metaConnectGroup` a `callbackHint` that names `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic` and `instagram_content_publish`. Word it so it also reads sensibly after the `platform_error` and `exchange_failed` banners, which share the hint. Then correct the comment at candidates.ts:71. Finally, extend the meta-connect F1 case to assert the hint: `findConnectGroup("meta")?.group.callbackHint` contains `pages_show_list`, and the callback result carries `group=meta`.
      traces: Edge case "Person deselects Pages or permissions", US2 AS4, FR-009, contracts/connect.md:68

- [x] MAJOR F2 — The generic connect UI hard-codes Meta's permission names, and the FR-002 guard test does not scan that code
      where:  src/app/p/[projectSlug]/accounts/ConnectGroupSection.tsx:83, tests/integration/meta/engine-unchanged.test.ts:63
      why:    (first review) The generic paste hint appended Meta's five permission names, and the FR-002 scan did not cover the accounts UI.
      re-review: **Fixed.**
        - `ConnectGroupSection` now uses `hint={paste.help}` (src/app/p/[projectSlug]/accounts/ConnectGroupSection.tsx:83).
        - The permission names live in `metaConnectGroup.pasteToken.help` (src/providers/meta/connect-group.ts:46).
        - The scan roots now include `src/app/p/[projectSlug]/accounts` and `src/app/connect` (tests/integration/meta/engine-unchanged.test.ts:66-73).
        - The pattern now forbids `\b(pages|instagram)_[a-z_]+\b` (engine-unchanged.test.ts:81).
        - The test passes on HEAD. The later 006 Threads group adds no provider strings to those roots.
        - The paste path still lists the permissions, through connect.ts:366.
      traces: FR-002, SC-008, Constitution V

- [ ] MINOR F3 — Facebook attempt summaries leave out the step detail that FR-033 requires, and are inconsistent with Instagram's
      where:  src/providers/facebook/publish.ts:67, src/providers/facebook/publish.ts:75, src/providers/instagram/publish.ts:21-32
      why:    (first review, unchanged) Facebook records only `graphSummary`, with no step, image index or photo ids.
      traces: FR-033

- [ ] MINOR F4 — Candidates are not validated or de-duplicated as contracts/providers.md specifies
      where:  src/server/services/connect.ts:157-158, src/server/services/connect.ts:219-237
      why:    (first review, unchanged) Only foreign provider keys are dropped. Invalid settings throw inside the chooser transaction, and duplicates are upserted twice. This is latent for Meta.
      traces: contracts/providers.md G5 rules

- [ ] MINOR F5 — decisions.md says expired attempts are purged on callback traffic, but the callback never purges
      where:  docs/decisions.md:263, src/server/services/connect.ts:262-320
      why:    (first review, unchanged) This is a documentation inaccuracy, not a leak, because expired rows are unreadable anyway.
      traces: FR-010, FR-040

- [ ] MINOR F8 — The paste "no Pages" test drives a shape the real Meta group no longer produces
      where:  tests/integration/connect/paste.test.ts:83-88, src/server/services/connect.ts:366
      why:    New in this re-review, for the hardening entry. The test stubs the throwaway group to return `{ ok: false, message: NO_PAGES }`. After `d712732`, the real Meta group returns `{ ok: true, candidates: [] }` instead. The pasted token then reaches connect.ts:366, which appends `paste.help`, and that text lists the permissions. The behaviour is correct by reading, but no test pastes a token into the real Meta group with an empty `/me/accounts`. This is spec.md:201 (US8 AS3).
      owed:   Add a real-Meta-group paste case to `meta-connect.test.ts` asserting that the message contains `pages_show_list`.
      traces: US8 AS3

- NOTE F6 — The uncommitted working tree that the first review found is resolved. `ee07e17`, `18d125b` and `1f5d738` committed the Instagram validation, the no-secrets and UI tests, and the Meta docs before the merge at `4285587`.

- NOTE F7 — `check_quota` deliberately goes ahead on any non-190 failure (first review, unchanged).

- NOTE F9 — In tasks.md, `T076` and `T077` are still unticked, but the first review's text marked F1 and F2 as resolved. T077's work is done (see F2). T076's is half done (see F1). The new remediation task tells implement to tick both once F1 is closed, so `tasks.md` stops disagreeing with the code.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Blocking findings from the first review (F1, F2) | 2 | 1 (F2) | 1 (F1: routing fixed, permissions not listed) | 0 | 0 |
| Merge-gating notes (F6) | 1 | 1 | 0 | 0 | 0 |
| Remediation commits checked for regression | 5 (`d712732`, `08f53d0`, `ee07e17`, `18d125b`, `1f5d738`) | 5 (no regression found in the files they changed) | 0 | 0 | 0 |
| Obligations F1/F2 trace to (edge case "deselects Pages", US2 AS4, US8 AS3, FR-002, FR-009, SC-008, Constitution V) | 7 | 5 | 2 (edge case and contracts/connect.md:68, the permissions message on the OAuth path) | 0 | 0 |

For coverage of FR-001–FR-040, the success criteria and the constitution as a whole, see the first review at `b65778d`. This scoped pass does not re-derive it.

Regression checks on the remediated files:
- `d712732` has two callers of `listPageCandidates`: the OAuth exchange and the paste exchange, both at `src/providers/meta/connect-group.ts:6-14`. Both handle `{ ok: true, candidates: [] }`. The callback maps it to `no_candidates` (connect.ts:329), and paste returns a message containing `paste.help` (connect.ts:366). The truncation notice is unaffected (candidates.ts:75).
- In `08f53d0`, the widened scan regex does not flag the Threads group, because it lives under `src/providers/`, which the scan does not cover. All 6 targeted test files pass.

## What I could not check

- **The rendered banner in a browser.** I traced the `no_candidates` banner and hint from source (page.tsx:30-58), and did not render it in the running app.
- **A live Meta login with every Page deselected.** I could not confirm that the real `/me/accounts` returns `{ data: [] }` there, rather than an error. That needs a real Meta app, which is still owner task T075.
- **Whether F3–F5 were fixed by later entries.** That is out of scope for this re-review.
- **The full gate set** (`pnpm test`, `pnpm build`, `pnpm db:check`). The constitution leaves these to implement's final pass and CI. I ran only the 6 affected test files.
