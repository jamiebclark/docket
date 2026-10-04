# Data model: Threads provider

**Feature**: `006-threads-provider` | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

**No schema change and no migration.** Everything below lives in columns that already exist (`social_accounts`, `post_targets`, `connect_attempts`) or in TypeScript types.

---

## 1. Threads account (`social_accounts` row)

| Column | Value for Threads |
|---|---|
| `provider_key` | `threads` |
| `external_account_id` | Threads user id from `GET /v1.0/me?fields=id,username` (string of digits, ≤ 40) |
| `display_name` | `@<username>`, or the id when no username was returned |
| `settings` | `ThreadsSettings` (§2): `{}` normally; `{ estimatedExpiry }` after a paste saved as is |
| `credentials_encrypted` | AES-256-GCM of `ThreadsCredentials` (§3), with AAD bound to the row id (existing) |
| `credentials_expires_at` | `= credentials.expiresAt`, so the scheduled refresh can find it |
| `status` | `active` / `needs_reauth` (existing enum) |
| `last_error` | Secret-free text: refusal reasons, transient-renewal notes, the G7 "Reconnect … to publish" text |
| `last_refreshed_at` | Set by a successful renewal (existing) |
| `refresh_lease_until` / `refresh_lease_owner` | Existing lease. **G11**: may be set to a future time with owner `null` to park a transient refresh until its `retryAt` (capped at +24 h) |
| `publish_limit_count` / `publish_limit_window_seconds` | Optional account override (existing). The provider default is 250 / 86 400 s |

