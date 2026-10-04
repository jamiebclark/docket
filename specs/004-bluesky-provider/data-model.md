# Data model: Bluesky provider

**Feature**: `004-bluesky-provider` | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

**No database schema change and no migration.** Everything below fits in columns that already exist:

- `social_accounts.settings` (jsonb);
- `credentials_encrypted` (text, AES-256-GCM, AAD `social_account:<id>`);
- `credentials_expires_at`;
- `refresh_lease_owner` and `refresh_lease_until`;
- `post_targets.step_state` (jsonb);
- `external_id` and `external_url`.

The `publish_attempt_outcome` enum is **not** extended. The "refresh busy / account flagged" release reuses `released`. SC-008 holds.

## 1. Bluesky account (`social_accounts` row)

| Column | Value for Bluesky |
|---|---|
| `provider_key` | `"bluesky"` |
| `external_account_id` | the account's DID (`did:plc:…` / `did:web:…`), from `createSession.did` |
| `display_name` | the handle returned by the platform. Updated when a refresh returns a different handle for the same DID (FR-025) |
| `settings` | `{ "pdsUrl": "https://bsky.social" }` (see §2) |
| `credentials_encrypted` | encrypted JSON of §3 |
| `credentials_expires_at` | the **refresh** JWT's `exp`, or `now + 60 d` if it cannot be read (D13) |
| `status` | `active` / `needs_reauth` |
| `last_error` | secret-free reason. Set on a definitive refresh refusal (`needs_reauth`) or a transient scheduled-refresh failure (stays `active`). Cleared on a successful refresh or reconnect |
| `refresh_lease_owner` / `refresh_lease_until` | the per-account refresh lease, shared by the scheduled section and publish-time refresh (G2) |

Uniqueness stays as it is: `(project_id, provider_key, external_account_id)` where `removed_at IS NULL`. Connecting the same DID again upserts in place (US1-AS6).

## 2. Settings: `blueskySettingsSchema` (non-secret, plain jsonb)

```ts
z.object({ pdsUrl: z.string().default("https://bsky.social") })   // stored normalised
```

Normalisation and validation happen in `connectAccount`, before any network call. The function is `normalisePdsUrl` in `settings.ts`.

- The URL must parse with `new URL()` and have protocol `https:`.
- Username, password, query (`search`) and fragment (`hash`) must all be empty.
- The path must be `/` or empty. A trailing slash is ignored.
- It is stored as `url.origin`, e.g. `https://pds.example.com:8443`.
- Any violation → field error on `pdsUrl`: "Enter an https:// address with no path, for example https://bsky.social."

`settingsSchema` itself only parses the stored shape, with a default. It does not re-validate rows on read: the engine parses settings on every claim, and a strict schema change could fail old rows.

## 3. Credentials: `blueskyCredentialsSchema` (secret, encrypted, server only)

```ts
z.object({
  accessJwt: z.string().min(1),
  refreshJwt: z.string().min(1),
  did: z.string().startsWith("did:"),
  handle: z.string().min(1),
})
```

- **Never stored**: the app password (FR-007), email, didDoc.
- **Never leaves the server**: `AccountView` has no credential fields, as today.
- `advance` and `refreshCredentials` parse `ctx.account.credentials` with this schema. A parse failure means `fatal_error` / definitive `ok:false` with "Stored credentials are unreadable; reconnect the account."
- `secretValues()` collects every string leaf (including `did` and `handle`) for redaction. Summaries therefore never include the handle or DID (D19).

**Expiry helpers** (pure, in `session.ts`):

- `jwtExp(token): Date | null` decodes the payload segment's `exp` claim (base64url JSON), **without verifying** it.
- `needsRefresh(creds, now)` = `jwtExp(accessJwt)` is not null and `exp − now < 5 min`.
- Unknown expiry → `false`. The reactive path (`credentialsExpired`) covers that case.

## 4. Publish step state: `blueskyStateSchema` (non-secret, `post_targets.step_state`)

```ts
z.object({
  v: z.literal(1),
  /** Set by resolve_mentions: handle (normalised) → DID, or null when it did not resolve. Absent = not resolved yet. */
  mentions: z.record(z.string(), z.string().nullable()).optional(),
  /** One per uploaded image, in post order. JSON blob ref as returned by BlobRef#ipld(). */
  blobs: z.array(z.object({
    $type: z.literal("blob"),
    ref: z.object({ $link: z.string() }),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
  })).default([]),
})
```

- It holds no tokens, URLs or alt text. Alt text, dimensions and text are read from `ctx.content` at `create_post`; content is not edited mid-publish (spec assumption).
- A manual retry clears `step_state` (existing behaviour), so images are uploaded again (spec edge case: blobs lost before the post is created).

### Step transitions (`stepFor(state, settings, content)`, pure and total)

Let `M` = the text contains at least one mention facet (`detectFacetsWithoutResolution`), and `N` = `content.mediaCount`.

| `state` | Condition | Step | `mayPublish` |
|---|---|---|---|
| fails `blueskyStateSchema` (non-null) | — | `invalid_state` | false |
| `null` or `mentions` absent | `M` | `resolve_mentions` | false |
| any valid | `blobs.length < N` | `upload_image_<blobs.length + 1>` | false |
| any valid | `blobs.length ≥ N` | `create_post` | **true** |

