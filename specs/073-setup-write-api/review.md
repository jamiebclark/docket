# Review: Public API for project setup — projects, voice profiles, posting instructions and slots

Reviewed 44 file(s) changed across 10 commit(s), against `70826c9...HEAD` (diff-first).

Read in full: `src/server/api/operations/{types,index,errors-doc,projects,voice,slots,accounts}.ts`,
`src/lib/api/schemas.ts` (diff), `src/server/services/{projects,slots,voice}.ts`,
`src/server/services/accounts.ts` (the posting-instructions half),
`src/server/dal/{projects,slots,scope,errors}.ts`, `src/server/api/{handle,router,idempotency,errors,openapi}.ts`,
`src/lib/validation/{brand,link,voice,scheduling,api}.ts`, `src/server/db/schema/api.ts`,
`src/app/p/[projectSlug]/settings/api-keys/CreateKeyForm.tsx`, `src/app/p/new/actions.ts`,
`tests/helpers/api.ts`, all four `tests/integration/api/endpoints/*-write.test.ts`,
`tests/integration/api/{setup-permission,scope-enforcement,openapi,pipeline}.test.ts`,
`tests/integration/docs/{n8n-provision,external-id}.test.ts`, `tests/lint/api-imports.test.ts`,
`docs/{n8n,brand-onboarding,decisions}.md` (diffs), `drizzle/0034_fantastic_dazzler.sql`,
and all six feature artifacts in `specs/073-setup-write-api/`.

Sampled: `drizzle/meta/0034_snapshot.json` (10,373 lines — checked the `manage_setup` enum entry and
the journal entry only), `src/server/services/accounts.ts` outside `setPostingInstructions`.

Ran (targeted, not a full re-run): `tests/integration/api` + `tests/integration/security` —
**35 files, 299 tests, all passing**; and the 13 files this entry touches or adds (144 tests, all
passing). Plus five throwaway probes against the real route module and a real Postgres, since
several documented behaviours had no test: empty/null brand fields on `POST /projects`, a removed
account's 404 parity, a move onto an occupied slot, an `Idempotency-Key` replayed with a different
body, and hashtag normalisation surviving the request→service double parse. Probe files were
deleted; the working tree is clean.

## Verdict

The feature does what the spec asks and the seven passes hang together unusually well: all eight
paths exist, each calls exactly one service function, the `manage_setup` boundary is proven in both
directions by a table-driven test that fails if a future operation forgets a fixture, the
foreign-versus-unknown answers really are byte-identical, and the five widenings the plan predicted
are the only ones that happened. No constitution gate is broken. One real defect survives, and it
was designed in rather than slipped in: every brand field in `CreateProjectRequest` is a Zod
*transform* that the request pipeline runs and then `services/projects.create` runs **again** on its
own output, so an empty, whitespace-only or explicitly null `tagline`, `description` or `websiteUrl`
— the obvious shape for "not set", and what the spec's Assumptions promise means "not set" —
answers `400` with the internal message `Invalid input: expected string, received null` instead of
creating the project. That, plus one missing `Idempotency-Key` replay test that FR-048 names
explicitly, is what I would fix before merging; everything else here is sound.

## Findings

