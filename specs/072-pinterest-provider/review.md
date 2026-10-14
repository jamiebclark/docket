# Review: Pinterest provider (072)

Reviewed 77 file(s) changed across 13 commit(s), against `90854f81`...HEAD (merge-base with `origin/main`).

Read in full: every file under `src/providers/pinterest/` (source and unit tests), `src/providers/types.ts`
and `src/providers/registry.ts` diffs, `src/components/compose/PostingFieldsPanel.tsx`,
`src/components/compose/posting-ui.ts`, `src/providers/validation.ts`, `src/providers/text.ts`,
`src/server/services/account-details.ts`, `src/server/services/posts/compose.ts` (panel build),
`src/server/services/posts/validate.ts`, `src/server/services/media-variants.ts` (planner → publish media),
`src/server/scheduler/redact.ts`, `tests/helpers/{fake-pinterest,pinterest-publish}.ts`, all seven
`tests/integration/pinterest/*.test.ts`, `tests/integration/compose/pinterest-check.test.ts`, the G29/`docLabel`
additions in `tests/integration/compose/posting-hooks-inert.test.ts`,
`tests/integration/docs/pinterest-docs.test.ts`, `docs/pinterest-setup.md`, the `## Pinterest` block of
`docs/limits.md`, and the diffs of `docs/{accounts,feature-map,adding-a-provider,decisions,index}.md`,
`README.md`, `mkdocs.yml`, `.env.example`, `unraid/docket.xml`, `scripts/generate-icons.mjs`,
`src/components/ui/icons.generated.ts`, `tests/integration/limits/enforcement.test.ts`.

Sampled: `src/app/p/[projectSlug]/compose/Composer.tsx` (only the `PostingFieldsPanel` wiring and the
posting-values updater), `src/providers/{x,instagram,threads}/validate.ts` (to compare the `adaptable` filter),
`src/providers/tiktok/{posting,capabilities}.ts`, `docs/research/pinterest.md` (the rate-limit, limits and
provider-shape sections).

Not reviewed: `specs/072-pinterest-provider/**` was read as the obligation source, not judged as output;
`docs/research/pinterest.md` is taken as authoritative per constitution I — I checked the code and docs
*against* it and cannot re-verify its external claims (no web access in this phase).

Targeted runs: `vitest run src/providers/pinterest/validate.test.ts src/providers/pinterest/posting.test.ts
src/components/compose/posting-ui.test.ts` → 3 files, 39 tests passed, as committed. Per the constitution's
review rule I did not re-run lint, typecheck, the full suite or the build.

## Verdict

The feature satisfies its spec and the pieces fit: one provider folder plus one registry line, no schema,
scheduler, engine or gate change; one `create_pin` request with a hard ambiguous-on-create rule that the
integration tests drive through the real `runTick`; a required per-target board read live and paged; rotating
refresh tokens written as one blob; and honest Trial-access wording on the card, in the summary, above the
posting fields and in a published setup guide. The cross-pass seams mostly held — `labelKey`, `docLabel` and
the counter correction are each opt-in and pinned inert for every other provider, and TikTok's rendered panel
is asserted byte-identical.

Two seams did not hold, and both are one-line fixes. The declared counting rule for the pin title and link is
`code_points` and the panel now counts code points because of this entry's own generic correction — but the
refusal that gates scheduling still counts UTF-16 units, so a title of 51 emoji reads "51 / 100" in the
composer and is refused as "102 characters; Pinterest allows 100" (F1). And `docs/pinterest-setup.md`
attributes Pinterest's 100-a-minute `org_write` rate to Trial access and calls it shared across accounts,
where the research it cites puts 100/minute/user/app on **Standard** and Trial at 300/day/app only — the same
figure `docs/limits.md` labels "Standard access" two files away (F2). Fix those two, re-run the Pinterest and
compose suites, and this is ready to merge; the four MINORs are safe to carry.

The one deliberate deviation from the spec's letter — a 5xx on `create_pin` being `ambiguous` rather than
retryable (FR-025 vs K29) — is argued in `plan.md`, recorded in `docs/decisions.md` and is the safer side of
constitution V. I agree with it and am not reporting it.

## Findings

