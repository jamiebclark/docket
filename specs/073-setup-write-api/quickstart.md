# Quickstart: proving the setup write API works

This is the validation guide, not the implementation. Every step is a real run: a real Postgres, the
real route module, the real services. Nothing here needs platform credentials, so nothing is
"verified with mocks only" (constitution II).

## Prerequisites

- Node 24, pnpm, dependencies installed **inside this worktree** (`pnpm install` — a worktree has no
  `node_modules` of its own).
- A Postgres for the tests. Locally that is the test database on **port 5555**, not the 5432 in
  `.env.example`; see `docs/getting-started.md`. CI brings up its own service.
- Migrations applied: `pnpm db:migrate`.

## 1. The migration is real and the snapshot matches

```bash
pnpm db:generate     # writes drizzle/0034_*.sql and the meta snapshot
pnpm db:check        # fails if the snapshot and the schema disagree
```

Then confirm the value exists:

```bash
psql "$DATABASE_URL" -c "select unnest(enum_range(null::api_key_permission));"
```

Expect `read, write_posts, generate, auto_approve, manage_jobs, manage_setup` — `manage_setup` last,
so no stored key array shifts.

## 2. Per-task checks while building

Per the constitution's "run checks in proportion to the change":

```bash
pnpm vitest run tests/integration/api/endpoints/projects-write.test.ts
pnpm vitest run tests/integration/api/endpoints/voice-write.test.ts
pnpm vitest run tests/integration/api/endpoints/accounts-write.test.ts
pnpm vitest run tests/integration/api/endpoints/slots-write.test.ts
pnpm vitest run tests/integration/api/setup-permission.test.ts
pnpm vitest run tests/integration/api/scope-enforcement.test.ts
pnpm vitest run tests/integration/api/openapi.test.ts
pnpm vitest run tests/lint/api-imports.test.ts
pnpm typecheck                       # types changed, in operations/types.ts
pnpm lint <the files you touched>
```

## 3. The final pass, once

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

`pnpm build` is required: the operation table, the OpenAPI document and a client component all
change. `pnpm db:check` is required: the schema changed.

---

## 4. Proving each user story

Each of these is the spec's own "Independent Test", written as what to run and what to look for.

### US1 — Stand a new brand up over HTTP (P1)

`tests/integration/api/endpoints/projects-write.test.ts` and `voice-write.test.ts`.

1. Create a key holding `manage_setup` in an existing project.
2. `POST /projects` with a name, an unused slug, a valid zone, both policy defaults and all three
   brand fields. Expect 201 and a body carrying all nine fields; read the project row back and
   confirm the values and that the key's creator is its `owner` member.
3. Repeat the identical request with the same `Idempotency-Key`. Expect the same body,
   `Idempotent-Replayed: true`, and exactly one project with that slug.
4. Create a project owned by someone else with a slug project A's key cannot see; then
   `POST /projects` with that slug from A's key. Expect 409, `details.reason === "slug_taken"`, and a
   body byte-identical to the same attempt against a visible project's slug.
5. `POST /projects` with `timezone: "Mars/Olympus"`. Expect 400, `details[0].path === "timezone"`,
   and no new project row.
6. `POST /voice-profiles` in a project with no default profile. Expect 201, `version: 1`,
   `isDefault: true`, and the project's `default_voice_profile_id` now pointing at it.
7. `POST /voice-profiles` with a 2,001-character `voiceAndTone`. Expect 400 with the path naming
   `content.voiceAndTone`, and no profile row.

### US2 — Book a brand's posting week over HTTP (P1)

`tests/integration/api/endpoints/slots-write.test.ts`.

1. Against an account with no slots, `POST /slots/week` at `09:00`. Expect 200, seven slots in
   `added` ordered Monday to Sunday, `alreadySet: []`, and seven rows in the table.
2. Delete three of them, pause one of the rest, and repeat the same call. Expect 200, three in
   `added`, the four remaining weekdays in `alreadySet` (the paused one among them), and the paused
   slot still paused.
3. `POST /slots` for a weekday and time the account lacks: 201. The same call again with no
   `Idempotency-Key`: 409 `conflict`, not 500. The same call again **with** the first call's
   `Idempotency-Key`: the stored 201, replayed, and still one slot.
4. `PATCH /slots/{slotId}` with `{weekday, localTime}`: 200, same id, new values; a post already
   scheduled from that slot keeps its `scheduled_at`.
5. `PATCH` with `{paused: true}` then `{paused: false}`: 200 each, `paused` following.
6. `PATCH` with `{weekday, localTime, paused}` in one body: 400.
7. `DELETE /slots/{slotId}`: 200 `{id, deleted: true}`; the slot is gone and a post scheduled from it
   keeps its time. A second `DELETE` with no key: 404; with the first key: the stored 200.
