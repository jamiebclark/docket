# Data model: Facebook Pages and Instagram providers

**Feature**: `005-meta-facebook-instagram` | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

This feature adds **one** table, `connect_attempts`, which is generic OAuth connect storage for the framework fix G5 ([research D4](./research.md)). Everything else reuses existing columns:

- `social_accounts.{provider_key, external_account_id, display_name, settings, credentials_encrypted, credentials_expires_at, status, last_error}`;
- `post_targets.{step_state, external_id, external_url, last_error}`;
- `publish_attempts.{request_summary, response_summary, error}`.

No enum changes.

---

## 1. New table: `connect_attempts` (project-owned)

One row per started OAuth connect or token paste. It is short-lived, single-use and bound to one user, one session and one project.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` PK, default `gen_random_uuid()` | no | Appears in the chooser URL. It is not a secret, but every read also checks the user and session. |
| `project_id` | `uuid` → `projects.id` `ON DELETE CASCADE` | no | Scope column. Registered in `projectOwnedTables`. |
| `user_id` | `uuid` → `user.id` `ON DELETE CASCADE` | no | The initiating user. |
| `session_id` | `uuid` → `session.id` `ON DELETE CASCADE` | no | Better Auth session id. Signing out deletes the attempt. |
| `group_key` | `text` | no | `[a-z0-9-]+`, a registered connect group (`meta`). |
| `state_hash` | `text` UNIQUE | no | Hex SHA-256 of the 32-byte base64url state. The state itself is never stored. Paste attempts get a random, never-issued value. |
| `candidates_encrypted` | `text` | yes | `enc:v1:…` AES-256-GCM of the JSON `ConnectCandidate[]`, AAD `connect_attempt:<id>`. Null before the exchange, and set back to null on completion. |
| `expires_at` | `timestamptz` | no | `created_at + 10 minutes` (FR-007). |
| `callback_at` | `timestamptz` | yes | When the state was consumed (callback) or the paste was exchanged. Set once. |
| `completed_at` | `timestamptz` | yes | When the chooser was submitted. Set once. |
| `created_at` | `timestamptz` default `now()` | no | |

**Constraints and indexes**

- `connect_attempts_state_hash_uq` UNIQUE (`state_hash`).
- `connect_attempts_expires_idx` on (`expires_at`), for the purge.
- `connect_attempts_completed_after_callback` CHECK (`completed_at IS NULL OR callback_at IS NOT NULL`).
- `connect_attempts_candidates_after_callback` CHECK (`candidates_encrypted IS NULL OR callback_at IS NOT NULL`).
- `connect_attempts_group_key_format` CHECK (`group_key ~ '^[a-z0-9-]+$'`).

**State transitions**

```text
created (callback_at null) ──callback, state valid──▶ called_back (candidates null) ──exchange ok──▶ ready (candidates set)
     │                                │                                                               │
     │                                └──exchange failed / platform error──▶ dead (left to expire)      ├──choose──▶ completed (candidates null)
     └──expires_at passes──▶ expired (unreadable; purged ≥ 1 h later)                                  └──expires_at passes──▶ expired
