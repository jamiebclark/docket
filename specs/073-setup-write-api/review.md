# Review: Public API for project setup — projects, voice profiles, posting instructions and slots

**Round 2 — a re-review after remediation.** Per the constitution's "Review is exhaustive once,
then scoped" rule, this pass checks only (a) that each of round 1's six findings is actually fixed
and (b) that the files the remediation touched introduced no regression. New observations are
recorded as `MINOR` for a hardening entry, never as `BLOCKER`/`MAJOR`. Round 1's text is in
git at `cf01885:specs/073-setup-write-api/review.md`.

Reviewed 47 file(s) changed across 11 commit(s), against `70826c9...HEAD` (diff-first), with the
remediation commit `cf01885` read line by line.

Read in full: the whole of `cf01885` — `src/lib/api/schemas.ts`,
`src/server/{services/projects,services/voice,dal/slots,api/operations/voice}.ts`, and its four test
files. Independently re-read rather than carried forward: all eight operation definitions
(`src/server/api/operations/{projects,voice,slots,accounts,types,index,errors-doc}.ts`),
`src/server/api/{handle,router,idempotency,errors}.ts`, `src/server/services/{slots,accounts}.ts`
(the posting-instructions half), `src/server/dal/{slots,projects,scope,errors}.ts`,
`src/lib/validation/{brand,link,voice,scheduling,api}.ts`, all four
`tests/integration/api/endpoints/*-write.test.ts`,
`tests/integration/api/{setup-permission,scope-enforcement,openapi,pipeline}.test.ts`,
`tests/integration/docs/n8n-provision.test.ts`, the `docs/{n8n,brand-onboarding,decisions}.md`
diffs, `drizzle/0034_fantastic_dazzler.sql` and the constitution.

Sampled: `drizzle/meta/0034_snapshot.json` (the `manage_setup` enum entry at line 10021 and the
journal entry only).

Ran: the five endpoint/pipeline suites the remediation edits (**57 tests**); then every suite that
touches the changed code or its browser callers — `tests/integration/{api,docs,security,api-keys}`,
`tests/lint`, `tests/integration/voice`, `accounts-slots`, `project-{brand,settings,validation}`,
`projects`, `accounts-posting-instructions` (**70 files, 638 tests**); then the co-located suites
under `src/` for voice, accounts, `/p/new`, settings, validation and server (**991 tests, 1
pre-existing skip**). All green. Plus `npx tsc --noEmit` (clean) and `eslint` on the nine files
`cf01885` touched (clean) — run because `cf01885` landed *after* the implement phase's full
validation pass in `874ed22` and changed three exported signatures, so no gate had yet seen it.

Plus five throwaway probes against the real route module and a real Postgres, deleted afterwards
(working tree clean): an explicit `null` on each of the three brand fields; the
`.returning()`-empty path in both slot writers; two genuinely concurrent `POST /voice-profiles`
against a default-less project, three times over, with the pre-fix snapshot read asserted
alongside; and the `Allow` set for `/slots/upcoming` and `/slots/week`.

## Verdict

All six of round 1's findings are closed, and I verified each by execution rather than by reading
the diff. F1's double-parse defect is genuinely gone: `taglineSchema.nullable()` short-circuits on
the `null` its own first parse produced, so `""`, `"   "` and an explicit `null` on any of the three
brand fields now answer 201 with the field stored as `null`. F3 and F4 were read-then-write races
round 1 could only reason about; both are now exercised — the deleted-slot race maps to 404 instead
of 500, and two simultaneous creates in a default-less project report `isDefault: true` exactly
once, where the pre-fix snapshot read (asserted in the same probe) would have had both claim it.
F2, F5 and F6 are straightforward and landed as asked. The remediation introduced no regression:
typecheck, lint and 1,686 tests across every caller of the three widened signatures are green, and
the one behavioural side effect — `saveVoiceProfile` now taking the project lock it did not take
before — is consistent with the five sibling voice operations that already did, takes the lock as
its transaction's first statement so it cannot invert anyone's lock order, and leaves the browser
voice suite green. Three small things remain, all non-blocking and all for a hardening entry: one
operation is still a validation-failure test short of FR-048's five cases, a table-driven isolation
test can lose coverage silently, and `OPTIONS` over-advertises on the two literal `/slots/*` paths.
Nothing here should hold the merge.

## Findings

