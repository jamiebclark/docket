# Review: X (formerly Twitter) provider (round 2, after Phase 10 remediation)

Reviewed 71 file(s) that differ from `main` (merge-base `2c9a1d0`): 31 tracked files changed, plus 40 untracked files.
HEAD is 4 commits past the base, and all 4 are planning (research, spec, plan, a speckit script fix). **The whole
implementation, including the Phase 10 remediation, is uncommitted in the working tree.** So this review covers the
working tree against `2c9a1d0` (`git diff 2c9a1d0` plus the untracked files), not a commit range.

This is a **re-review**. The constitution (Engineering constraints, "Review is exhaustive once, then scoped") limits it
to two questions:

- Is each round-1 finding fixed?
- Did the files that remediation changed (T040–T042) introduce a regression?

Anything else I noticed is recorded as MINOR, not BLOCKER/MAJOR.

Read in full:

- the remediated files: `src/providers/x/text.ts`, `src/providers/x/text.test.ts`, `docs/x-setup.md`,
  `tests/integration/docs/x-docs.test.ts`, and the diffs of `README.md`, `docs/accounts.md` and `docs/adding-a-provider.md`;
- for context, every other source file in `src/providers/x/`:
  - `config`, `pkce`, `http`, `oauth`, `credentials`, `connect-group`, `refresh`;
  - `settings`, `tlds`, `capabilities`, `validate`, `state`, `steps`, `publish`, `index`;
- the diffs of `src/providers/types.ts`, `src/server/services/connect.ts`, `src/providers/registry.ts` (+ test),
  `scripts/generate-icons.mjs`, `icons.generated.ts`, `prompt.test.ts`, `accounts-ui.test.ts`, `provider-guide.test.ts`,
  `.env.example`, `unraid/docket.xml`, `docs/decisions.md`, `docs/limits.md`, `docs/index.md`, `mkdocs.yml` and `src/lib/docs.ts`;
- `tests/helpers/fake-x.ts` and `tests/integration/x/publish-e2e.test.ts`.

Read for context:

- the callers of the counting rule: `src/server/services/posts/{validate,compose}.ts`, `src/server/services/review.ts`
  and `src/app/p/[projectSlug]/compose/check/route.ts`;
- `src/lib/validation/scheduling.ts`, `src/components/targets/TargetResolution.tsx` and `src/server/dal/clock.ts`.

Sampled: `tests/integration/x/connect.test.ts` (the failing assertion and its setup).

Not re-read: the round-1 test files that remediation did not touch. They are unchanged, and round 1 covered them.

Executed:

- **Targeted suites:** `pnpm vitest run` on `src/providers/x`, `tests/integration/{x,connect,docs,limits}`, the
  registry, prompt and accounts-ui tests. Result: 42 files, 448 tests, all pass.
- **Timing probes of `text.ts`**, esbuild-bundled to `$TMPDIR` and run with node:
  - the current file;
  - a one-line prototype fix, with a 200,000-string differential fuzz against the current file.
- **Full checks**, which the constitution says review should not run:
  - `pnpm test`: 1 failed, 2,953 passed, 2 skipped;
  - `npx tsc --noEmit`: clean;
  - `pnpm lint`: 0 errors, 6 warnings.

  I ran them because the remediation pass said it had not run the full suite on the changed code. I am saying so here
  so the deviation is visible. The one failure is MINOR F8.

## Verdict

**Not ready to merge. Two blocking items remain, both small to fix. The code otherwise holds up.**

Round-1 F1 (the setup guide) is fixed. Round-1 F2 (provider listings) is fixed except for one paragraph, and that
paragraph is a problem:

- **F2 below.** The new X worked example in `docs/adding-a-provider.md` §16 says the PKCE verifier is "kept in the
  connect attempt's state" and "read from it". That is wrong, and following it would be insecure:
  - The verifier is an HMAC of the state under the client secret.
  - The state travels through the browser, so a verifier stored in it would be exposed.
  - §16 contradicts §4 of the same guide and the G17 decision.

Round-1 F3 (quadratic counting) is only partly fixed:

- **F1 below.** The two inputs the round-1 review named are now fast. But the scheme-less URL regex still restarts after
  every hyphen inside a chain of dotted labels:
  - at the 20,000-character cap, crafted text costs about 0.37 s per count and about 1.1 s per `validateX`;
  - about 1.5 s per X target per `compose/check` request, which needs only `post:view`;
  - time still quadruples when the length doubles.

  Round 1 prescribed the label-length bound, and that bound does not cover this case, so the gap is in the
  prescription rather than the implement pass. I measured a one-line bound (253-character hostname lookahead): it is
  linear and gives identical counts.

