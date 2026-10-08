# Data model: TikTok provider

**Feature**: `026-tiktok-provider` | **Date**: 2026-10-08

Decisions are numbered as in [research.md](./research.md) (P-numbers) and [spec.md](./spec.md) (D-numbers).

## 1. Schema change (migration `0018`, P10)

`post_targets` gains five nullable columns. Nothing else changes, and there is no new table and no backfill.

| Column | Type | Meaning |
|---|---|---|
| `posting_fields` | `jsonb` | The target's posting values (G25), parsed by the provider's `posting.valuesSchema`. `NULL` means never set (API, generator or bulk create, or a provider without fields). |
| `consent_by_user_id` | `uuid` → `user.id`, `ON DELETE SET NULL` | Who ticked "I agree" (G27). |
| `consent_at` | `timestamptz` | When, by the DB clock. |
| `consent_fingerprint` | `text` | `v1:` + 64 lowercase hex characters (SHA-256, §5). |
| `consent_details` | `jsonb` | The account details shown when consenting (non-secret, §4). |

Constraint `post_targets_consent_pair`: `(consent_at IS NULL) = (consent_fingerprint IS NULL)`, and `consent_details IS NULL OR consent_fingerprint IS NOT NULL`.

These columns sit on the project-owned `post_targets` row and are read and written only through the existing scoped `targets` repository (constitution III). `TargetPatch` and `TargetRecord` pick them up from the Drizzle table type. `posting_fields` is never exposed by the public API (FR-041).

## 2. TikTok credentials and settings

**Credentials** (secret, encrypted at rest; `src/providers/tiktok/credentials.ts`):

```ts
tiktokCredentialsSchema = z.object({
  v: z.literal(1),
  accessToken: z.string().min(1).max(4000),
  refreshToken: z.string().min(1).max(4000),
  accessExpiresAt: epochMs,          // issue time + expires_in (default 86_400 s)
  refreshIssuedAt: epochMs,          // when the stored refresh token was issued
  refreshExpiresAt: epochMs,         // refresh_expires_in, or issue + 365 days
  refreshExpiryEstimated: z.boolean(),
  openId: z.string().min(1).max(200),
})
```

- `accountExpiry(c) = new Date(c.refreshExpiresAt)` (P15). This is the account's `credentials_expires_at`.
- `needsRefresh(c, now) = c.accessExpiresAt − now < 30 min`.
- The timestamps are numbers, so the engine's `secretValues` redacts only the two tokens (and `openId`, which is not secret but harmless to redact).

**Settings** (non-secret, lenient): `z.object({ username: z.string().max(100).optional(), nickname: z.string().max(200).optional() }).strip()`.

**Account notes** (G13 with `now`, P8):

1. When unaudited: "Private posts only: this TikTok app hasn't passed TikTok's audit. See <docsUrl('tiktok-setup','unaudited-apps')>"
2. Always: "Photo posts need your media domain verified in your TikTok app."
3. When `credentialsExpireAt − now ≤ 30 days`: "Reconnect TikTok before <YYYY-MM-DD>" (UTC date), plus " (estimated)" when the expiry was estimated.

## 3. TikTok posting values (G25)

Stored in `post_targets.posting_fields` (`src/providers/tiktok/posting.ts`):

```ts
tiktokPostingSchema = z.object({
  v: z.literal(1),
  privacy: z.string().regex(/^[A-Z_]{1,40}$/).nullable(), // null = not chosen
  allowComments: z.boolean(),
  allowDuets: z.boolean(),      // ignored for photo posts
  allowStitches: z.boolean(),   // ignored for photo posts
  disclosure: z.boolean(),
  yourBrand: z.boolean(),
  brandedContent: z.boolean(),
  photoTitle: z.string().max(400),  // validated to ≤ 90 UTF-16 units; "" = none
})
```