**Identity rule**: one row per (project, provider key, external id) that is not removed. This is the existing `upsertConnected` behaviour. A reconnect updates the row in place, reactivates it and clears `last_error` (US1 #4).

**State transitions** (existing enum, new triggers):

```text
active ──refresh: definitive refusal / token expired / unreadable──▶ needs_reauth
active ──publish: error 190 (credentialsInvalid, ciphertext unchanged)──▶ needs_reauth
active ──refresh: transient (network, 5xx, rate limit, unreadable 2xx, token < 24 h)──▶ active (last_error noted)
needs_reauth ──connect callback or paste, chosen in the chooser──▶ active
```

## 2. `ThreadsSettings` (non-secret, `settings` column)

```ts
z.object({
  /** ISO time. Present only when a pasted token was saved without a confirmed expiry (D6 step 3). */
  estimatedExpiry: z.iso.datetime().optional(),
}).strip()
```

- Read by `accountNotes` (G13). The note shows only while `credentialsExpireAt` equals `estimatedExpiry` to the millisecond.
- Never read by publishing. `stepFor` ignores settings.

## 3. `ThreadsCredentials` (encrypted)

```ts
z.object({
  v: z.literal(1),
  accessToken: z.string().min(1).max(4000), // the only secret
  issuedAt: z.number().int().nonnegative(),  // epoch ms
  expiresAt: z.number().int().positive(),    // epoch ms
  expiryEstimated: z.boolean(),
})
```

Validation rules:

- `expiresAt > issuedAt`. Otherwise the credentials are treated as unreadable.
- Timestamps are numbers, not strings, so `secretValues()` (which treats every string as a secret) only ever collects the token.
- **Only the long-lived token is stored** (FR-013). The code and the short-lived token are never put in credentials, candidates, state, summaries or messages.

Sources of a credential:

| Source | `accessToken` | `issuedAt` | `expiresAt` | `expiryEstimated` |
|---|---|---|---|---|
| OAuth callback (code → short-lived → `th_exchange_token`) | long-lived | exchange time | now + `expires_in` (else 60 d) | false |
| Paste → exchange OK | long-lived | now | now + `expires_in` (else 60 d) | false |
| Paste → exchange refused → refresh OK | renewed | now | now + `expires_in` (else 60 d) | false |
| Paste → both refused → profile OK | the pasted token | now (paste time) | now + 60 d | **true** (+ `settings.estimatedExpiry`) |
| Scheduled renewal OK | renewed | renewal time | now + `expires_in` (else 60 d) | false |

## 4. Threads connect candidate (in `connect_attempts.candidates_encrypted`, existing)

`ConnectCandidate` with:

- `providerKey: "threads"`;
- `externalId`, `displayName` as in §1;
- `settings: ThreadsSettings`;
- `credentials: ThreadsCredentials`;
- `expiresAt: new Date(credentials.expiresAt)`;
- `notes`, which may include:
  - "Publishing permission was not granted. Connect again and allow it." (only when the reply lists the granted permissions);
  - "Expiry estimated: Docket could not confirm when this token expires and assumes 60 days. Paste a freshly generated token for the best estimate." (paste step 3).

There is always exactly one candidate per successful exchange.

## 5. Publish step state (`post_targets.step_state`, plain JSON, non-secret)

```ts
z.object({
  v: z.literal(1),
  /** Future kinds (VIDEO) add values here and their own create/check steps (FR-005). */
  mediaType: z.enum(["TEXT", "IMAGE", "CAROUSEL"]),
  /** Carousel item container ids in image order; [] for TEXT and IMAGE. */
  items: z.array(z.string().regex(/^\d{1,40}$/)).max(20),
  /** The container that will be published (TEXT/IMAGE container or the CAROUSEL parent). */
  container: z.string().regex(/^\d{1,40}$/).nullable(),
  /** ISO time `container` was created: 30 s first check, 5-minute processing cap, 23 h age guard. */
  createdAt: z.iso.datetime().nullable(),
  checks: z.number().int().min(0),
  ready: z.boolean(),
  quotaChecked: z.boolean(),
  /** Recreations in this publish attempt (EXPIRED or aged). Max 2. */
  recreations: z.number().int().min(0).max(2),
})
```

Validity against the post (`validState(state, mediaCount)`) returns `null` when the state must restart from the first create step (FR-030):

- `mediaType` ≠ the type derived from `mediaCount` (0 → TEXT, 1 → IMAGE, 2–20 → CAROUSEL);
- `items.length > mediaCount`, or `items.length > 0` for a non-carousel;
- `ready` without `container`, or `quotaChecked` without `ready`;
- `container` set on a carousel while `items.length < mediaCount`.

Initial state: `{ v: 1, mediaType, items: [], container: null, createdAt: null, checks: 0, ready: false, quotaChecked: false, recreations: 0 }`.

### Step table (`stepFor`, pure and total)

| Condition (after `validState` / initial) | Step name | `mayPublish` |
|---|---|---|
| `mediaCount > 20` or not finite | `invalid` | false |
| CAROUSEL, `items.length < N` | `create_item_<k>` (k = items.length + 1) | false |
| CAROUSEL, `items.length = N`, no container | `create_carousel` | false |
| TEXT or IMAGE, no container | `create_container` | false |
| container, not `ready` | `check_status` | false |
| `ready`, not `quotaChecked` | `check_quota` | false |
| `ready` and `quotaChecked` | `publish` | **true** |

### Transitions (what `advance` returns)

| Step | Outcome | Result | Next state |
|---|---|---|---|
| `create_item_k` | id returned | `continue` | `items += id` |
| `create_carousel` / `create_container` | id returned | `continue`, `notBefore = now + 30 s` | `container = id`, `createdAt = now`, `checks = 0`, `ready = false`, `quotaChecked = false` |
| any create | 2xx without id / transient | `retryable_error` | unchanged |
| `check_status` | `FINISHED` | `continue` | `ready = true`, `checks + 1` |
| `check_status` | `IN_PROGRESS`, `now − createdAt < 5 min` | `continue`, `notBefore = now + 60 s` | `checks + 1` |
| `check_status` | `IN_PROGRESS`, `≥ 5 min` | `fatal_error` "Threads did not finish processing the post." | — |
| `check_status` | `ERROR` | `fatal_error` (reason if given) | — |
| `check_status` | `EXPIRED`, `recreations < 2` | `continue` | initial state with `recreations + 1` |
| `check_status` | `EXPIRED`, `recreations = 2` | `fatal_error` | — |
| `check_status` | `PUBLISHED` | `ambiguous` | — |
| `check_status` | other value | `retryable_error` | unchanged |
| `check_quota` | `now − createdAt ≥ 23 h` | `continue` (recreate, cap as above) | initial state with `recreations + 1` |
| `check_quota` | usage ≥ total | `retryable_error`, `notBefore = now + 1 h` | unchanged |
| `check_quota` | under limit or unknown | `continue` | `quotaChecked = true` |
| `publish` | id returned | `done` (externalId = id, no URL) | — |
| `publish` | rate limit | `retryable_error` | unchanged |
| `publish` | timeout, reset, 5xx, temporary, unparseable, no id | `ambiguous` | — |
| `publish` | other rejection | `fatal_error` + " Retry the post to create it again." | — |
| any step | error 190 | `fatal_error`, `credentialsInvalid: true` | — |
| any step | DNS failure or connection refused (pre-send) | `retryable_error` | unchanged |

## 6. Framework types changed (generic, G9–G13)

Full signatures are in [contracts/providers.md](./contracts/providers.md). In summary:

| Gap | Type / member | Change |
|---|---|---|
| G9 | `TextCountingRule` | `BuiltInCountingRule \| CustomCountingRule` (`{ kind: "custom"; name; unit; count(text) }`) |
| G9 | `TargetCheck.countingRule` | `string \| null` (the rule's name) instead of the enum |
| G10 | `OAuthConnectGroup.redirectRequirement?` | `{ https; publicHost; reason; doc? }` |
| G10 | `ConnectGroupView` | `+ available: boolean`, `+ unavailable: { reason: string; doc: string \| null } \| null` |
| G11 | `RefreshPatch` | `+ refreshLeaseUntil?: Date` (owner cleared) |
| G11 | `applyRefreshResult(…, opts?)` | `+ opts.holdTransient?: boolean`: a transient result with `retryAt` parks the lease until `min(retryAt, now + 24 h)` (scheduled section only) |
| G12 | `OAuthConnectGroup.callbackHint?` | static string |
| G12 | `CallbackOutcome` (`kind: "accounts"`) | `+ groupKey: string` |
| G13 | `SocialProvider.accountNotes?` | `({ settings, credentialsExpireAt }) => string[]` |
| G13 | `AccountView` | `+ notes: string[]` |

## 7. Environment (declared by the `threads` group, G8)

| Variable | Secret | Required | Rule |
|---|---|---|---|
| `THREADS_APP_ID` | no | no (all-or-none) | digits, 5–30 |
| `THREADS_APP_SECRET` | yes | no (all-or-none) | 32 hex, or 16–128 non-space characters (same rule as Meta) |
| `THREADS_GRAPH_BASE` | no | no | empty → `https://graph.threads.com`; otherwise an `https:` origin with no path, query, fragment or credentials |

Issues carry names and reasons only. Without both id and secret, the group is "not configured": the connect section says so and points to `docs/meta-setup.md`, and Facebook, Instagram and the other providers keep working.