Fix those two and this is mergeable. The rest of what is listed is MINOR and can ship.

## Findings

- [x] MAJOR F1: scheme-less URL matching is still quadratic; T042 is ticked but counting is not O(length)
      where:  src/providers/x/text.ts:13-16, src/providers/x/text.ts:87, src/providers/x/text.test.ts:72-86, src/providers/x/validate.ts:39-40, src/server/services/posts/compose.ts:69-77, specs/014-x-provider/plan.md:77, specs/014-x-provider/tasks.md:169, docs/adding-a-provider.md:320
      why:    Round-1 F3 is only partly fixed. `trimUrl` is now linear. The two named inputs now take 2.7 ms and
              4.3 ms at 20,000 characters, down from 2.8 s and 0.37 s.
              The new `SCHEMELESS_URL` still matches starting after every `-`, because `-` is not in the lookbehind
              set. From each such start, `(?:label\.)+` walks the rest of a dotted chain before failing for want of a
              TLD.
              Measured on node (bundled `text.ts`) at POST_TEXT_MAX = 20,000 (src/lib/validation/scheduling.ts:35):
              - 63-character hyphenated labels joined by dots (`(Array(32).fill("a").join("-") + ".").repeat(313)`):
                countXText 373 ms, hasLinkOrEmoji 371 ms, validateX 1,119 ms.
              - `"a-a.".repeat(5000)`: countXText 219 ms, validateX 649 ms.
              - Scaling is quadratic: 10k → 100 ms, 20k → 373 ms, 40k → 1,674 ms.
              Who pays:
              - `checkComposition` counts each X target four times (three in validateX, plus compose.ts:77). It needs
                only `post:view` and accepts a 256 KB body.
              - So one request with this base text blocks the web process for about 1.5 s per X account in the
                project. The review page (src/server/services/review.ts:76-86) pays the same on every load of such a
                draft.
              What is false as a result:
              - The plan's "Counting is O(length)" (plan.md:77).
              - The `text.ts:87` docstring ("Pure, total, linear").
              - The new guide sentence "The count is linear in the text length" (adding-a-provider.md:320).
              Why nothing caught it: the regression tests (text.test.ts:72-86) cover only the two inputs round 1
              named, not the property.
      owed:   - Bound the work per start position. Measured fix: insert `(?=[a-z0-9.-]{1,253}(?![a-z0-9.-]))` (253 =
                the DNS maximum hostname length) right after the `(?<![\\p{L}\\p{N}@./_])` lookbehind on text.ts:14.
                Results with it:
                - worst case at 20,000 characters drops from 377 ms to 20 ms;
                - 80,000 characters takes 61 ms, which is linear;
                - counts and link detection are identical to the current file on 200,000 fuzzed URL-like strings, and
                  on every input above.
                An equivalent bound is fine.
              - Add regression tests at 20,000 characters for the two chain inputs above. Assert the exact count
                (20,000 each) and that each `countXText` and `hasLinkOrEmoji` call finishes under 250 ms.
      traces: plan Performance Goals ("Counting is O(length)"), FR-018 (pure, total), round-1 F3 / T042

- [x] MAJOR F2: the new X worked example in the provider guide gets the PKCE design wrong and mislabels the 429 rows
      where:  docs/adding-a-provider.md:313-315, docs/adding-a-provider.md:328-329, docs/adding-a-provider.md:111-113, src/providers/x/pkce.ts:3-9, src/providers/x/connect-group.ts:46, src/providers/x/publish.ts:45-55, docs/decisions.md:509
      why:    T041 added §16 to satisfy FR-038's "short X worked example". Round-1 F2 asked it to cover "PKCE via G17".
              Two parts are wrong:
              - **PKCE (:313-315).** It says "the verifier is kept in the connect attempt's state. `exchangeCode`
                receives that `state` (G17), reads the verifier from it".
                - The code derives it instead: `pkceVerifier(state, clientSecret)` = base64url(HMAC-SHA256(secret,
                  "docket:x:pkce:v1:" + state)) (pkce.ts:3-9, connect-group.ts:46/52). It is never stored or carried.
                - §4 of the same guide (:111-113) and the G17 decision (decisions.md:509) both say that.
                - Why it matters: the state goes through the browser on the authorize redirect and the callback. A
                  provider author who copies §16 and puts the verifier in the state hands it to anyone who sees the
                  code, which removes PKCE's protection.
                - This is the only PKCE example in the guide.
              - **429 rows (:328-329).** They read "429 within the rate window → notBefore" and "429 with no window
                left (credits or spending limit) → at least an hour". publish.ts:45-55 does the opposite of what the
                second label suggests:
                - `x-rate-limit-remaining: 0` with a readable reset (the window is used up) → wait for the reset;
                - any other 429 (remaining not 0, or no readable reset) → at least an hour, with the credits message.
      owed:   - Rewrite the PKCE bullet. The verifier is derived from the state with an HMAC keyed by
                `X_CLIENT_SECRET`, the same way in `authorizationUrl` and `exchangeCode`. Only its S256 challenge
                reaches the browser. Nothing is stored.
              - Relabel the two 429 rows to match publish.ts:45-55.
              - Extend `tests/integration/docs/provider-guide.test.ts` so §16 must mention the HMAC derivation and must
                not say the verifier is kept in, or read from, the state.
      traces: FR-038, round-1 F2, constitution VII (the guide must not teach a verifier leak)