paste: created directly as ready (callback_at = now, candidates set)
```

Every read requires `expires_at > now()`. Only `ready` rows reach the chooser.

**Repository** (`src/server/dal/connect-attempts.ts`; signatures are in [contracts/connect.md](./contracts/connect.md))

| Method | Scope | Statement |
|---|---|---|
| `create({ userId, sessionId, groupKey, stateHash, expiresAt })` | project | `INSERT … RETURNING id` |
| `createReady({ userId, sessionId, groupKey, candidatesEncrypted(id) , expiresAt })` | project | INSERT, then UPDATE with ciphertext (AAD needs the id) in one tx |
| `lookupByStateHash(hash)` | **cross-project** (reason "resolve connect state") | `SELECT a.*, p.slug FROM connect_attempts a JOIN projects p …` |
| `consumeState(id, { userId, sessionId, now })` | project | `UPDATE … SET callback_at = now WHERE id AND callback_at IS NULL AND expires_at > now AND user_id AND session_id RETURNING id` |
| `storeCandidates(id, ciphertext)` | project | `UPDATE … WHERE id AND callback_at IS NOT NULL AND completed_at IS NULL` |
| `getReady(id, { userId, sessionId, now })` | project | `SELECT … WHERE id AND user/session AND callback_at NOT NULL AND completed_at IS NULL AND candidates NOT NULL AND expires_at > now` |
| `getReadyForUpdate(id, …)` | project | as above, `FOR UPDATE` |
| `complete(id, now)` | project | `UPDATE … SET completed_at = now, candidates_encrypted = NULL` |
| `purgeExpired(now)` | **cross-project** (reason "purge expired connect attempts") | `DELETE … WHERE expires_at < now − 1 hour` |

---

## 2. Accounts (existing table, new provider keys)

### Facebook account (`provider_key = 'facebook'`)

| Field | Value |
|---|---|
| `external_account_id` | Page id (digits) |
| `display_name` | Page name from the listing |
| `settings` | `{}`. Schema: `z.object({}).strip()` |
| credentials (decrypted) | `{ pageToken: string }` |
| `credentials_expires_at` | `null`. Page tokens have no expiry, so the account is never in the refresh section. |
| `status` | `active`, or `needs_reauth` via G7 |

### Instagram account (`provider_key = 'instagram'`)

| Field | Value |
|---|---|
| `external_account_id` | Instagram professional account id (digits) |
| `display_name` | `"<Page name> · Instagram"` (R8) |
| `settings` | `{ pageId?: string }`. Schema: `z.object({ pageId: z.string().regex(/^\d{1,40}$/).optional() })`. Optional so `settingsSchema.parse({})` succeeds (registry invariant test). Non-secret, informational. |
| credentials (decrypted) | `{ pageToken: string }`, the linked Page's token (decision 3) |
| `credentials_expires_at` | `null` |
| `default publish limit` | provider `defaultPublishLimit = { count: 100, windowSeconds: 86_400 }` |

Credentials are validated on read by each provider (`pageTokenCredentials = z.object({ pageToken: z.string().min(20).max(2048) })`). A missing or malformed credential in `advance` is `fatal_error` + `credentialsInvalid` ("The stored token is unreadable"). No request is sent.

**Invariants**

- The same Page can be a Facebook account in several projects, as separate rows with separate ciphertexts (the existing unique index is per project).
- A Page and its linked Instagram account may both be connected. Each row holds its own encrypted copy of the same Page token. Invalidation is detected per row, on that row's next call.
- Reconnect = the same `(project, provider_key, external_account_id)` → `upsertConnected` updates in place: new ciphertext, `status = active`, `last_error = null`.

---

## 3. Candidate (in `connect_attempts.candidates_encrypted`, never in the browser)

```ts
interface ConnectCandidate {
  providerKey: string;          // "facebook" | "instagram"; must be a registered provider in the same group
  externalId: string;           // 1..200 chars
  displayName: string;          // validated by displayNameSchema, then trimmed
  settings: unknown;            // parsed by that provider's settingsSchema before storing
  credentials: unknown;         // { pageToken }
  expiresAt: string | null;     // ISO; null for Page tokens
  parent?: { providerKey: string; externalId: string }; // instagram → its facebook Page
  notes?: string[];             // e.g. "No Instagram professional account is linked."
}
```

**Browser view** (`CandidateView`, built on the server; it has no `settings`, `credentials` or `expiresAt`):

```ts
interface CandidateView {
  key: string;                  // `${providerKey}:${externalId}`, the checkbox value
  providerKey: string;
  providerName: string;
  externalId: string;
  displayName: string;
  parentKey: string | null;
  notes: string[];
  alreadyConnected: boolean;    // a live account with the same provider + external id exists in this project
  needsReauth: boolean;         // …and it is needs_reauth
}
```

Plus `missing: { accountId, displayName, providerName }[]`: the project's `needs_reauth` accounts in this group that are not among the candidates (US7 AS3).

**Validation on store**: a group returning more than **500** candidates, or a ciphertext over **1 MB**, is refused ("Too many Pages were returned").

---

## 4. Step state (`post_targets.step_state`, plain jsonb, non-secret)

### Facebook

```ts
// null on the first step
type FacebookState = { v: 1; photoIds: string[] }; // ids of unpublished photos, in image order
```

`stepFor(state, settings, { mediaCount })`:

| Condition | Step | mayPublish |
|---|---|---|
| `mediaCount === 0` | `publish_feed` | ✔ |
| `mediaCount === 1` | `publish_photo` | ✔ |
| `2 ≤ mediaCount ≤ 10`, `photoIds.length < mediaCount` (state null or valid) | `upload_photo_<photoIds.length + 1>` | ✘ |
| `2 ≤ mediaCount ≤ 10`, `photoIds.length === mediaCount` | `publish_feed` | ✔ |
| invalid state (wrong shape, `photoIds.length > mediaCount`), or `mediaCount > 10` | `invalid` | ✘ (advance → `fatal_error`) |

### Instagram

```ts
type InstagramState = {
  v: 1;
  mediaType: "IMAGE" | "CAROUSEL";    // later kinds (VIDEO, REELS) add values + steps
  items: string[];                     // carousel item container ids, in image order ([] for IMAGE)
  container: string | null;            // the image or carousel container id
  createdAt: string | null;            // ISO, when `container` was created (polling cap, 23 h guard)
  checks: number;                      // status checks made on this container
  ready: boolean;                      // status_code was FINISHED
  quotaChecked: boolean;               // the quota step passed or was unreadable
  recreations: number;                 // 0..2, containers re-created after EXPIRED / age guard
};
```

`stepFor(state, settings, { mediaCount })`. "Valid" means the state parses with the zod schema, its `mediaType` matches `mediaCount` (1 → IMAGE, 2–10 → CAROUSEL), `items.length ≤ mediaCount`, and the flags are consistent (`ready` implies `container`, `quotaChecked` implies `ready`):

| Condition | Step | mayPublish |
|---|---|---|
| `mediaCount === 0` or `> 10` | `invalid` | ✘ |
| state null or invalid, `mediaCount === 1` | `create_container` | ✘ |
| state null or invalid, `mediaCount ≥ 2` | `create_item_1` | ✘ |
| CAROUSEL, `items.length < mediaCount` | `create_item_<items.length + 1>` | ✘ |
| CAROUSEL, all items, `container === null` | `create_carousel` | ✘ |
| IMAGE, `container === null` (after recreation) | `create_container` | ✘ |
| `container` set, `!ready` | `check_status` | ✘ |
| `ready`, `!quotaChecked` | `check_quota` | ✘ |
| `quotaChecked` | `publish` | ✔ |

Invalid state restarts from the first create step. That is safe because no create step can publish. A stale container is just left to expire.

**Transitions** (`advance` result → next state):

| Step | Outcome | Result |
|---|---|---|
| `create_item_i` | `{ id }` | `continue` `{ items: [...items, id] }`, no delay |
| `create_container` / `create_carousel` | `{ id }` | `continue` `{ container: id, createdAt: now, checks: 0, ready: false }`, `notBefore = now + 10 s` |
| `check_status` | `IN_PROGRESS`, under 60 min since `createdAt` | `continue` `{ checks + 1 }`, `notBefore = now + min(10 s·2^checks, 300 s)` |
| `check_status` | `IN_PROGRESS`, 60 min or more | `fatal_error` "Instagram did not finish processing the media." |
| `check_status` | `FINISHED` | `continue` `{ ready: true }` |
| `check_status` | `ERROR` | `fatal_error` (redacted reason) |
| `check_status` | `EXPIRED`, `recreations < 2` | `continue` fresh `{ items: [], container: null, createdAt: null, checks: 0, ready: false, quotaChecked: false, recreations + 1 }` |
| `check_status` | `EXPIRED`, `recreations === 2` | `fatal_error` "Instagram media expired before it could be published (tried 3 times). Retry the post." |
| `check_status` | `PUBLISHED` | `ambiguous` "Instagram reports this media as already published." |
| `check_quota` | `now − createdAt ≥ 23 h` | recreate exactly as for `EXPIRED` (cap applies). No request is sent. |
| `check_quota` | usage ≥ total | `retryable_error` `notBefore = now + 1 h`, state unchanged |
| `check_quota` | ok / unreadable | `continue` `{ quotaChecked: true }` |
| `publish` | `{ id }` | `done` `externalId = id` |
| any | per [research D12](./research.md) table | `retryable_error` / `fatal_error` (+ `credentialsInvalid`) / `ambiguous` |

A `retryable_error` keeps the state, because the engine stores state only on `continue`. The same step therefore re-runs after the backoff.

---

## 5. Attempt summaries (`publish_attempts.request_summary` / `response_summary`)

Allowed keys only (FR-033). The summary builder is a typed function, so new keys need a code change:

| Key | Where | Example |
|---|---|---|
| `step` | request | `"create_item_2"` |
| `imageIndex` | request | `2` |
| `mediaType` | request | `"CAROUSEL"` |
| `containerId` / `photoId` / `itemIds` | request/response | `"17890…"` |
| `statusCode` | response | `"IN_PROGRESS"` |
| `checks`, `recreations` | response | `3`, `1` |
| `quotaUsage`, `quotaTotal`, `quota` | response | `12`, `100`, `"unknown"` |
| `httpStatus` | response | `400` |
| `graphCode`, `graphSubcode`, `graphType`, `traceId` | response | `190`, `463`, `"OAuthException"`, `"AbC…"` |
| `externalId` | response | `"1234_5678"` |
| `linkSent` | request | `true` |

Never stored: tokens, the app secret, the authorization code, URLs carrying query strings, full bodies, Graph `message` text (it goes into `error`, scrubbed and capped).

---

## 6. Type changes (framework, generic)

These are summarised here and specified in [contracts/providers.md](./contracts/providers.md):

| Type | Change | Fix |
|---|---|---|
| `ConnectStrategy` | `{ strategy: "oauth"; group: OAuthConnectGroup }` (was `{ strategy: "oauth" }`) | G5 |
| `OAuthConnectGroup` | new: `key`, `displayName`, `environment`, `authorizationUrl`, `exchangeCode`, `describeCallbackError?`, `pasteToken?`, `setupDoc?` | G5, G6, G8 |
| `ConnectCandidate`, `CandidatesResult` | new | G5 |
| `StepResult` `fatal_error` | `credentialsInvalid?: true` | G7 |
| `AccountsRepo` | `markCredentialsInvalid(id, { expectedCiphertext, reason })` | G7 |
| `EnvIssue` | moved to `src/providers/types.ts` as `ProviderEnvIssue` (same shape) so providers can return it. `src/server/env.ts` keeps its alias. | G8 |