- [ ] MAJOR F1 — the pin title and link are refused on a UTF-16 count while the panel and the declaration count code points
      where:  src/providers/pinterest/validate.ts:63, src/providers/pinterest/validate.ts:68,
              src/providers/pinterest/posting.ts:54, src/components/compose/PostingFieldsPanel.tsx:193
      why:    `textField()` declares `countingRule: "code_points"`, and this entry's own generic correction
              made the panel's counter honour it (`countPostingText` → `countCodePoints`). `validatePinterest`
              then enforces the limit with `values.title.length` / `values.link.length`, which is UTF-16.
              Measured: a title of 51 "😀" is 51 code points and 102 UTF-16 units, so the composer shows
              "51 / 100" with no over-limit state while the check refuses the target with "The pin title is
              102 characters; Pinterest allows 100." — the post cannot be approved or scheduled for Pinterest
              and the counter says nothing is wrong. `data-model.md:104` ("refused above 100 code points"),
              `contracts/composer-ui.md:30` and `docs/decisions.md` ("the units their own refusals name") all
              specify code points, and `docs/limits.md:218` publishes the limit as "100 code points".
              Every title/link test is ASCII, so nothing catches it.
      owed:   count with `countText(value, "code_points")` (or `[...value].length`) for both `title` and
              `link` in `validatePinterest`, and add a non-BMP case to `validate.test.ts`.
      traces: FR-009, FR-010, SC-005

- [ ] MAJOR F2 — the setup guide gives Pinterest's Standard per-user rate limit as the Trial, shared-across-accounts limit
      where:  docs/pinterest-setup.md:68, docs/research/pinterest.md:254, docs/limits.md:220
      why:    The guide's "Trial rate limits" section says "While the app has Trial access, Pinterest limits
              writes to 100 a minute (`org_write`, reviewed), shared across every connected account, and the
              whole app is capped at 300 a day". The research table it cites gives `org_write` as
              **300/day/app on Trial** and **100/minute/user/app on Standard** — so the 100-a-minute figure is
              the wrong tier *and* the wrong scope (per user, not shared), and `docs/limits.md` labels the same
              number "`org_write`, Standard access" in the row that justifies `defaultPublishLimit`. A deployer
              on Trial is told a limit Pinterest does not apply to them, and told that Docket's per-account
              100/60 s limit is really a server-wide cap. Constitution I makes `docs/research/` authoritative;
              the docs test only asserts that both numbers appear, so nothing catches the attribution.
      owed:   reword the section: Trial = 300 pin creations a day for the whole app, shared across every
              connected account; 100 a minute per user is the Standard rate, which is what Docket's
              `defaultPublishLimit` models. Keep it consistent with `docs/limits.md`.
      traces: FR-033, FR-031, constitution I

- [ ] MINOR F3 — the attempt summary keeps Pinterest's message raw, in a variable named `scrubbedMessage`
      where:  src/providers/pinterest/publish.ts:92, src/providers/pinterest/publish.ts:97,
              src/server/scheduler/record.ts:149, src/server/services/failures.ts:118
      why:    The user-facing `error` goes through `explainPinterest` → `scrubPinterest` (secrets, control
              characters, links, 200 chars). The copy written into `summary.response.message` is only
              `message.slice(0, 200)`, despite the name, so Pinterest's text reaches `publish_attempts` and
              the failures view with its URLs and any control characters intact. Tokens are still safe —
              `record.ts` runs the generic `redact()` with the account's secrets over both summaries, which is
              why `no-secrets.test.ts` passes legitimately — so this is a defence-in-depth and honesty gap,
              not a demonstrated leak. `contracts/pinterest-publishing.md:157` and FR-024 ask for the scrubbed
              text wherever the message is shown.
      owed:   build it with `scrubPinterest(message, secrets)` (which already truncates), and assert in
              `publish.test.ts` that a message carrying a link and a control character is cleaned in the
              summary as well as in `error`.
      traces: FR-024, constitution VII