- [ ] MINOR F3: small inaccuracies in the remediated setup and accounts docs
      where:  docs/x-setup.md:84, docs/x-setup.md:107-109, docs/x-setup.md:111-114, docs/accounts.md:116-117, docs/accounts.md:119-120
      why:    - x-setup.md:84 gives `tweet.read` as "to read back the account's posts". Docket reads no posts
                (FR-032). The research says `tweet.read` is required by `POST /2/tweets` and `GET /2/users/me`
                (docs/research/x.md:44-50). The implement pass flagged this wording as its own.
              - The "Not supported" list (:111-114) leaves out Premium long posts. That item is on the spec's
                out-of-scope list (FR-036 and the Assumptions).
              - The ambiguous-post section (:107-109) says "post it again from Docket". It does not name the actual
                actions, **Mark published** and **Mark not published…** (src/components/targets/TargetResolution.tsx:130-134).
              - accounts.md:116-117 lists what is stored and ends "Nothing else". The X display name (`name`) is stored
                too (connect-group.ts:83; connect.test.ts:118 asserts it).
              - accounts.md:119-120 gives an X Settings menu path that is not in docs/research/x.md.
      owed:   - Correct the `tweet.read` reason.
              - Add Premium long posts to "Not supported".
              - Name the two resolve actions.
              - Add the display name to "What is stored".
              - Either source the X Settings path or reword it generically ("X's connected-apps settings").
      traces: FR-036, FR-038, constitution I

- [ ] MINOR F4 (round-1 F4, unchanged): the X folder imports Meta's config; decisions.md claims it does not, and leaves out the TLD list
      where:  src/providers/x/config.ts:2, docs/decisions.md:513, docs/decisions.md:511
      why:    - `config.ts` imports `readEnv` from `../meta/config`. That breaks D12 and makes decisions.md:513 false.
              - The interim-choices bullet (:511) still leaves out the TLD list that FR-039 names.
              - Typecheck would catch a rename, so nothing misbehaves.
      owed:   - Inline the three-line `readEnv` in the X config.
              - Add the TLD list (src/providers/x/tlds.ts) to :511.
      traces: plan D12, FR-039

- [ ] MINOR F5 (round-1 F5, unchanged): FR-009's "X could not be reached and nothing changed" never reaches the user
      where:  src/providers/x/connect-group.ts:10, src/server/services/connect.ts:329
      why:    `handleOAuthCallback` maps every `!result.ok` to the generic `exchange_failed` banner and drops the
              group's `message`. The same happens to the "did not grant offline access" refusal (connect-group.ts:57).
      owed:   Either a numbered generic change (G18) that lets the banner show a provider's safe message, or a spec
              amendment that accepts the generic banner. This needs a human decision; it is not urgent.
      traces: FR-009, US1 AS4

- [ ] MINOR F6 (round-1 F6, unchanged): several ticked test tasks claim more than their tests check
      where:  tests/integration/x/availability.test.ts:9-23, tests/integration/x/no-secrets.test.ts:91-93, tests/integration/x/publish-e2e.test.ts:94, tests/helpers/fake-x.ts:120
      why:    - Nothing checks that a start is refused for an unconfigured X group.
              - The no-secrets test drives only one advance path through the engine.
              - The e2e "ambiguous" test asserts only `not.toBe("published")`.
              - The fake records only the auth kind, so "publishes with the new token" is not actually checked.
      owed:   As round 1 listed: a start-refusal test, more advance paths in no-secrets, assert `ambiguous`, and have the
              fake record which token was presented.
      traces: FR-003, FR-033, FR-040, SC-005, SC-008

