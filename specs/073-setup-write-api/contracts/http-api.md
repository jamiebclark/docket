# Contract: the eight new HTTP paths

Base `/api/v1`. Authentication, rate limiting, idempotency and the error envelope are the existing
ones (`specs/009-public-api/contracts/http-api.md`); this file states only what is new.

Common to **every** operation below:

- `permission: "manage_setup"` — no key holds it until an owner or admin ticks it.
- `idempotent: true` — `Idempotency-Key` is optional; with one, a repeat of the same body replays the
  stored first response with `Idempotent-Replayed: true`, a different body answers 422
  `idempotency_key_reused`, and a duplicate arriving while the first runs answers 409
  `idempotency_in_progress` with `Retry-After`.
- Errors: 401 `invalid_api_key` (no or bad key), 403 `missing_permission` with
  `details: {permission: "manage_setup"}`, 429 `rate_limited` with `Retry-After`, 400
  `validation_failed` with `details: [{path, message}]`, 500 `internal_error` (which no documented
  failure of these operations produces — SC-004).
- Every response carries `X-Request-Id` and `Cache-Control: no-store`.
- A path parameter that is not a UUID answers 404 before the operation runs; a well-formed UUID
  belonging to another project answers the identical 404 (`{"code":"not_found","message":"Not found."}`,
  no `details`).

---

## 1. `POST /projects` — create a project

**Operation id** `createProject`. **Tag** `Projects`. **Service** `services/projects.create`.
**Idempotency mode** `self_commit` (research D3). **`resourceParams`** none.

Request — `CreateProjectRequest`:

```json
{
  "name": "Up Next",
  "slug": "playupnext",
  "timezone": "America/New_York",
  "defaultApprovalPolicy": "review_required",
  "defaultSchedulingPolicy": "add_to_queue",
  "tagline": "Board games, explained in a minute.",
  "description": "Short, friendly explainers for modern board games.",
  "websiteUrl": "https://playupnext.live"
}
```

Only `name`, `slug` and `timezone` are required. Omitting a policy or a brand field leaves the
project's own default (`review_required`, `leave_as_draft`, `null`). An unknown field is a 400.

| Status | Body | When |
|---|---|---|
| 201 | `Project` | Created. The calling key's creator is the owner; the calling key gains no access and no key is minted for the new project (FR-020). |
| 409 `conflict`, `details.reason = "slug_taken"` | error | The slug is held by **any** project in the install. Identical code, message and `details` whether or not the caller can see the holder (FR-016, SC-006). |
| 409 `conflict`, `details.reason = "no_acting_user"` | error | The key has no creator user account left, so there is nobody to own the project (FR-015). |
| 400 `confirmation_required` | error | `auto_approve` + `add_to_queue` without `confirmUnreviewedQueue: true` (FR-018). |
| 400 `validation_failed` | error | Bad or reserved slug, over-length name, non-IANA `timezone`, over-length tagline or description, non-http(s) website, unknown field. |

201 response:

```json
{
  "id": "6f1c0f6e-2a21-4c51-9a93-1a1f0b7c8d20",
  "slug": "playupnext",
  "name": "Up Next",
  "timezone": "America/New_York",
  "defaultApprovalPolicy": "review_required",
  "defaultSchedulingPolicy": "add_to_queue",
  "tagline": "Board games, explained in a minute.",
  "description": "Short, friendly explainers for modern board games.",
  "websiteUrl": "https://playupnext.live"
}
```

---

## 2. `POST /voice-profiles` — create a voice profile

**Operation id** `createVoiceProfile`. **Tag** `Voice`. **Service** `services/voice.createVoiceProfile`.
**`resourceParams`** none.

Request — `CreateVoiceProfileRequest`: `{ "name": "House voice", "content": { … } }`, content by
`voiceContentInputSchema` (`voiceAndTone`, `audience`, `topicsAndPillars`, `avoid`, `examplePosts`,
`preferredLinks`, `preferredHashtags`; every key optional, `platformGuidance` stripped if sent).