8. `POST /slots` with `weekday: 8`, and with `localTime: "9:00"`: 400 each, nothing written.

### US3 — A key that cannot do setup still cannot (P1)

`tests/integration/api/setup-permission.test.ts` plus the extended
`tests/integration/api/scope-enforcement.test.ts`.

1. Build a key with every permission **except** `manage_setup`. Call all eight new paths. Expect 403,
   `code: "missing_permission"`, `details: {permission: "manage_setup"}`, the message naming it, and
   no row written anywhere (snapshot the four tables before and after).
2. Call each new path with no key: 401.
3. Build a key with **only** `manage_setup`. Call every pre-existing keyed operation. Expect 403
   naming that operation's own permission.
4. Run the whole pre-existing API suite unchanged: `pnpm vitest run tests/integration/api` — every
   previously passing assertion still passes, which is SC-005.
5. Render the key form (`tests/integration/api-keys/ui.test.tsx` is the existing place) and confirm
   the `manage_setup` checkbox exists, is labelled, carries its plain-language help and its warning
   that it can retime a schedule and rewrite a voice, and is **not** checked by default.

### US4 — Posting instructions over HTTP (P2)

`tests/integration/api/endpoints/accounts-write.test.ts`.

1. `PATCH /accounts/{accountId}` with 500 characters: 200, `changed: true`. `GET /accounts` reports
   the text. One `account_posting_instructions_update` audit row, `actor_user_id` = the key's
   creator, `details` carrying `previous` and `next`.
2. Repeat with the identical text: 200, `changed: false`, still one audit row.
3. 2,001 characters: 400 quoting the 2,000 limit; the stored value unchanged.
4. `{"instructions": ""}`: 200, the field null, a new audit row.
5. Another project's account id, then a random UUID: 404 each, byte-identical bodies.
6. `{"instructions": "x", "displayName": "y"}`: 400.

### US5 — Refine a voice profile without losing its history (P2)

`tests/integration/api/endpoints/voice-write.test.ts`.

1. Create a profile, `PATCH` it with changed content and `baseVersion: 1`: 200, `version: 2`;
   version 1's row still holds its original content.
2. `PATCH` again with `baseVersion: 1`: 409, no version 3.
3. `PATCH` with the identical name and content and the current `baseVersion`: 200, the same version,
   nothing appended.
4. Archive the profile through the service, then `PATCH`: 409 telling the caller to restore it.
5. Another project's profile id: 404, identical to an unknown id.

---

## 5. Proving the cross-cutting criteria

| Criterion | How it is proven |
|---|---|
| SC-001 (runbook steps 4–7 drivable) | `docs/brand-onboarding.md` is rewritten and `tests/integration/docs/n8n-provision.test.ts` replays the documented calls end to end. |
| SC-002 (at most five calls) | The provisioning test counts its requests and asserts the count. |
| SC-003 (a re-run creates nothing twice) | The provisioning test runs twice and compares counts of projects, voice profiles, versions and slots. |
| SC-004 (no `internal_error`) | Each endpoint test asserts the error code is never `internal_error` on every failure path it exercises. |
| SC-005 (old keys unchanged) | The full pre-existing API suite, unmodified. |
| SC-006 (no existence disclosure) | The extended scope test for `accountId`, `profileId` and `slotId`; the body-borne-id test for `POST /slots` and `POST /slots/week`; the slug-conflict test for `POST /projects`. |
| SC-007 (callable from the document alone) | `tests/integration/api/openapi.test.ts` asserts a summary, a request example and per-status response examples for each new operation, and validates the document as OpenAPI 3.1. |
| SC-008 (activity log indistinguishable) | The posting-instructions audit assertion above; no other new operation writes an audit row. |
| SC-009 (no secrets) | `pnpm vitest run tests/integration/security/secret-scan.test.ts`, unmodified. |

## 6. Manual smoke (optional, after the suite is green)

```bash
pnpm dev
# create a key in Settings -> API keys with manage_setup ticked, then:
curl -s -X POST localhost:3000/api/v1/projects \
  -H "authorization: Bearer dkt_..." -H "content-type: application/json" \
  -H "idempotency-key: smoke-1" \
  -d "{\"name\":\"Smoke\",\"slug\":\"smoke-brand\",\"timezone\":\"Europe/London\"}"
curl -s localhost:3000/api/v1/openapi.json | jq ".paths | keys"
```

The second command should list `/projects`, `/voice-profiles`, `/voice-profiles/{profileId}`,
`/accounts/{accountId}`, `/slots`, `/slots/week` and `/slots/{slotId}` beside the existing paths.
A second `POST` with the same `Idempotency-Key` should answer identically with
`Idempotent-Replayed: true`; with a new key and the same slug it should answer 409 `slug_taken`.