| Field key | Kind | Label | Post types | Default | Rule |
|---|---|---|---|---|---|
| `privacy` | choice (audited) / fixed (unaudited) | "Who can see this" | all | none (audited); `SELF_ONLY` (unaudited) | Options = creator's `privacy_level_options`, in plain words (P21). "Only me" is disabled while `brandedContent`, with "Branded content can't be private." |
| `allowComments` | toggle | "Allow comments" | image, carousel, video | off | Disabled with "Turned off in this TikTok account's settings." when `comment_disabled` |
| `allowDuets` | toggle | "Allow duets" | video | off | as above, `duet_disabled` |
| `allowStitches` | toggle | "Allow stitches" | video | off | as above, `stitch_disabled` |
| `disclosure` | toggle | "Disclose commercial content" | all | off | — |
| `yourBrand` | toggle | "Your brand" | all, only when `disclosure` | off | — |
| `brandedContent` | toggle | "Branded content" | all, only when `disclosure` | off | Disabled while unaudited, with "Branded content can't be private, and this app can only post privately." |
| `photoTitle` | text | "Photo title" | image, carousel | "" | At most 90 UTF-16 units, optional |

`targetNote(values)` returns "Private on TikTok" when `values?.privacy === "SELF_ONLY"`, or when `values` is null on an unaudited install. Otherwise it returns null.

`summaryNotes()` returns:

- when unaudited: "Posts are private: this TikTok app hasn't passed TikTok's audit. The TikTok account must also be set to private, and at most 5 accounts can post through this app in 24 hours.";
- "Photo posts need your media domain verified in your TikTok app.";
- "Videos also must fit the TikTok account's own maximum length, checked when you agree and again when the post goes out.";
- "About 15 posts per account per day, shared with other apps that post to TikTok."

`consent.declaration(values)` returns "By posting, you agree to TikTok's Music Usage Confirmation." or, when `brandedContent` is on, "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation." (P22).

## 4. Creator details (G26)

These are live, non-secret and never stored except as `consent_details` (and the nickname in an attempt summary). `src/providers/tiktok/creator.ts`:

```ts
creatorDetailsSchema = z.object({
  v: z.literal(1),
  nickname: z.string().max(200),
  username: z.string().max(100),
  privacyOptions: z.array(z.string().regex(/^[A-Z_]{1,40}$/)).max(10),
  commentDisabled: z.boolean(),
  duetDisabled: z.boolean(),
  stitchDisabled: z.boolean(),
  maxVideoSeconds: z.number().int().min(1).max(36_000).nullable(), // null = not returned
})
```

The avatar URL (2-hour TTL) is dropped and never reaches the browser. A creator-info reply that fails this schema is `unreadable` (P12).

**Cache** (`src/server/services/account-details.ts`, P2): `Map<accountId, { details, at }>`, in process. An entry is reused while `now − at < 60 s`. Failures are not cached.

## 5. Consent record and fingerprint (G27)

```ts
consentFingerprint({ text, mediaIds, videoEdits, values, details }) =
  "v1:" + sha256hex(canonicalJson({
    v: 1,
    text,                            // the target's effective text
    mediaIds,                        // post order
    videoEdits: sortedByMediaId,     // normalised edit objects; absent edit = DEFAULT_VIDEO_EDIT
    values,                          // parsed posting values
    details,                         // parsed account details shown
  }))
```

`canonicalJson` sorts object keys recursively and writes no whitespace.

`consentStatus(target, content, details)` returns one of:

- `{ kind: "valid" }`: the stored fingerprint equals the recomputed one;
- `{ kind: "missing" }`: no consent stored;
- `{ kind: "stale" }`: a consent is stored but its fingerprint differs.

Only `valid` passes the gate and the engine (P5).

**Lifecycle:**

| Event | Result |
|---|---|
| Save with `consent.fingerprint` equal to the server's recomputed fingerprint (member actor) | Columns written: user, DB time, fingerprint, details |
| Save where the stored fingerprint no longer matches and no matching consent was sent | The four columns are cleared |
| Save from an API key, generator or bulk create | Consent never written; `posting_fields` stays as sent (always null from those callers, F7) |
| New post (no duplicate feature exists, F6) | No consent |
| Account details change after consent | The stored consent stays valid at the gate (its details are stored). The live re-check at publish fails per D10. |

## 6. Publish state (`src/providers/tiktok/state.ts`)

Plain jsonb in `post_targets.step_state`, `v: 1`. It never holds a token, and the upload address is sealed (P25).