| Status | Body | When |
|---|---|---|
| 201 | `VoiceProfileRef` — `{id, version: 1, isDefault}` | Created at version 1; `isDefault` is true when the project had no default profile (FR-021). |
| 400 `validation_failed` | error | Blank or over-length name, a content field over its limit (the `details.path` names it, e.g. `content.examplePosts.2`), a bad link URL, a malformed hashtag. |

---

## 3. `PATCH /voice-profiles/{profileId}` — append a version

**Operation id** `updateVoiceProfile`. **Tag** `Voice`. **Service** `services/voice.saveVoiceProfile`.
**`resourceParams`** `["profileId"]`.

Request — `UpdateVoiceProfileRequest`: `{ "name": …, "content": {…}, "baseVersion": 1 }`.

| Status | Body | When |
|---|---|---|
| 200 | `VoiceProfileRef` without `isDefault` — `{id, version}` | A version was appended (`version` = `baseVersion` + 1), **or** the submitted name and content were identical to the current version, in which case `version` is unchanged and nothing was appended (FR-024). |
| 409 `conflict` | error, message "This profile changed since you opened it" | `baseVersion` is not the current version (FR-023). |
| 409 `conflict` | error, message "Restore this profile before editing it" | The profile is archived (FR-025). |
| 404 | error | Unknown profile, another project's profile, or a non-UUID path segment. |

---

## 4. `PATCH /accounts/{accountId}` — set posting instructions

**Operation id** `setAccountPostingInstructions`. **Tag** `Accounts`.
**Service** `services/accounts.setPostingInstructions`. **`resourceParams`** `["accountId"]`.

Request — `SetPostingInstructionsRequest`: `{ "instructions": "No hashtags here." }`. `""` clears the
field. This is the **only** field the operation accepts; `displayName`, publish limits, settings,
reconnection and removal are all out of scope, and sending any of them is a 400 (FR-028).

| Status | Body | When |
|---|---|---|
| 200 | `AccountPostingInstructions` — `{accountId, postingInstructions, changed}` | Set, cleared, or already that exact value. `changed: false` means no audit row was written (FR-031). |
| 400 `validation_failed` | error | Over 2,000 characters after normalisation (the message quotes the limit), or any other field in the body. |
| 404 | error | Unknown, removed or another project's account — the same body in all three cases (FR-032). |

`GET /accounts` reports the stored value, and the project's activity log shows one
`account_posting_instructions_update` entry per real change, attributed to the key's creator (FR-011,
SC-008).

---

## 5. `POST /slots` — add one slot

**Operation id** `addSlot`. **Tag** `Slots`. **Service** `services/slots.addSlot`.
**`resourceParams`** none (the account id is in the body — see the test note below).

Request — `AddSlotRequest`: `{ "accountId": "…", "weekday": 1, "localTime": "09:00" }`. Weekday is
ISO, Monday first.

| Status | Body | When |
|---|---|---|
| 201 | `Slot` | Added. |
| 409 `conflict` | error, message "That account already has a slot at that time." | The account already has that weekday and time (FR-033). With an `Idempotency-Key`, a repeat replays the 201 instead. |
| 400 `validation_failed` | error | Weekday outside 1–7, a time that is not 24-hour `HH:MM`, a non-UUID `accountId`, an unknown field. |
| 404 | error | Unknown or another project's `accountId` — identical bodies (FR-038). |

## 6. `POST /slots/week` — book one time on every weekday

**Operation id** `addWeekSlots`. **Tag** `Slots`. **Service** `services/slots.addSlotsForWeek`.
**`resourceParams`** none.

Request — `AddWeekSlotsRequest`: `{ "accountId": "…", "localTime": "09:00" }`. There is no weekday
list: the whole week is the point (`docs/decisions.md` 048).

