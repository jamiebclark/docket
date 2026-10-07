# Review: X (formerly Twitter) provider (round 3, after Phase 11 remediation)

Reviewed 71 file(s) changed across 9 commit(s), against `2c9a1d0...HEAD` (merge-base with `origin/main`). Unlike round 2,
the implementation is now committed, in five commits: 802cec4, 95531f5, 8a20fa5, 2afe77a and 7d7dd97. The working tree
is clean.

This is a **scoped re-review**. The constitution says "Review is exhaustive once, then scoped", so this round checks only
two things:

- Is each round-2 blocking finding (F1, F2) fixed?
- Did the files that the Phase 11 remediation (T043, T044) changed introduce a regression?

Anything else I noticed is recorded as MINOR or NOTE, never as BLOCKER or MAJOR. Rounds 1 and 2 did the exhaustive sweep;
their full text is in git history (`git show 7d7dd97:specs/014-x-provider/review.md`).

**Read in full:**

- the files remediation changed: `src/providers/x/text.ts`, `src/providers/x/text.test.ts`,
  `docs/adding-a-provider.md` §16 (lines 309-334, plus §4 at :100-120 for consistency), and
  `tests/integration/docs/provider-guide.test.ts`;
- the code §16 describes: `src/providers/x/pkce.ts`, `src/providers/x/connect-group.ts:35-95`,
  `src/providers/x/publish.ts:1-120` and `src/providers/x/refresh.ts`;
- the diff of `.specify/roadmaps/docket.json`, which is new in 7d7dd97.

**Re-located, not re-reviewed:** the lines cited by the carried MINOR findings F3 to F8. I checked each citation against
HEAD and updated any that had moved.

**Not reviewed:** every other file. Round 2 covered them, and remediation did not touch them.

**Executed:**

- `pnpm vitest run src/providers/x/text.test.ts tests/integration/docs/provider-guide.test.ts tests/integration/docs/x-docs.test.ts`:
  3 files, 67 tests, all pass.
- `pnpm vitest run src/providers/x tests/integration/limits tests/integration/docs`: 22 files, 316 tests, all pass.
- **A timing and differential probe of `text.ts`.** I bundled the current file with esbuild into `$TMPDIR`, and also a copy
  with the T043 lookahead removed. Then I ran both under node:
  - 8 adversarial families at 20,000 and 40,000 characters;
  - a 200,000-string fuzz of short URL-like text.

Per the constitution, I did not run the full suite, lint, typecheck or build. CI could not be read: the sandbox could not
reach the remote (the `git ls-remote` SSH connection failed, and `gh` failed TLS verification).

## Verdict

**Ready to merge. Both round-2 blocking findings are fixed, and the remediation introduced no regression.**

- **F1 (quadratic scheme-less URL matching) is fixed.** The 253-character hostname lookahead is in place at
  src/providers/x/text.ts:15. The two inputs round 2 measured at 373 ms and 219 ms now take 19.7 ms and 8.7 ms at 20,000
  characters. Every family I tried doubles in time when the length doubles (20k → 40k: 19.7 → 30.8 ms, 15.5 → 31.1 ms),
  so counting is linear. The plan's "Counting is O(length)" (plan.md:77) and the docstring at text.ts:88 are now true.
- **F2 (§16 PKCE text and 429 rows) is fixed.** The text now matches pkce.ts, §4 of the guide and the G17 decision. A test
  stops it from regressing.

What remains is six carried MINORs (F3 to F8) and one new MINOR (F11), a one-cell wording slip in §16. All are safe to
ship. The only behaviour change from T043 is the overcount on hostnames over 253 characters (NOTE F12), and it errs
toward refusing, not toward letting a too-long post through.

## Findings