- [ ] MINOR F1 — `PATCH /voice-profiles/{profileId}` is the one new operation with no
      validation-failure test, which FR-048 requires for every operation
      where:  tests/integration/api/endpoints/voice-write.test.ts:81,
              src/lib/api/schemas.ts:422
      why:    FR-048 enumerates five cases per operation. The PATCH block has happy path (`:82`),
              stale `baseVersion` 409 (`:98`), the identical-content no-op (`:109`), archived 409
              (`:122`), 404 parity (`:134`), missing permission (`:150`) and idempotent replay
              (`:161`) — but no 400. `baseVersion` is the one field unique to this operation, and
              nothing anywhere sends it as `0`, as a string, or omits it; the over-length-name and
              bad-hashtag cases at `:21` are under `POST /voice-profiles`, not this one. Both the
              request schema (`z.number().int().min(1)`) and the service's `saveSchema` would reject
              it, so the behaviour is almost certainly right — it is simply the one of FR-048's
              forty cases with no assertion behind it, and round 1 closed the mirror-image gap
              (a missing replay on `PATCH /slots/{slotId}`) without noticing this one.
      owed:   One case in the PATCH block: `baseVersion: 0` and a missing `baseVersion` each answer
              400 `validation_failed` naming `baseVersion` in `details`, and append nothing.
      traces: FR-048

- [ ] MINOR F2 — the cross-project isolation test passes vacuously for any resource parameter
      missing from its `foreign` map, so it can stop covering a parameter without failing
      where:  tests/integration/api/scope-enforcement.test.ts:151,
              tests/integration/api/scope-enforcement.test.ts:161,
              tests/integration/api/scope-enforcement.test.ts:169
      why:    `foreign[name]!` yields `undefined` for an unlisted parameter; `{ [name]: undefined }`
              then *overwrites* the fixture's own value in the spread at `:81`, and `fill()`
              substitutes `"00000000-0000-4000-8000-000000000000"` for both calls. The test then
              compares unknown-against-unknown, both 404, both identical — and passes. The floor at
              `:169` cannot catch it either: `checked.length` is asserted `>= 6` against an actual
              22 `(operation, parameter)` pairs. This entry did its part — `accountId`, `profileId`
              and `slotId` are all in the map at `:151`, which my run confirms, so FR-050 is met
              today. The defect is that the test cannot detect its own future loss of coverage, and
              it is the one table-driven test in this entry without that guard:
              `setup-permission.test.ts:94` and the `has a fixture for every operation` case at
              `:86` of this same file both fail loudly on a missing fixture. Pre-existing shape that
              this entry extended rather than introduced.
      owed:   Assert `foreign[name]` is defined before using it (or raise the floor to the real pair
              count), so a future `resourceParams` entry with no project-B fixture fails the test.
      traces: FR-050, SC-006

- [ ] MINOR F3 — `OPTIONS` advertises `PATCH` and `DELETE` on `/slots/upcoming` and `/slots/week`,
      where both answer 404
      where:  src/server/api/router.ts:37, src/server/api/operations/slots.ts:113
      why:    `allowedMethods` unions every operation whose path *template* matches the segments,
              and `/slots/{slotId}` matches `["slots","upcoming"]` with `slotId = "upcoming"`.
              Verified by probe: `allowedMethods(["slots","upcoming"])` is
              `["DELETE","GET","HEAD","OPTIONS","PATCH"]` and `allowedMethods(["slots","week"])` is
              `["DELETE","OPTIONS","PATCH","POST"]`, while `matchOperation("PATCH",
              ["slots","upcoming"])` routes to `updateSlot` and `handle.ts:73`'s UUID check turns it
              into `404 not_found`. So a client that reads `Allow` and tries `DELETE
              /slots/upcoming` gets 404 rather than the 405 or 200 the header implied. Not a method
              special-case, so FR-001's letter holds, and the same shape already existed before this
              entry — `allowedMethods(["media","from-url"])` contains `GET` for exactly this reason,
              which the probe also confirms. This entry just made it reachable on two more paths.
      owed:   Prefer an exact literal match over a parameter match at the same depth when computing
              `Allow` (and in `matchOperation`), or accept it as documented behaviour.
      traces: FR-001