- [ ] MINOR F7: the docs tests check headings and keywords, not the facts that F2 and F3 got wrong
      where:  tests/integration/docs/x-docs.test.ts:45-63, tests/integration/docs/provider-guide.test.ts:80-87
      why:    `x-docs.test.ts` asserts that sections and keywords exist. It does not check the out-of-scope items.
              `provider-guide.test.ts` checks only the G17 row and the `exchangeCode` signature, so §16 can describe
              PKCE wrongly and still pass. The F2 remediation task covers the PKCE part.
      owed:   - Assert the full out-of-scope list in x-docs.test.ts.
              - Assert the §16 PKCE wording (part of T044).
      traces: FR-036, FR-038

- [ ] MINOR F8: the X connect test compares the process clock with the database clock, and failed once under the full suite
      where:  tests/integration/x/connect.test.ts:92, tests/integration/x/connect.test.ts:124
      why:    - `before = Date.now()` (process clock) is compared with an expiry derived from `refreshIssuedAt`, which
                comes from `clock.now()` (Postgres `clock_timestamp()`, src/server/dal/clock.ts:14-15).
              - In my full run the DB clock was 2 ms behind: "expected 1806906707239 to be greater than or equal to
                1806906707241".
              - The file passes 5 of 5 runs alone. It is the same flake class as the Threads paste test noted in
                round 1, and it can turn CI red at random.
      owed:   Take `before` from `clock.now()`, or allow a small skew, for example `before - 1000`.
      traces: FR-040, SC-006

- NOTE F9: Per the owner's standing note on deployment-file changes, `unraid/docket.xml:249-269` gains two optional,
  empty `<Config>` entries after the Threads fields:
  - "X Client ID" (`X_CLIENT_ID`, `Mask="false"`);
  - "X Client Secret" (`X_CLIENT_SECRET`, `Mask="true"`).

  Both are `Display="advanced"` and `Required="false"`. `docker-compose.yml` is unchanged.

- NOTE F10: `refresh.ts` still classifies a refusal by parsing `oauth.ts`'s human-readable `reason`:
  - the code regex at refresh.ts:26;
  - the `"HTTP 429"` check at refresh.ts:28.

  It works, and `refresh.test.ts` would catch a wording change. A typed `code`/`status` on `XOAuthFailure` would be
  sturdier.

## Round-1 findings, re-checked

| Round 1 | Status | Evidence |
|---|---|---|
| F1 MAJOR: x-setup.md missing FR-036 content | **Fixed** | Present now: cost and credits with the 2026-10-06 figures and promo credits (x-setup.md:17-32); credits running out (:34-37); scope reasons (:82-88); alt text 1,000 and drift (:97-100); the ambiguous check (:105-109); out of scope (:111-114); the duplicate sentence (:103). x-docs.test.ts:45-63 asserts them. Small leftovers are MINOR F3. |
| F2 MAJOR: X missing from provider listings | **Partly fixed** | README docs table (README.md:111), Connecting accounts (:119-120), Going live (:45-46) and the guide line (:129) now list X. accounts.md has "what is stored" and the mocks-only line (:116-118). The §16 worked example exists, but its PKCE text is wrong (**F2**). |
| F3 MAJOR: quadratic counting | **Partly fixed** | `trimUrl` is linear, and both named inputs are fast. Hyphenated label chains are still quadratic (**F1**). |
| F4–F6 MINOR | Unchanged, as expected | Not given remediation tasks. Carried as F4–F6. |
| F7–F9 NOTE | Unchanged | The Unraid and refresh-parsing notes are carried. The Threads flake did not recur in this run. |

Remediation regressions checked:

- **`text.ts`.** The label rule `[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?` now refuses labels that end in `-` or run longer
  than 63 characters. That is real DNS behaviour, and any drift is covered by the 270 warning. Every corpus count is
  unchanged.
- **`x-docs.test.ts`, README, `accounts.md`.** No regression beyond F3. `pnpm vitest run tests/integration/docs` passes.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements | 40 | 37 | 3 | 0 | 0 |
| Success criteria | 9 | 9 | 0 | 0 | 0 |
| Acceptance scenarios (US1–US6) | 29 | 29 | 0 | 0 | 0 |
| Constitution principles (I–VII) | 7 | 7 | 0 | 0 | 0 |
| Plan constraints | 10 | 8 | 0 | 0 | 2 |
| Round-1 blocking findings | 3 | 1 | 2 | 0 | 0 |