- [ ] MAJOR F1 — An empty, whitespace-only or null brand field on `POST /projects` answers 400 with
      an internal Zod message instead of meaning "not set"
      where:  src/server/services/projects.ts:25, src/lib/api/schemas.ts:405,
              src/server/api/operations/projects.ts:56
      why:    `taglineSchema`, `brandDescriptionSchema` and `brandWebsiteSchema` are
              `z.string().transform(… -> string | null)`. `handle.ts:83` parses the body with
              `CreateProjectRequestSchema`, which runs those transforms, and the operation then hands
              the *parsed* body to `create()`, which parses it a second time with
              `createProjectSchema` — whose brand fields still expect a `string`. Any value that
              normalises to `null` fails the second parse. Confirmed by probe against the real route
              and a real Postgres: `{"tagline":""}`, `{"description":""}`, `{"websiteUrl":""}`,
              `{"tagline":"   "}` and `{"tagline":null}` each answer
              `400 validation_failed, details:[{path:"tagline",message:"Invalid input: expected
              string, received null"}]` and create nothing; `{"tagline":"Fine."}` answers 201. The
              same form in the browser (`updateSettings`, which parses once) accepts `""` happily, so
              the API is stricter than the UI it is meant to replace, and spec Assumptions ("An
              explicit null on a brand field means 'not set'") is not implemented. A provisioning
              workflow that maps an unfilled field to `""` — the normal n8n shape — fails the whole
              create. No test sends an empty brand field, which is why seven green passes missed it.
      owed:   Make the brand fields in `createProjectSchema` (and, for consistency, in
              `updateSettingsSchema`) accept their own transform output as well as a raw string —
              e.g. `taglineSchema.nullable().optional()` — or stop re-parsing an already-parsed body.
              Add integration cases for `""` and `null` on all three fields asserting 201 with the
              field stored as `null`.
      traces: FR-013, FR-017, SC-001, spec Assumptions ("Policy defaults and brand fields are
              optional on create")

- [ ] MAJOR F2 — `PATCH /slots/{slotId}` is the one new operation with no idempotent-replay test,
      which FR-048 requires for every operation
      where:  tests/integration/api/endpoints/slots-write.test.ts:107,
              src/server/api/operations/slots.ts:133
      why:    FR-048 enumerates five cases per operation; `updateSlot` has happy path, validation
              failures, cross-project (via `scope-enforcement.test.ts`) and missing permission (via
              `setup-permission.test.ts`), but nothing sends it the same `Idempotency-Key` twice.
              `POST /slots`, `DELETE /slots/{slotId}`, `PATCH /accounts/{accountId}`, both voice
              operations and `POST /projects` all have one, and `POST /slots/week` is covered by the
              `n8n-provision` re-run, so this is the only gap — and the only operation whose two
              branches (`moveSlot` vs `setSlotPaused`) make the stored-result shape worth pinning.
              `tasks.md` T021 does not claim this case, so the task list is not misleading; the
              requirement is simply unmet.
      owed:   Add a case to `slots-write.test.ts`: `PATCH /slots/{slotId}` twice with the same
              `Idempotency-Key` and the same body, asserting the second answers 200 with
              `Idempotent-Replayed: true` and an identical body — once for the move branch and once
              for the pause branch.
      traces: FR-048, FR-005

- [ ] MINOR F3 — `setPaused` now asserts a row came back, so a slot deleted between the existence
      check and the update turns a pause into a 500
      where:  src/server/dal/slots.ts:99, src/server/services/slots.ts:84
      why:    `setSlotPaused` does `tx.slots.get(id)` (a plain SELECT, no row lock) and then
              `tx.slots.setPaused(id, paused)`. Under READ COMMITTED another transaction can delete
              that slot in between; the UPDATE then matches nothing, `const [row] = …; return row!`
              yields `undefined`, and `toSlot(undefined)` throws a TypeError that
              `mapServiceError` turns into `internal_error` (500). Before this entry `setPaused`
              returned `void`, so the same race was a silent no-op. `move` (`src/server/dal/slots.ts:90`)
              has had the identical `row!` shape all along, so this is consistent with the house
              style rather than a new idea — but it is still the one way these operations can answer
              500, against FR-039's "none may surface as `internal_error`".
      owed:   Have `setPaused` (and `move`, in passing) throw `NotFoundError` when `.returning()`
              comes back empty, or take `FOR UPDATE` in the existence check.
      traces: FR-039, SC-004

- [ ] MINOR F4 — `isDefault` is read from the scope's project snapshot outside the voice service's
      project lock, so it can be reported wrongly
      where:  src/server/api/operations/voice.ts:40, src/server/api/operations/voice.ts:76
      why:    `createVoiceProfile` computes `isDefault = scope.project.defaultVoiceProfileId === null`
              *before* calling the service, while `services/voice.createVoiceProfile` decides the
              same thing inside a `{ lockProject: true }` transaction. Two concurrent creates in a
              project with no default both read `null`, so both responses say `isDefault: true`
              although only one profile becomes the default. `updateVoiceProfile` has the same shape:
              a concurrent `setDefaultVoiceProfile` makes its `isDefault` stale. The field is
              informational and no endpoint here sets a default, so the blast radius is a misleading
              response field, not a wrong write.
      owed:   Return `isDefault` from the service (which already holds the lock and the fresh
              project row) rather than deriving it in the operation.
      traces: FR-021, FR-026

- [ ] MINOR F5 — Three behaviours the contracts document are asserted nowhere
      where:  tests/integration/api/endpoints/slots-write.test.ts:165,
              tests/integration/api/endpoints/accounts-write.test.ts:78,
              tests/integration/api/pipeline.test.ts:88
      why:    (a) FR-036 and US2 scenario 7 say deleting a slot leaves already-scheduled posts at
              their times; the delete test only checks the slot is gone. The move test does assert
              time preservation, and `post_targets.slot_id` is `onDelete: "set null"`
              (`src/server/db/schema/posts.ts:210`), so the behaviour holds — it is just unproven.
              (b) FR-032 names three cases that must answer an identical 404 — unknown, **removed**
              and other-project — and the test covers two; I confirmed the removed case by probe
              (`404 not_found "Not found."`, identical to unknown). (c) FR-001 asks that the
              `Allow`/405 answers handle the new methods with nothing special-cased, but the only
              assertions are `toContain("GET")` on `/accounts`, which pass whether or not `PATCH` is
              listed.
      owed:   Assert a queued target keeps its `scheduledAt` across `DELETE /slots/{slotId}`; add the
              removed-account id to the 404-parity case; assert `PATCH` appears in `Allow` for
              `/accounts` and `DELETE` for `/slots/{slotId}`.
      traces: FR-036, FR-032, FR-001

- NOTE F6 — `specs/073-setup-write-api/contracts/http-api.md:98` says `PATCH /voice-profiles/{profileId}`
  answers "`VoiceProfileRef` without `isDefault` — `{id, version}}`", but the implementation reuses the
  shared `VoiceProfileRefSchema`, which requires `isDefault`, and returns all three fields. The
  implementation is the better choice (one shape for both voice operations, and FR-026 only asks for
  the id and the version); the contract line is now stale.

- NOTE F7 — Three of the seven implementation commits (`185d29a`, `df238ec`, `279229d`) have no
  `Co-Authored-By` trailer, which the constitution's Development Workflow section requires on every
  commit. Not worth rewriting history over; worth not repeating.

## Coverage

| Checked | Count | Satisfied | Partial | Absent | Contradicted |
|---|---|---|---|---|---|
| Functional requirements (FR-001…FR-052) | 52 | 50 | 2 | 0 | 0 |
| Success criteria (SC-001…SC-009) | 9 | 9 | 0 | 0 | 0 |
| Constitution principles (I…VII) | 7 | 7 | 0 | 0 | 0 |
| User stories / acceptance scenarios | 5 / 24 | 23 | 1 | 0 | 0 |
| Spec edge cases | 15 | 14 | 1 | 0 | 0 |

The two partial FRs are FR-013 (brand fields accepted, but an empty one is refused — F1) and
FR-048 (one operation short of an idempotent-replay test — F2). The partial acceptance scenario is
US1 #1, whose "all three brand fields" path works only for non-empty values. The partial edge case
is "Brand fields at their limits", which is satisfied at the upper bound (200/1,000/500 accepted,
one more refused — tested) but not at the empty bound.

Specifically verified rather than assumed:

- **Permission boundary** (FR-007…FR-010, FR-052, SC-005): `setup-permission.test.ts` walks
  `OPERATIONS` itself in both directions and fails if a new operation has no fixture, so it cannot
  silently stop covering a path. `KEY_GRANTS` is `Record<ApiKeyPermission, …>`, so the enum value
  could not be added without a grant. All 299 pre-existing API tests still pass.
- **Isolation** (FR-027, FR-032, FR-038, FR-049, SC-006): the three new resource parameters are in
  the scope test's project-B fixture map; `POST /slots` and `POST /slots/week` carry the account id
  in the body and so have their own byte-identical-404 case; the slug conflict compares a
  visible holder with an invisible one and asserts equal code, message and details.
- **Idempotency** (FR-005): replay asserted for seven of eight operations (F2); 422-on-different-body
  confirmed by probe; `409 idempotency_in_progress` is pipeline-generic and covered by 009's suite.
  `POST /projects` correctly uses `idempotencyMode: "self_commit"` because `createProject` commits in
  its own cross-project transaction, with the global slug constraint as the documented backstop.
- **One service call per operation** (FR-002, constitution IV): eight operations, one service
  function each (`updateSlot` dispatches to exactly one of two per request, which the spec allows).
  `tests/lint/api-imports.test.ts` passes: no new file reaches the DAL except `import type` and
  `dal/errors`.
- **No internal_error** (FR-039, SC-004): every documented failure maps through `mapServiceError` to
  an existing `API_ERROR_CODES` entry; no `internal_error` appeared in any of the 299 tests or the
  probes. The one way to produce one is F3's race.
- **Audit parity** (FR-011, FR-012, SC-008): the posting-instructions row comes from the unchanged
  shared service, with `actorUserId: tx.membership.userId || null` (the key's creator). Project
  creation and all slot and voice writes produce no audit row in the browser either, which research
  D12 settled deliberately — so parity holds by construction.
- **No contract change** (FR-006): `projects.create` returning the whole `ProjectRecord` instead of
  `{slug}` is source-compatible with `src/app/p/new/actions.ts:18`, which destructures `{slug}`.
  `setSlotPaused` gaining a return value is ignored by its UI caller.
- **Docs** (FR-044…FR-047): the `docs/n8n.md` "Provision a brand" section landed as §8, after §7, so
  `n8n-flow.test.ts`'s slice is untouched; `external-id.test.ts` was correctly renumbered to §10 and
  passes; `n8n-provision.test.ts` replays the documented blocks and asserts ≤5 calls, zero
  `internal_error`, and that a re-run creates nothing (1 project, 1 profile, 8 slots).

## What I could not check

- **CI on this branch.** There is no pushed branch and no PR, so I read the implement pass's own
  claim of a full `lint && typecheck && test && db:check && build` in commit `874ed22` rather than a
  CI result. I did not re-run lint, typecheck, build or the full suite (the constitution forbids it
  at review), so a failure confined to files outside `tests/integration/api`, `tests/integration/docs`,
  `tests/integration/security`, `tests/integration/api-keys` and `tests/lint` would not have shown up
  here.
- **The migration against a non-empty production database.** `pnpm db:migrate` was run against a
  local clone by T001/T004; `ALTER TYPE … ADD VALUE` on an install with millions of `api_keys` rows is
  unexercised (it is a catalogue-only change, and five earlier migrations here do the same).
- **The key-form checkbox in a browser.** `ui.test.tsx` asserts the rendered HTML (id, label, help
  text, warning, not checked). Nobody clicked it, so keyboard focus order and the real submit path
  for `manage_setup` are unverified end to end.
- **Genuine concurrency.** F3 and F4 are read-then-write races I reasoned about from the SQL and the
  lock options; I did not drive two simultaneous requests at the same slot or the same default-less
  project to observe them.
- **OpenAPI consumed by a real client.** The document validates as OpenAPI 3.1 and carries the
  examples the tests demand, but no generator or client was pointed at it.