- NOTE F4 — `spec.md`'s FR-011 and FR-015 both gloss "no acting user" as "its creator has **left the
  project**". That is not the implemented trigger: `src/server/dal/scope.ts:370` sets
  `membership.userId` to `""` only when `api_keys.created_by_user_id` is NULL, and
  `src/server/db/schema/api.ts:43` nulls that column `onDelete: "set null"` on the **user** row —
  leaving a project deletes a `member` row, not a user. So a key whose creator merely left still has
  an acting user. The implementation is the better choice and `docs/decisions.md` argues for it
  explicitly ("Guarding on anything stricter … would break a legitimate provisioning key after an
  ordinary staff change"); the test at `tests/integration/api/endpoints/projects-write.test.ts:127`
  reaches the branch by nulling the column directly, which is honest. The normative clause — refuse
  cleanly with a named conflict when there is no acting user — is satisfied. It is the spec's
  parenthetical that is now stale, and `spec.md` is out of this phase's write scope.

- NOTE F5 — the committed F1 regression test at
  `tests/integration/api/endpoints/projects-write.test.ts:88` sends `""` on all three brand fields
  but an explicit `null` only on `tagline`, where T047 asked for `""` and `null` on all three. I
  closed the question by probe: `null` on `description` and on `websiteUrl` each answer 201 with the
  field stored as `null`, which is expected since `src/lib/api/schemas.ts:405-407` wrap all three
  identically. No behaviour risk; two more loop entries would make it the suite's claim rather than
  mine.

- NOTE F6 — round 1's F7 found three commits with no `Co-Authored-By` trailer at all; `cf01885` has
  one, so that is fixed. What is left is that the constitution's Development Workflow section
  (`.specify/memory/constitution.md:92`) pins the trailer to a literal `Claude Opus 5.5`, and no
  model actually running this pipeline is that one — `cf01885` says `Claude Sonnet 5` and this
  review's own commit says `Claude Opus 5`, each naming its real author. A trailer that misattributes
  the work to a model that did not do it is worse than one that does not match the template, so the
  thing owed is a `docs(constitution):` amendment making the trailer name the acting model rather
  than a fixed version. Not this entry's job, and nothing to rewrite history over.

## Round 1 findings — re-verified

| # | Round 1 claim | Severity | Fix | Verified how |
|---|---|---|---|---|
| F1 | An empty, whitespace-only or null brand field on `POST /projects` answers 400 | MAJOR | **Closed** | `src/lib/api/schemas.ts:405-407` and `src/server/services/projects.ts:25-27` (plus `:68-70` for `updateSettings`) now wrap each brand field `taglineSchema.nullable().optional()`, so the second parse accepts the `null` the first produced. Test at `tests/integration/api/endpoints/projects-write.test.ts:88` — 5 cases, all 201 with `null`; a probe extended it to `null` on all three fields (F5) |
| F2 | `PATCH /slots/{slotId}` had no idempotent-replay test | MAJOR | **Closed** | `tests/integration/api/endpoints/slots-write.test.ts:164` replays both branches, each asserting 200, `Idempotent-Replayed: true` and an identical body. Run green |
| F3 | A slot deleted between the existence check and the update turned a pause into a 500 | MINOR | **Closed** | `src/server/dal/slots.ts:90,100` throw `NotFoundError` on an empty `.returning()`; `src/server/api/errors.ts:147` maps it to `not_found` with no details, identical to every other 404. A probe called both writers against a missing row and asserted `NotFoundError` |
| F4 | `isDefault` came from a pre-lock scope snapshot and could be reported wrongly | MINOR | **Closed** | `src/server/services/voice.ts:161,187` read `tx.projects.get()` inside the `{ lockProject: true }` transaction and return `isDefault`; `src/server/api/operations/voice.ts:40,75` consume it instead of deriving it. A probe ran two concurrent creates against a default-less project three times — exactly one `isDefault: true` each time — and asserted in the same test that the pre-fix snapshot read gives `[null, null]`, i.e. both would have claimed it |
| F5 | Three documented behaviours asserted nowhere | MINOR | **Closed** | (a) `slots-write.test.ts:216` asserts a queued target keeps its `scheduledAt` across the delete; (b) `accounts-write.test.ts:79` adds the removed-account id, so all three of FR-032's cases are compared; (c) `pipeline.test.ts:97` asserts `PATCH` in `Allow` for `/accounts/{accountId}` and `PATCH`+`DELETE` for `/slots/{slotId}` — it targets the parameterised path rather than the collection `/accounts` the finding's text named, which is the only path where `PATCH` is real, so the intent is met |
| F6 | A stale contract line for `PATCH /voice-profiles/{profileId}` | NOTE | **Closed** | `specs/073-setup-write-api/contracts/http-api.md:98` now reads `VoiceProfileRef — {id, version, isDefault}`, matching `VoiceProfileRefSchema` and both operations' responses |

## Regression check on the remediation

| Surface | Change | Result |
|---|---|---|
| `createProjectSchema`, `updateSettingsSchema` | brand fields widened to accept `null` | Output type unchanged — `taglineSchema` is already `ZodType<string \| null>` — so only the input widened and no caller's types move. `project-brand`, `project-settings`, `project-validation`, `projects` and `/p/new` suites green |
| `CreateProjectRequestSchema` | the same widening, so the OpenAPI request schema gains `"null"` | `tests/integration/api/openapi.test.ts` green, including the FR-042 completeness case |
| `dal/slots.move`, `dal/slots.setPaused` | `return row!` becomes `throw new NotFoundError()` | The only callers are `services/slots.{moveSlot,setSlotPaused}` and, through them, `AccountSlotGrid`'s two server actions. Previously `undefined` reached `toSlot()` and became a 500; now a 404. `accounts-slots` and the co-located `accounts` suites green |
| `services/voice.saveVoiceProfile` | return widened to `{version, isDefault}`; transaction gained `{ lockProject: true }` | Source-compatible for `voice/actions.ts:24` and `voice.test.tsx`. The new lock is its transaction's **first** statement (`dal/scope.ts:294`), the same position the five sibling voice operations take it in, so it cannot invert an existing lock order; the idempotency row is only touched after `op.run` returns, and a second request on the same key never reaches that point (`idempotency.ts:116`). `tests/integration/voice` and the co-located voice suite green |
| `services/voice.createVoiceProfile` | return widened to include `isDefault` | The only caller is the new operation. Green |
| Gates | `cf01885` landed after `874ed22`'s full validation pass and changed three exported signatures | `npx tsc --noEmit` clean; `eslint` on all nine touched files clean; 1,686 tests across the affected suites green |

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Round 1 findings re-verified | 6 | 6 closed | 0 | 0 | 0 |
| Functional requirements (FR-001…FR-052) | 52 | 51 | 1 | 0 | 0 |
| Success criteria (SC-001…SC-009) | 9 | 9 | 0 | 0 | 0 |
| Constitution principles (I…VII) | 7 | 7 | 0 | 0 | 0 |
| User stories / acceptance scenarios | 5 / 24 | 24 | 0 | 0 | 0 |
| Spec edge cases | 15 | 15 | 0 | 0 | 0 |

The one partial FR is FR-048 (`updateVoiceProfile` is one validation-failure case short — F1).
Round 1's two partials, its one partial acceptance scenario and its one partial edge case all
closed: the "all three brand fields" path in US1 #1 and the "Brand fields at their limits" edge case
now hold at the empty bound as well as the upper one.

Re-verified this pass rather than carried forward from round 1:

- **FR-001** the router and the OpenAPI builder are method-generic — `router.ts:24` compares
  `op.method` to the verb with no per-method branch, `openapi.ts:144` keys the path item by
  `op.method.toLowerCase()`, and `src/app/api/v1/[[...path]]/route.ts` already exported all seven
  verbs before this entry. F3 is the one rough edge.
- **FR-002, FR-003, constitution IV** eight operations, one service function each; `updateSlot`
  dispatches to exactly one of two per request over a discriminated union — `schemas.ts:446` is a
  union of two `strictObject`s, so a body carrying both intents or neither fails both branches.
  `tests/lint/api-imports.test.ts` green: no new file reaches the DAL.
- **FR-005** replay is now asserted for all eight operations. The 422-on-different-body and
  `409 idempotency_in_progress` paths are pipeline-generic (`idempotency.ts:118,122`) and covered by
  009's suite. `POST /projects` is correctly `idempotencyMode: "self_commit"`, because
  `createProject` commits in its own cross-project transaction.
- **FR-006** no existing contract moved. `ConflictError` accepts both its old positional `field` and
  the new `{field, reason}` object (`dal/errors.ts:27`), so `dal/projects.ts:74`'s `slug_taken`
  reason is additive; `projects.create` returning the whole `ProjectRecord` is source-compatible
  with `src/app/p/new/actions.ts:18`, which destructures `{slug}`.
- **FR-007…FR-010, FR-052, SC-005** `setup-permission.test.ts` walks `OPERATIONS` itself in both
  directions and fails if a new operation has no fixture, so it cannot silently stop covering a
  path; `KEY_GRANTS` is `Record<ApiKeyPermission, …>` (`dal/scope.ts:91`), so the enum value could
  not be added without a grant; `manage_setup` deliberately omits `SEES`, and the operation-level
  check at `handle.ts:145` refuses a `manage_setup`-only key at every pre-existing path regardless
  of its grants.
- **FR-011, FR-012, SC-008** `src/server/services/accounts.ts` has **no diff** in this entry, so the
  posting-instructions audit row is identical to the browser edit's by construction, with
  `actorUserId: tx.membership.userId || null`. See F4 on the spec's wording.
- **FR-027, FR-032, FR-038, FR-049, SC-006** every 404 in this feature funnels through
  `mapServiceError`'s `apiError("not_found", "Not found.")` with no details
  (`src/server/api/errors.ts:147`), so parity holds structurally rather than by care; `accounts.get`
  filters `removedAt` (`dal/accounts.ts:152`), which is why a removed account is indistinguishable
  from an unknown one on the slot paths too.
- **FR-039, SC-004** the single `internal_error` path round 1 found is closed (F3). Every other
  documented failure maps to an existing `API_ERROR_CODES` entry, and no `internal_error` appeared
  in any of the 1,686 tests or the probes.
- **FR-044…FR-047, SC-002, SC-003** `tests/integration/docs/n8n-provision.test.ts` parses the fenced
  blocks of `docs/n8n.md` §8 out of the file itself, replays them, and asserts at most five calls,
  no `internal_error`, that a second run replays every call, and that the project, profile and slot
  counts are 1/1/8 afterwards. `docs/brand-onboarding.md` and the §8 prose agree on the one step
  that stays in the browser, and agree with FR-020: a key cannot create the project that will hold
  it, so the project-scoped key is made after `POST /projects`.
- **The F1 defect class, swept across the whole feature.** Every other request schema is safe
  against the request-then-service double parse: `localTimeSchema` and `weekdaySchema` have no
  transform (`validation/scheduling.ts:5,12`); `linkUrlSchema` only trims, so it is idempotent
  (`validation/link.ts:18`); `voiceContentInputSchema`'s transforms — hashtag stripping, `dropEmpty`,
  the defaults — are each idempotent on their own output; and `SetPostingInstructionsRequestSchema`
  is a plain `z.string()`, leaving normalisation to the service's single parse.

## What I could not check

- **CI on this branch.** There is still no pushed branch and no PR. I closed the specific gap that
  mattered — `cf01885` had never been typechecked or linted, and now has been — but I did not run
  `pnpm build` or `pnpm db:check`, so a failure confined to the route manifest, the client/server
  boundary or the migration-versus-schema diff would not have shown up here. The schema change
  itself landed in an earlier commit that `874ed22`'s full pass did cover.
- **The migration against a non-empty production database.** `ALTER TYPE … ADD VALUE` on an install
  with millions of `api_keys` rows is unexercised. It is a catalogue-only change and five earlier
  migrations here do the same.
- **The `manage_setup` checkbox in a browser.** `tests/integration/api-keys/ui.test.tsx:63` asserts
  the rendered HTML — id, label, help text, warning, not checked. Nobody clicked it, so keyboard
  focus order and the real submit path for `manage_setup` are unverified end to end.
- **FR-020's second clause.** "No API key may be created for it" is unasserted; `dal/projects.ts:50`
  visibly inserts only an organization, a project and one `member` row, so it is true by reading
  rather than by test. The first clause — the calling key gains no access — *is* asserted, as
  exactly one member row belonging to the key's creator.
- **Concurrency beyond F4's race.** I drove two simultaneous creates at a default-less project, but
  not two simultaneous moves onto the same slot time, nor a pause racing a delete. F3's fix was
  verified at the DAL seam — the `.returning()`-empty path — rather than by winning the real race.
- **OpenAPI consumed by a real client.** The document validates as OpenAPI 3.1 and carries the
  examples the tests demand, but no generator or client was pointed at it.