- [ ] MINOR F4 — the board picker says "still loading" in the one state that reaches it: a failed read
      where:  src/providers/pinterest/posting.ts:37, src/server/services/posts/compose.ts:144
      why:    `view()` only ever sees `details: null` when `readAccountDetails` failed — the check is awaited
              server-side, so there is no in-flight "loading" state for it to represent, and a re-check keeps
              the previous panel until it returns. The field therefore renders the hint "Pinterest's boards are
              still loading." directly beneath the panel's `role="alert"` "Couldn't load this Pinterest
              account's boards." and its Retry button: two contradictory statements about the same state.
              FR-019 is met in substance (the panel does say the boards could not be loaded, the stored choice
              is kept, the control is disabled), and `data-model.md:§5` deliberately made the two states
              identical at field level — but the wording a person reads is wrong.
              `pinterest-check.test.ts:131` asserts only that `disabled` is truthy, so the text is unpinned.
      owed:   word the reason for the one real state (e.g. "Pinterest's boards couldn't be read — Retry
              above; your saved board is kept."), or pass the reason through from the read.
      traces: FR-019, SC-008

- [ ] MINOR F5 — `http.ts` and `http.test.ts` contain raw control bytes, so git treats both as binary
      where:  src/providers/pinterest/http.ts:81, src/providers/pinterest/http.test.ts:101
      why:    The scrub regex was written with literal control characters instead of escapes — the character
              class is `[` NUL `-` 0x1F 0x7F `]`, and the test asserts on a string holding a real NUL and a
              real 0x1F. Both files are valid UTF-8 and behave correctly, but the NUL inside the first 8 KB
              makes git call them binary: `git diff --stat` for this branch reports
              `src/providers/pinterest/http.ts | Bin 0 -> 4960 bytes`, so the HTTP layer and its tests have no
              readable diff, no blame and no conflict resolution for any future change.
      owed:   write `/[\x00-\x1f\x7f]/g` and `"a\x00b\x1fc"` as escapes (behaviour identical), keeping the
              existing `eslint-disable no-control-regex`.
      traces: constitution "Development Workflow" (human-readable commits)

- [ ] MINOR F6 — a Pinterest target created outside the composer can never be scheduled, and no doc says so
      where:  src/providers/pinterest/posting.ts:34, docs/feature-map.md:29,
              src/server/services/posts/validate.ts:66
      why:    The board is required on every target (`board_required` at the gate, again in `advance`) and the
              only thing that can set it is the composer's posting panel — the public API has no posting-field
              input at all, and the generator sets none. So a post created through `/api` or a generation job
              with a Pinterest target is refused at approval with "Choose the board this pin goes on." and
              cannot be scheduled from that caller. FR-001 claims Pinterest is "available to every existing
              caller (composer, scheduler, generation jobs, public API)". The gap is pre-existing generic
              plumbing and TikTok has the same one — but TikTok's feature-map entry records it ("TikTok fields
              in the public API" is listed as owned by no spec) and Pinterest's does not.
      owed:   add "Pinterest posting fields (board, title, link) in the public API and the generator" to the
              Pinterest "not yet owned by any spec" list in `docs/feature-map.md`, and a line in
              `docs/accounts.md#pinterest` that a board can only be chosen in the composer.
      traces: FR-001, FR-034

- NOTE F7 — ten of the thirteen commits on this branch carry no `Co-Authored-By` trailer, which the
  constitution's Workflow row requires on every commit message; the three that do name "Claude Opus 5"
  and "Claude Sonnet 5" rather than the literal value the constitution gives. Verified with
  `git log --format='%h %(trailers:key=Co-Authored-By)'` over `90854f81..HEAD`. Not blocking: it cannot be
  fixed without rewriting published history, commitlint evidently does not check it, and no product
  behaviour depends on it — but the pipeline's commit step is not doing what the constitution says.

- NOTE F8 — `src/providers/pinterest/validate.ts:28` hardcodes "800" in the re-worded `text_too_long`
  sentence instead of reading `caps.text.maxLength`; the structured `count`/`limit` on the issue are correct,
  so nothing is wrong today, but the number is now written in two places.

- NOTE F9 — `tests/integration/limits/enforcement.test.ts:219` changes a cross-provider helper so the
  synthetic attempt ages sit inside the limit's own window. It was needed because Pinterest is the first
  provider with a 60-second publish window (the old `+600` put every attempt outside it), and it reproduces
  the previous `ageSeconds` for every other provider's limit. Correct, but it is a generic test change riding
  in a provider entry, so a reader should know why it is there.

- NOTE F10 — `validate.ts:89` adds an `image_url_not_https` refusal the spec never asked for. It is harmless
  (FR-007 already refuses to connect Pinterest on a non-HTTPS deployment, so the media URL is HTTPS in any
  deployment that has a Pinterest account) and arguably a good guard; recorded only because it is an
  unrequested user-visible refusal code.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001–FR-038) | 38 | 32 | 6 | 0 | 0 |
| Success criteria (SC-001–SC-008) | 8 | 6 | 2 | 0 | 0 |
| Constitution principles (I–VII + engineering + workflow) | 9 | 7 | 2 | 0 | 0 |

Partial functional requirements: **FR-001** (public API / generator caller, F6), **FR-010** (title and link
refused on the wrong count, F1), **FR-012** (the BMP/TIFF fact is recorded in `docs/limits.md:221`, not in the
setup guide the requirement names), **FR-019** (failed-read wording, F4), **FR-024** (the summary copy of the
message is unscrubbed, F3), **FR-033** (Trial rate limits misattributed, F2).

Partial success criteria: **SC-005** (a refusal's count contradicts the composer's own counter, F1; the
attempt summary carries Pinterest's text as sent, F3) and **SC-008** (the failed-load state is distinct in the
panel alert but mislabelled in the field, F4).