`advance` results by step:

```
resolve_mentions  ─continue{mentions}──▶ upload_image_1 … ─continue{blobs+1}──▶ upload_image_N ─continue──▶ create_post ──done
       │ retryable (429/5xx/timeout)                │ retryable / fatal / credentialsExpired             │ ambiguous / fatal / retryable(pre-send, 429, credentialsExpired)
```

- If `ctx.step.name` ≠ the step `stepFor` computes from the current `ctx.state` and `ctx.content`, the result is `retryable_error` "The post changed while publishing; will retry." No request is sent.
- With `M` false and `N = 0`, the first step is `create_post`. A text-only post publishes in one tick (SC-003).
- With `N` images, the post takes `N + 1` ticks, plus one if `M` (SC-003).

## 5. Published reference (`post_targets`)

| Column | Value |
|---|---|
| `external_id` | `createRecord.uri`, e.g. `at://did:plc:abc/app.bsky.feed.post/3k…` |
| `external_url` | `https://bsky.app/profile/<credentials.handle>/post/<rkey>` |

## 6. Framework type changes (`src/providers/types.ts`)

These are all generic and optional or additive. The mock and the test providers compile unchanged, except where noted.

```ts
interface CredentialField {
  name: string; label: string; secret: boolean; help?: string;
  optional?: boolean;        // G1: default false (required)
  defaultValue?: string;     // G1: used when the submitted value is empty
  placeholder?: string;      // G1
}

/** G1 */
type ConnectResult =
  | { ok: true; account: { externalId: string; displayName: string; settings: unknown; credentials: unknown; expiresAt: Date | null } }
  | { ok: false; message: string; field?: string; retryAt?: Date };

/** G4: what stepFor may look at. */
interface StepContent { text: string; mediaCount: number }

interface PublishContext {
  // … existing fields …
  step: StepInfo;            // G4: the step the engine leased
}

type StepResult = (
  | { kind: "continue"; state: unknown; notBefore?: Date }
  | { kind: "done"; externalId: string; url?: string }
  | { kind: "retryable_error"; error: string; notBefore?: Date; credentialsExpired?: boolean }   // G2
  | { kind: "fatal_error"; error: string }
  | { kind: "ambiguous"; error: string }
) & { summary?: AttemptSummary };

type RefreshResult =
  | { ok: true; credentials: unknown; expiresAt: Date | null; displayName?: string }        // FR-025
  | { ok: false; reason: string; transient?: boolean; retryAt?: Date };                     // G3

interface SocialProvider<Settings, State> {
  // … existing …
  connectAccount?(input: { fields: Readonly<Record<string, string>>; now: Date; signal: AbortSignal }): Promise<ConnectResult>;  // G1
  needsRefresh?(credentials: unknown, now: Date): boolean;                                                                        // G2
  stepFor(state: State | null, settings: Settings, content: StepContent): StepInfo;                                               // G4
}
```

**Validation rules (registry test, `registry.test.ts`)**:

- A provider with `connectAccount` must use the `credentials` or `manual-token` strategy, with at least one field.
- Field names must be unique and match `[a-zA-Z][a-zA-Z0-9]*`.
- A field with `defaultValue` must be `optional`.
- A `secret` field must not have a `defaultValue`.
- `needsRefresh` requires `refreshCredentials`.

## 7. DAL additions (generic, scheduler-internal)

`AccountsRepo` (in `src/server/dal/accounts.ts`):

- `RefreshPatch` gains `displayName?: string`, applied by `recordRefresh` (FR-025).
- **New** `acquireRefreshLease(id, token, { now, leaseMs, expectedCiphertext })`. It returns one of:
  - `{ kind: "acquired" }`;
  - `{ kind: "changed" }`: the ciphertext differs, so someone refreshed;
  - `{ kind: "busy" }`;
  - `{ kind: "unavailable" }`: removed, not active, or no credentials.

  It runs one conditional `UPDATE … WHERE id AND project_id AND status='active' AND removed_at IS NULL AND (refresh_lease_until IS NULL OR refresh_lease_until <= now) AND credentials_encrypted = expected RETURNING id`. On zero rows, one `SELECT` classifies why. It takes no explicit lock and no session-level feature.

`ClaimContext` (in `src/server/dal/scheduler.ts`):

- **New** `contentShape(target): Promise<StepContent | null>`. In the claim transaction it reads the target's effective text (`override_text ?? base_text`) and `count(post_media)` for its post, pinned by `project_id`. `null` means the post row is gone.

## 8. State and lock interactions

- **Refresh lease** (account row): taken by `claimRefreshAccounts` (scheduled, `FOR UPDATE SKIP LOCKED` then set) or by `acquireRefreshLease` (publish, one conditional `UPDATE`). It is released by `recordRefresh(token, patch)`, or it expires after `leaseMs`.
  - A conditional `UPDATE` that meets a row locked by the claim transaction waits for that short transaction. Postgres then re-checks the predicate on the new row version, so the loser sees `busy`.
- **Target lease** (target row): unchanged. The publish-time refresh happens while the target lease is held, but outside any transaction. No path holds a target row lock while it updates an account.
- **Ordering guarantee (FR-022)**: new credentials go to `advance` only after `recordRefresh` returned true under the caller's token. The rotated refresh token is therefore persisted before the new access token is used.