| Status | Body | When |
|---|---|---|
| 200 | `WeekSlotsResult` — `{added: Slot[], alreadySet: number[]}` | Always, when the account exists. `added` is ascending by weekday; `alreadySet` names the weekdays that already had the time, including paused ones. Seven created and nothing already set, or four created and three already set, are both successes (FR-034). |
| 400 `validation_failed` | error | Bad time, non-UUID account id, unknown field. |
| 404 | error | Unknown or another project's `accountId`. |

Example 200 for a half-booked week:

```json
{
  "added": [
    {"id":"…","accountId":"…","weekday":4,"localTime":"09:00","paused":false},
    {"id":"…","accountId":"…","weekday":5,"localTime":"09:00","paused":false},
    {"id":"…","accountId":"…","weekday":6,"localTime":"09:00","paused":false},
    {"id":"…","accountId":"…","weekday":7,"localTime":"09:00","paused":false}
  ],
  "alreadySet": [1, 2, 3]
}
```

## 7. `PATCH /slots/{slotId}` — move, or pause and unpause

**Operation id** `updateSlot`. **Tag** `Slots`. **Services** `services/slots.moveSlot` (move branch)
and `services/slots.setSlotPaused` (pause branch) — exactly one per request.
**`resourceParams`** `["slotId"]`.

Request — `UpdateSlotRequest`, one of:

```json
{"weekday": 3, "localTime": "18:30"}
```

```json
{"paused": true}
```

| Status | Body | When |
|---|---|---|
| 200 | `Slot` | Moved (same id, new weekday and time; posts already scheduled from it keep their times) or paused/unpaused. |
| 400 `validation_failed` | error | Both intents in one body, neither, a weekday outside 1–7, a bad time, an unknown field (FR-035, FR-037). |
| 409 `conflict` | error | A move onto a weekday and time the account already has. |
| 404 | error | Unknown or another project's slot. |

## 8. `DELETE /slots/{slotId}` — delete a slot

**Operation id** `deleteSlot`. **Tag** `Slots`. **Service** `services/slots.deleteSlot`.
**`resourceParams`** `["slotId"]`. No request body.

| Status | Body | When |
|---|---|---|
| 200 | `DeletedSlot` — `{id, deleted: true}` | Deleted. Posts already scheduled from it keep their times (`slot_id` goes NULL by the foreign key). |
| 404 | error | Unknown, already deleted, or another project's slot. With an `Idempotency-Key`, a repeat replays the first 200 instead. |

---

## OpenAPI document (FR-042, FR-043)

Every operation above appears in `/api/v1/openapi.json` with: a `summary`; a `description` ending in
"Requires the `manage_setup` permission."; its tag; `x-required-permission: "manage_setup"`; the
`Idempotency-Key` header parameter; a request body schema and at least one named request example
(where it takes a body); and, for each status it documents — including 400, 401, 403, 404, 409, 422
and 429 — a description listing the codes that map to it, the shared `Error` schema, the
`X-Request-Id` and `Idempotent-Replayed` headers, `Retry-After` on 429, and at least one example.

The existing document tests must stay green unchanged in intent: valid OpenAPI 3.1, documents
exactly the operations served, unique operation ids, every `$ref` resolves, and every error response
carries the shared error schema with its codes and headers.

## Test notes this contract implies

- `POST /slots` and `POST /slots/week` carry their account id in the **body**, so the
  `resourceParams` walk in `tests/integration/api/scope-enforcement.test.ts` cannot cover them. They
  need their own assertion that a project-B account id and a random UUID produce byte-identical 404s.
- `POST /projects` has no resource parameter and no project-B equivalent: its isolation test is the
  slug conflict (FR-049), which must compare a slug held by a visible project with one held by an
  invisible project.
- The permission matrix test (FR-052) runs both directions: every new operation against a key holding
  every permission except `manage_setup`, and every pre-existing operation against a key holding only
  `manage_setup`.