```ts
tiktokStateSchema = z.object({
  v: z.literal(1),
  kind: z.enum(["video", "photo"]),
  phase: z.enum(["creator", "start", "chunks", "status"]),
  restarts: z.number().int().min(0).max(2),
  capWaitSince: iso.optional(),          // first posting-cap refusal (P29)
  nickname: z.string().max(200).optional(),
  // the file being uploaded (video)
  fileUrl: z.string().url().optional(),
  fileBytes: z.number().int().min(1).max(4_000_000_000).optional(),
  chunkSize: z.number().int().min(1).optional(),
  chunkCount: z.number().int().min(1).max(1000).optional(),
  chunksSent: z.number().int().min(0).optional(),
  publishId: z.string().min(1).max(64).optional(),
  sealedUploadUrl: z.string().max(2000).optional(),   // P25
  uploadIssuedAt: iso.optional(),
  // after the publishing request
  sentAt: iso.optional(),                // final chunk or photo init sent
  reads: z.number().int().min(0).max(200).optional(),
  lastReadAt: iso.optional(),
  lastStatus: z.string().max(40).optional(),
})
```

**Phase invariants** (a state that breaks them is unreadable; P23):

| Phase | Requires |
|---|---|
| `creator` | (nothing) |
| `start` | `nickname` |
| `chunks` (video only) | `fileUrl`, `fileBytes`, `chunkSize`, `chunkCount`, `publishId`, `sealedUploadUrl`, `uploadIssuedAt`, `0 ≤ chunksSent < chunkCount`, and the chunk plan equal to `chunkPlan(fileBytes)` |
| `status` | `publishId`, `sentAt` |

**Step derivation** (`tiktokStepFor(state, settings, content)`):

| State | Step | `mayPublish` | `afterPublish` |
|---|---|---|---|
| `null`, or phase `creator` | `check_creator` | false | — |
| `start`, video | `start_upload` | false | — |
| `start`, photo | `publish_photos` | **true** | — |
| `chunks`, `chunksSent = k < N − 1` | `upload_chunk_<k+1>` | false | — |
| `chunks`, `chunksSent = N − 1` | `upload_chunk_<N>` | **true** | — |
| `status` | `check_status` | false | **true** |
| Unparseable, with `publishId` and `sentAt` strings | `check_status` (advance → ambiguous) | false | **true** |
| Unparseable otherwise | `check_creator` (restart) | false | — |

**Transitions:**

```text
creator ──ok──▶ start ──(video) init ok──▶ chunks ──k<N──▶ chunks … ──final 201 / uncertain──▶ status ──PUBLISH_COMPLETE──▶ done
   │              │                           │                                                     │──FAILED──▶ fatal
   │              └─(photo) init ok / uncertain-after-send ─▶ status (ok) / ambiguous (uncertain)  │──INBOX/unknown──▶ ambiguous
   │                                          └──403 / expired / repeat refused / unsealable ─▶ creator (restarts+1 ≤ 2)  └──60 min──▶ ambiguous
   └──cap──▶ creator (wait 1 h, G24) … ──23 h──▶ fatal
```

**Constants:**

| Name | Value | Source |
|---|---|---|
| `REFRESH_MARGIN_MS` | 30 min | D15 |
| `REFRESH_RETRY_MS` | 5 min | D15 |
| `DEFAULT_ACCESS_SECONDS` | 86,400 | research |
| `REFRESH_LIFETIME_MS` | 365 days | research |
| `RECONNECT_WARNING_MS` | 30 days | D15 |
| `DETAILS_CACHE_MS` | 60 s | D4 |
| `TARGET_CHUNKS` | 30 | D9 |
| `MIN_CHUNK_BYTES` | 5,242,880 | D9 |
| `MAX_CHUNK_BYTES` | 64,000,000 | D9 |
| `MAX_FINAL_CHUNK_BYTES` | 128,000,000 (exclusive) | research |
| `MAX_CHUNKS` | 1,000 | research |
| `UPLOAD_SAFE_AGE_MS` | 55 min | P28 (address valid 1 h) |
| `MAX_RESTARTS` | 2 | D9 |
| `CAP_RETRY_MS` | 1 h | D10 |
| `CAP_GIVE_UP_MS` | 23 h | P29 |
| `RATE_RETRY_MS` | 60 s (or `Retry-After`) | D12 |
| `FIRST_READ_DELAY_MS` | 15 s | D11 |
| `FAST_READ_INTERVAL_MS` | 60 s | D11 |
| `FAST_PHASE_MS` | 10 min | D11 |
| `SLOW_READ_INTERVAL_MS` | 5 min | D11 |
| `STATUS_CEILING_MS` | 60 min | D11 |
| `MESSAGE_MAX` | 200 characters | P36 |