- [ ] MINOR F3 (round 2, unchanged): small inaccuracies in the setup and accounts docs
      where:  docs/x-setup.md:84, docs/x-setup.md:107-109, docs/x-setup.md:111-114, docs/accounts.md:116-117, docs/accounts.md:119-120
      why:    - x-setup.md:84 gives `tweet.read` as "to read back the account's posts". Docket reads no posts (FR-032).
                It is needed for `POST /2/tweets` and `GET /2/users/me` (docs/research/x.md:44-50).
              - "Not supported" (:111-114) leaves out Premium long posts (FR-036, Assumptions).
              - The ambiguous-post section (:107-109) says "post it again from Docket". It does not name the actual
                actions, **Mark published** and **Mark not published…**.
              - accounts.md:116-117 ends "Nothing else", but the X display name (`name`) is stored too
                (src/providers/x/connect-group.ts:83).
              - accounts.md:119-120 gives an X Settings menu path that is not in docs/research/x.md (constitution I).
      owed:   - Correct the scope reason.
              - Add Premium long posts to "Not supported".
              - Name the two resolve actions.
              - Add the display name to "What is stored".
              - Source the menu path or reword it generically.
      traces: FR-036, FR-038, constitution I

- [ ] MINOR F4 (rounds 1 and 2, unchanged): the X folder imports Meta's config, and decisions.md claims it does not
      where:  src/providers/x/config.ts:2, docs/decisions.md:513, docs/decisions.md:511
      why:    - `config.ts` imports `readEnv` from `../meta/config`. That breaks D12 and makes decisions.md:513 false.
              - The interim-choices bullet (:511) still leaves out the TLD list that FR-039 names.
              - A rename would be caught by typecheck, so nothing misbehaves.
      owed:   - Inline the three-line `readEnv` in `src/providers/x/config.ts`.
              - Add `src/providers/x/tlds.ts` to decisions.md:511.
      traces: plan D12, FR-039