How to read the rows:

- **Partial FRs:**
  - FR-009 (F5, generic banner);
  - FR-038 (F2: the worked example is wrong on PKCE);
  - FR-039 (F4: TLD list missing, D12 claim false).
- **FR-036 counts as satisfied.** Every listed topic is now covered. F3's leftovers (a wrong scope reason, one missing
  out-of-scope item) are wording defects that are safe to ship.
- **US5 AS4 counts as satisfied** for the same reason.
- **Plan constraints:**
  - Satisfied:
    - no new dependency;
    - no schema change;
    - one registry line;
    - G17 limited to `types.ts` and `connect.ts`, and passed only after `consumeState` (connect.ts:296, 319-325);
    - `create_post` is the only `mayPublish` step;
    - no provider I/O in a transaction;
    - no sleeps or loops in `advance`;
    - secrets kept out of state and summaries.
  - Contradicted:
    - D12, which allows no other-provider imports (F4);
    - "Counting is O(length)" (F1).
- **Constitution I** holds for endpoints, scopes and limits, which all trace to docs/research/x.md. The one unsourced X
  UI path is MINOR F3.
- **Constitution VII:** the code holds. F2 is a doc that would mislead a future provider author; it is not a leak in
  this code.
- **Engineering constraint "runTick bounded"** holds. Over-280 text is refused at scheduling, so F1's cost lands on the
  web process, not the worker.

## What I could not check

- **The live X API**, by design: the owner owes no live check. Everything below is verified only against the fake:
  - endpoint shapes;
  - the duplicate, 429 and 401 bodies;
  - refresh-token rotation and lifetime;
  - media processing states;
  - the post URL (U1–U9).
- **`pnpm build`**, which writes `.next/` outside this phase's write scope. That means two things are unverified:
  - that the `node:crypto` import in `authorizationUrl` works in the Next proxy runtime (research F3);
  - that the worker bundle builds with the new folder.

  The round-1 T039 claimed a passing build. The remediation pass ran only targeted tests and tsc, but it changed no
  import or boundary.
- **`pnpm db:check`**, which was not run. No schema file is in the diff.
- **Real undici error shapes** for the `not_sent` / `lost` split (src/providers/x/http.ts:36-46). The fake throws
  synthetic errors of that shape.
- **Browser flows:**
  - the Accounts screen's **Connect X**, the "not configured" notice and the G10 reason;
  - the chooser;
  - the X mark in the composer and account picker.

  Only server-rendered `ProviderIcon` and service outcomes are tested.
- **Counting accuracy against twitter-text or X itself.** No reference implementation was available. The F1 prototype
  was compared with the current file, not with X.
- **How a 1.5 s `compose/check` stall feels in production.** The numbers above come from node on this machine, not
  from the deployed image or the Unraid host.
- **The rendered mkdocs site** and the Unraid template UI.

## Round 2 findings, re-checked (scoped, front end, 2026-10-07)

Owner policy: one exhaustive review, then a scoped check of the fixes only. This checks F1 and F2 above and nothing else.

| Finding | Status | Evidence |
|---|---|---|
| F1 MAJOR: scheme-less URL matching quadratic | **Fixed** | The 253-character hostname lookahead prescribed above is now at the start of `SCHEMELESS_URL` (src/providers/x/text.ts). On `(Array(32).fill("a").join("-") + ".").repeat(313).slice(0, 20000)`, the same text with the lookahead removed counts 20000 in 412 ms; with it, 20000 in 16 ms. Regression tests for that input and `"a-a.".repeat(5000)` assert count 20000, `hasLinkOrEmoji` false, and under 250 ms each (text.test.ts). Every earlier count is unchanged. |
| F2 MAJOR: §16 PKCE text and 429 rows | **Fixed** | §16 now says the verifier is derived as base64url(HMAC-SHA256(`X_CLIENT_SECRET`, "docket:x:pkce:v1:" + state)) in both calls and never stored, which matches §4, decisions.md G17 and pkce.ts. The two 429 rows match `rateLimitedResult` in publish.ts. provider-guide.test.ts asserts the HMAC text and that §16 does not say the verifier is kept in or read from the state. |

Checks: `pnpm vitest run src/providers/x tests/integration/docs` passed 255 of 255 tests in 21 files. `pnpm typecheck` was clean. `pnpm lint` reported 0 errors.