**Pace** (`nextReadAt(state)`): no read before `sentAt + 15 s`. After that, `lastReadAt + 60 s` while under `sentAt + 10 min`, then `lastReadAt + 5 min`. Every value is capped at `sentAt + 60 min`, so one read lands on the ceiling.

## 7. Chunk plan (P24)

| File bytes | `chunk_size` | `total_chunk_count` | Final chunk |
|---|---|---|---|
| 4,000,000 | 4,000,000 | 1 | 4,000,000 |
| 8,000,000 | 8,000,000 | 1 | 8,000,000 |
| 20,000,000 | 5,242,880 | 3 | 9,514,240 |
| 157,286,400 | 5,242,880 | 30 | 5,242,880 |
| 1,073,741,824 | 35,791,394 | 30 | 35,791,398 |
| 1,920,000,000 | 64,000,000 | 30 | 64,000,000 |
| 4,000,000,000 | 64,000,000 | 62 | 96,000,000 |

## 8. Generic type additions (summary; full shapes in contracts/generic-hooks.md)

- `PostContent.posting?: { values: unknown | null; details: unknown | null }`.
- `ValidationIssue.field` gains `"posting"`, `` `posting.${string}` `` and `"consent"`. `FIELD_RANK` orders them after `postType` and before `media`.
- `SocialProvider.posting?: PostingDeclaration` (G25), `accountDetails?: AccountDetailsReader` (G26), `consent?: ConsentDeclaration` (G27).
- `OAuthConnectGroup.exchangeCode` input gains `callbackParams: URLSearchParams` (G28).
- `accountNotes` input gains `now?: Date` (G13).
- `RequirementsSummary.notes?: string[]`.
- `postTargetInputSchema` gains `posting?: unknown` (validated by the provider's schema in the service) and `consent?: { fingerprint: string }`.
- `TargetCheck.posting?: PostingPanelView | null` and `TargetCheck.note?: string | null`. `PostViewTarget`, `PostListItem.targets[]` and the target member of `CalendarItem` each gain `note?: string | null`. These are optional so existing literal fixtures stay valid; the services always set them.
- `checkSchema` gains `refreshDetails?: boolean` (Retry).

## 9. `docs/limits.md` rows (`## TikTok`, FR-030)

The categories come from the doc's fixed vocabulary; the inventory test checks each against the declaration.

| Category | Value | Enforced in |
|---|---|---|
| text length | 2200 (UTF-16 units) | validateResolvedContent |
| images | 35 | validateResolvedContent |
| bytes per file | 20000000 | media planner |
| formats | image/jpeg, image/webp | media planner |
| max width | 1080 | media planner |
| max height | 1920 | media planner |
| media required | yes | validateResolvedContent |
| text only | no | validateResolvedContent |
| publish limit | 15 / 86400 s (approximate, shared with other apps) | deferralTime |
| videos | 1 | validateResolvedContent |
| video with images | no | validateResolvedContent |
| video containers | mp4, mov | video planner |
| video codecs | h264, hevc, vp8, vp9 | video planner |
| video bytes | 4000000000 | video planner |
| max duration | 300 | video planner |
| video min width / video max width | 360 / 4096 | validateResolvedContent / video planner |
| video min height / video max height | 360 / 4096 | validateResolvedContent / video planner |
| min frame rate / max frame rate | 23 / 60 | video planner |
| note: creator's maximum duration | `max_video_post_duration_sec`, checked at the gate (value shown at consent) and at publish (live) | validateTikTok / TikTok step machine |
| note: unaudited app | private only, private account, 5 accounts per 24 h | TikTok step machine / TikTok |
| note: photo domain verification | `PULL_FROM_URL` needs the media domain verified | TikTok (`url_ownership_unverified`) |
| note: chunk sizing | size ÷ 30, 5,242,880 to 64,000,000 bytes, final < 128,000,000 | TikTok step machine |
| note: status ceiling | 60 minutes after the publishing request | TikTok step machine |

The exact source, enforcement point and test names are filled in during implementation, against `limits-inventory.test.ts` and `enforcement.test.ts` (F21).