- [x] MINOR F5 (rounds 1 and 2, unchanged; resolved 2026-10-07 by G18, owner chose the provider's own message): FR-009's "X could not be reached and nothing changed" never reaches the user
      where:  src/providers/x/connect-group.ts:10-11, src/server/services/connect.ts:329
      why:    `handleOAuthCallback` maps every `!result.ok` to the generic `exchange_failed` banner and drops the group's
              `message`. The same happens to the "did not grant offline access" refusal (connect-group.ts:57).
      owed:   Either a numbered generic change (G18) that lets the banner show a provider's safe message, or a spec
              amendment that accepts the generic banner. This needs an owner decision.
      traces: FR-009, US1 AS4

- [ ] MINOR F6 (rounds 1 and 2, unchanged): several ticked test tasks claim more than their tests check
      where:  tests/integration/x/availability.test.ts:9-23, tests/integration/x/no-secrets.test.ts:89-93, tests/integration/x/publish-e2e.test.ts:94, tests/helpers/fake-x.ts:120
      why:    - Nothing checks that a start is refused for an unconfigured X group (T028).
              - The no-secrets test drives only one advance path (a 503, then a 201) through the engine (T037).
              - The e2e "ambiguous" test asserts only `not.toBe("published")`.
              - The fake records only the auth kind, not the token presented, so "publishes with the new token" (T027) is
                not actually checked.
      owed:   - Add a start-refusal test.
              - Drive more advance paths in no-secrets.
              - Assert `ambiguous` exactly.
              - Have the fake record which token was presented.
      traces: FR-003, FR-033, FR-040, SC-005, SC-008

- [ ] MINOR F7 (round 2, narrowed): x-docs.test.ts checks that the out-of-scope section exists, not what it lists
      where:  tests/integration/docs/x-docs.test.ts:45-63
      why:    The PKCE half of round-2 F7 is resolved: tests/integration/docs/provider-guide.test.ts:99-104 now asserts
              the HMAC derivation. `x-docs.test.ts` still asserts only the `## Not supported` heading, which is why
              F3's missing Premium item went unnoticed.
      owed:   Assert each FR-036 out-of-scope item in x-docs.test.ts.
      traces: FR-036

- [ ] MINOR F8 (round 2, unchanged): the X connect test compares the process clock with the database clock
      where:  tests/integration/x/connect.test.ts:92, tests/integration/x/connect.test.ts:124
      why:    - `before = Date.now()` is the process clock. It is compared with an expiry derived from `refreshIssuedAt`,
                which comes from the DB clock (src/server/dal/clock.ts:14-15).
              - In a round-2 full run, the DB clock was 2 ms behind and the assertion failed.
              - It passes on its own, and it passed in my targeted runs, but it can turn CI red at random.
      owed:   Take `before` from `clock.now()`, or allow a small skew (`before - 1000`).
      traces: FR-040, SC-006

- [ ] MINOR F11 (new, outside remediation scope): §16 says a duplicate 403 shows X's message
      where:  docs/adding-a-provider.md:332, src/providers/x/publish.ts:100
      why:    The row "403 duplicate, other 403, other 4xx | `fatal_error` with X's message" is wrong for the duplicate
              case. publish.ts:100 replaces X's detail with Docket's own "X refused this as a duplicate of a recent
              post." Only the other 403 and 4xx rows carry X's detail. T044 did not touch this row; I noticed it while
              checking the rows it did change.
      owed:   Split the row: "403 duplicate → `fatal_error`, 'X refused this as a duplicate of a recent post.'" and
              "other 403, other 4xx → `fatal_error` with X's detail".
      traces: FR-038

- NOTE F9 (carried): per the owner's standing note on deployment files, `unraid/docket.xml` gains two optional, empty
  `<Config>` entries after the Threads fields: "X Client ID" (`X_CLIENT_ID`, `Mask="false"`) and "X Client Secret"
  (`X_CLIENT_SECRET`, `Mask="true"`). Both are `Display="advanced"` and `Required="false"`. `docker-compose.yml` is
  unchanged, so the owner's copied compose file needs no edit.

- NOTE F10 (carried): src/providers/x/refresh.ts:26 and :28 classify a refusal by parsing `oauth.ts`'s human-readable
  `reason`. It works, and refresh.test.ts would catch a wording change. A typed `code` and `status` on `XOAuthFailure`
  would be sturdier.

- NOTE F12 (new, from checking T043): the hostname bound changes the count for one class of input, and errs toward
  refusing. The class is a run of `[a-z0-9.-]` longer than 253 characters with no permitted start in its last 253
  characters (src/providers/x/text.ts:15). Such text is now counted as plain text instead of as one link:
  - `"a.".repeat(130) + "com"` counts 263, where the pre-T043 regex gave 23;
  - `"com.".repeat(5000)` counts 20,000, where it gave 24.

  Such a hostname is not valid DNS. The change can only make Docket refuse a post X might accept, never the reverse.
  Every realistic case agrees with the pre-T043 regex: the 200,000-string fuzz (0 differences) and a 251-character
  hostname inside a sentence. No action is needed unless twitter-text is later found to link such strings.

- NOTE F13: the implementation landed as one 40-file `feat(providers): add the X provider` commit (95531f5, 3,181
  insertions). The constitution's workflow asks for a commit per task, or per small group of related tasks. Nothing
  misbehaves, and semantic-release still sees one correct `feat`. I am recording it because a 40-file commit is harder to
  bisect or revert piecemeal. Rewriting history is not worth it at this point.

## Round-2 blocking findings, re-checked

| Round 2 | Status | Evidence |
|---|---|---|
| F1 MAJOR: scheme-less URL matching quadratic | **Fixed** | See the details below this table. |
| F2 MAJOR: §16 PKCE text and 429 rows | **Fixed** | See the details below this table. |

**F1, the lookahead.** `(?=[a-z0-9.-]{1,253}(?![a-z0-9.-]))` sits immediately after the lookbehind (src/providers/x/text.ts:15),
as T043 prescribed, so each start position does at most 253 characters of work. Timings at 20,000 and 40,000 characters,
for `countXText` and `hasLinkOrEmoji` alike:

| Family | 20,000 chars | 40,000 chars |
|---|---|---|
| hyphen-dot chain | 19.7 ms | 30.8 ms |
| `a-a.` | 8.7 ms | 17.3 ms |
| `a-` | 15.5 ms | 31.1 ms |
| upper-case chain | 15.3 ms | 29.9 ms |
| `-a.a` | 8.6 ms | 16.5 ms |
| the other three families | ≤ 2.3 ms | ≤ 4.5 ms |

**F1, the tests.** text.test.ts:88-99 adds both inputs that T043 named. Each asserts length 20,000, a count of 20,000,
`hasLinkOrEmoji` false, and under 250 ms per call. The 250 ms ceiling is about 12× the measured time, so it is unlikely to
flake. All 37 corpus counts are unchanged.

**F2, the PKCE text.** §16 (docs/adding-a-provider.md:313-316) says the verifier is never stored and is derived in both
calls as base64url(HMAC-SHA256(`X_CLIENT_SECRET`, "docket:x:pkce:v1:" + state)). Only its S256 challenge reaches the
browser, and it is sent with Basic client auth. That matches:

- src/providers/x/pkce.ts:7-9;
- connect-group.ts:46 and :52;
- the guide's §4 (:111-113);
- docs/decisions.md:509.

**F2, the 429 rows.** docs/adding-a-provider.md:329-330 match `rateLimitedResult` (src/providers/x/publish.ts:45-55):

- `remaining === 0` with a reset → `notBefore` at the reset;
- otherwise → `max(reset, now + 1 h)`.

**F2, the test.** provider-guide.test.ts:99-104 asserts the HMAC text and rejects "verifier is kept in" and "reads the
verifier from". It cannot pass vacuously: if the §16 heading moved, `indexOf` would return -1 and the HMAC match would
fail.

Regression check of the remediated files:

- **`text.ts`.** The only behaviour change is NOTE F12, and it errs toward refusing. The callers, `validate.ts:39-40`,
  `publish.ts:74` and `capabilities.ts:10`, use the same signatures. `src/providers/x` and `tests/integration/limits` pass.
- **`docs/adding-a-provider.md`.** §4 and §16 now agree. The other §16 bullets are consistent with the code:
  - the refresh hold is `X_REFRESH_RETRY_MS` = 5 minutes (src/providers/x/config.ts:18);
  - `invalid_grant` is permanent, and 429 and network errors are transient (src/providers/x/refresh.ts:24-40).

  The one exception is the duplicate cell, MINOR F11.
- **`provider-guide.test.ts`.** The new test is additive, and all earlier assertions are unchanged.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements | 40 | 38 | 2 | 0 | 0 |
| Success criteria | 9 | 9 | 0 | 0 | 0 |
| Acceptance scenarios (US1–US6) | 29 | 29 | 0 | 0 | 0 |
| Constitution principles (I–VII) | 7 | 7 | 0 | 0 | 0 |
| Plan constraints | 10 | 9 | 0 | 0 | 1 |
| Round-2 blocking findings | 2 | 2 | 0 | 0 | 0 |

How to read the rows:

- **These rows are round 2's assessment, updated only for what this round re-checked.** In this scoped round I did not
  re-verify each FR, SC or scenario independently.
- **FR-038 moves from Partial to Satisfied.** §16 is now correct on PKCE and 429. F11 is a one-cell wording slip.
- **The two Partial FRs:**
  - FR-009, the generic banner (F5);
  - FR-039, the TLD list missing from decisions.md (F4).
- **Plan constraints:** "Counting is O(length)" moves to Satisfied (F1 fixed). D12 ("no other-provider imports") is still
  contradicted, by F4. That is MINOR because nothing misbehaves and typecheck guards it.
- **Constitution I:** the one unsourced X UI path (F3) does not affect any endpoint, scope or limit. **Constitution VII:**
  the guide no longer teaches a verifier leak.

## What I could not check

- **CI on the PR.** The sandbox could not reach the remote (the SSH connection failed, and `gh` failed TLS verification),
  so I could not read CI results for these commits. Round 2's full run (`pnpm test`: 1 flaky failure, F8; tsc clean; lint
  0 errors) was against the uncommitted tree, before T043 and T044. The scoped re-check recorded in 7d7dd97 reports
  typecheck and lint clean after them. A human should confirm CI is green before merging.
- **The live X API**, by design: the owner does not use X, and no live check is owed. Verified against the fake only:
  - endpoint shapes;
  - the duplicate, 429 and 401 bodies;
  - refresh rotation and lifetime;
  - media processing states;
  - the post URL (U1–U9).
- **`pnpm build`**, which writes `.next/` outside this phase's write scope. That leaves two things unverified here: the
  `node:crypto` import in `authorizationUrl` under the Next runtime, and the worker bundle with the new folder.
  Remediation changed no import or boundary.
- **Counting accuracy against twitter-text or X itself.** No reference implementation is available. My probe compared
  the current file with its own pre-T043 version, not with X. That matters most for NOTE F12.
- **Browser flows:** the Accounts screen's **Connect X**, the "not configured" notice and the G10 reason, the chooser,
  and the X mark in the composer and account picker.
- **Real undici error shapes** for the not-sent / lost split (src/providers/x/http.ts:36-46).
- **Timing on the deployed image or the Unraid host.** All the numbers above are node on this machine.