Partial constitution rows: **I** (the setup guide contradicts the research it cites, F2) and **Workflow**
(missing commit trailers, F7). Checked and satisfied: **II** — every behaviour has a mocked-HTTP, unit or
markup test and the docs say "verified against mocked responses only" in three places; **III** — no new table
or query, the board read goes through `readAccountDetails` (project scope + `post:view` + the pinned
repositories) and `src/providers/pinterest/**` imports nothing from `src/server/**`; **IV** — one validator,
one details reader, one refresh path, one note helper serve composer, gate and engine; **V** — one folder plus
one registry line, five `advance` result kinds intact, G29 optional and pinned inert, TikTok's panel asserted
byte-identical; **VI** — no new dependency, no new infrastructure; **VII** — credentials encrypted at rest,
the no-secrets suite echoes both tokens from the fake and finds them in no row, log or snapshot (F3 is a
defence-in-depth gap, not a leak); **engineering constraints** — one bounded call per publish, a 10-page cap
on the only loop, waits expressed as `notBefore`, no provider call inside a transaction, `formatLocal` for the
one date in a note.

Specifically swept, as the constitution's first-review rule requires:

- **Concurrency and locking** — no new lock or claim. Rotation is safe because `refreshPinterest` returns the
  whole credentials blob in one `RefreshResult` and the existing `refreshForPublish` lease plus
  `seenCiphertext` arbitrate concurrent renewals; a reply with no refresh token leaves the stored one and its
  expiry untouched (`refresh.ts:41`, pinned by `refresh.test.ts:61`).
- **Idempotency and retries** — one step, `mayPublish: true`, no state, so a lost lease is `ambiguous` by
  construction. Every post-send uncertainty (lost connection, unparseable 2xx, 2xx with no id, 5xx) is
  `ambiguous` and the integration tests prove a second tick claims nothing and `POST /v5/pins` is called once.
  Only `ECONNREFUSED`/`ENOTFOUND`/`EAI_AGAIN` is retryable; 401 is retryable with `credentialsExpired`.
- **Authorization and project scoping** — the only new read is the board list, behind `readAccountDetails`.
  Account expiry is the refresh token's, so the scheduled pass keeps an idle account alive inside its 72-hour
  window while `needsRefresh` (24 h before the 30-day access token) covers composer and publish.
- **Time zones and DST** — no new time arithmetic beyond epoch-millisecond expiries; the only rendered date
  goes through `formatLocal(credentialsExpireAt, timeZone)`.
- **Error, timeout and ambiguous paths** — the whole §4 outcome table is driven through `runTick` in
  `tests/integration/pinterest/failures.test.ts`, including both 429 branches.
- **Secrets in logs and responses** — F3 above is the only gap found; `config.ts` issues carry names and
  reasons only, the authorize URL carries no secret, and there is no step state for anything to leak into.

## What I could not check

- **Anything against the real Pinterest API.** By design (FR-037) and by this phase's means: no credentials,
  no network, no Pinterest app. Every Pinterest behaviour here is "verified with mocks only", and the eleven
  owed live checks (U1–U10 plus Trial visibility) are parked in T073/T074 and listed in
  `docs/pinterest-setup.md#owed-live-checks`. In particular nobody has confirmed the pin permalink shape, the
  429 body, the error bodies, how Pinterest counts `title`/`description`/`alt_text`, or that a Trial pin is
  really invisible to others.
- **The browser.** The board picker, its disabled states, keyboard use, focus and the `role="alert"` + Retry
  pair are checked only as server-rendered markup and panel data (`renderToStaticMarkup` and the check's
  `PostingPanelView`). No real page was driven, so the 300-board `<select>`, the double `onChange` for
  `labelKey` under React's batching (the updater is functional, so it reads correctly) and the counter's live
  behaviour are unverified in a browser.
- **The full quality gate on this exact tree.** Per the constitution's review rule I ran only the three
  targeted unit files (39 tests, all passing) and did not re-run `pnpm lint`, `pnpm typecheck`, `pnpm test` or
  `pnpm build`. `tasks.md` T071/T072 are ticked, which records that the full gate ran green — but those ticks
  were written by the phase that also wrote the code, `.pipeline/implement.result.json` holds only the final
  (no-op) pass, and there is no PR or CI run for this branch to read, so I have no independent evidence for
  `2a4db23`. Integration tests also need Postgres on the test port, which I did not start.
- **`docs/research/pinterest.md`'s external claims.** Taken as authoritative (constitution I); I checked the
  code and the docs against it, not it against Pinterest.
