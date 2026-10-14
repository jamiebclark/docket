# Phase 1: Data model — Pinterest provider

**Branch**: `072-pinterest-provider` | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

Nothing here is a new table or column. Every record below already has a home: the account row, its
encrypted credentials blob, `post_targets.posting_fields` (added by 026), the in-process account-details
cache, and the step state the engine keeps — which Pinterest does not use at all.

## 1. Storage map

| Record | Where it lives | Encrypted | Written by | Read by |
|---|---|---|---|---|
| Pinterest account | `social_accounts` row: `provider_key = 'pinterest'`, `external_account_id`, `display_name`, `settings = {}`, `expires_at` | no | connect (`saveConnectedAccount`) | everything |
| Credentials (§3) | `social_accounts` credentials ciphertext | **yes** (AES-256-GCM) | connect, `refreshCredentials` | engine, `readAccountDetails` |
| Target posting values (§4) | `post_targets.posting_fields` (jsonb, nullable) | no | `createDraft` / `updatePost` | `validate`, `advance`, `targetNoteFor` |
| Board list (§5) | in-process cache in `account-details.ts`, 60 s | no | `readAccountDetails` | composer check only |
| Publish state | `post_targets.step_state` — **always null for Pinterest** | — | — | — |
| Published pin | `post_targets.external_id` = the pin id; `url` = the constructed permalink | no | engine on `done` | post views |

**No migration.** `pnpm db:check` must still pass unchanged.

## 2. Account

- `provider_key`: `pinterest`.
- `external_account_id`: Pinterest's `GET /v5/user_account` → `id`. Immutable; it is how a reconnect finds
  the same account.
- `display_name`: `business_name` when Pinterest sent one, else `username`, else the id (K25). A later
  refresh may update it (`RefreshResult.displayName`) — not used in this entry.
- `settings`: `{}`. `pinterestSettingsSchema = z.object({}).strip()`, so a stale value from a future
  version is stripped rather than failing the engine's `settingsSchema.parse` (K2, FR-003).
- `expires_at`: the **refresh token's** expiry (§3), never the 30-day access token's. This is what makes
  the scheduled refresh pass renew an idle account inside `TOKEN_REFRESH_WINDOW_HOURS` (72 h by default)
  of the 60-day refresh expiry, so the account never lapses (K26, FR-028).
- `status`: `active`, or `needs_reauth` after a refused refresh (FR-029).

### Account notes (G13)

`pinterestAccountNotes({ settings, credentialsExpireAt, now, timeZone })` returns, in order:

1. The Trial note, always, worded so it is true on either access tier (K32, FR-031, FR-032):
   *"While this server's Pinterest app has Trial access, pins it publishes are visible only to this
   account's owner, and the whole server shares 300 pin creations a day across every connected Pinterest
   account. See <setup guide>."*
2. `Reconnect Pinterest before <date>` when `credentialsExpireAt` is within 30 days of `now`, with the
   date rendered by `formatLocal(credentialsExpireAt, timeZone)` — never an ISO string (G13's rule).

Plain text, no secrets, no credentials in the input.

## 3. Credentials (encrypted)

```
pinterestCredentialsSchema = z.object({
  v: z.literal(1),
  accessToken: z.string().min(1).max(4000),            // "pina…"
  refreshToken: z.string().min(1).max(4000),            // "pinr…"
  accessExpiresAt: epochMs,                             // now + expires_in (30 days)
  refreshIssuedAt: epochMs,                             // when the stored refresh token was handed over
  refreshExpiresAt: epochMs,                            // 60 days for a continuous token
  refreshExpiryEstimated: z.boolean(),                  // true when the reply gave no refresh expiry
})
```

Timestamps are numbers, so the redactor only ever has two strings to hide.

| Helper | Rule |
|---|---|
| `readPinterestCredentials(value)` | `safeParse`, `null` on failure. Unreadable credentials are a `fatal_error` with `credentialsInvalid: true`, not a retry. |
| `accountExpiry(c)` | `new Date(c.refreshExpiresAt)` (K26). |
| `needsRefresh(c, now)` | `c.accessExpiresAt - now < 24 h` (`PINTEREST_REFRESH_MARGIN_MS`, K27). |

### Expiry arithmetic

| Reply field | Used as |
|---|---|
| `expires_in` (seconds, default 2 592 000) | `accessExpiresAt = now + expires_in × 1000` |
| `refresh_token_expires_in` (seconds) | `refreshExpiresAt = now + value × 1000`, `refreshExpiryEstimated = false` |
| `refresh_token_expires_at` (epoch **seconds**; refresh replies only) | used when `_in` is absent: `refreshExpiresAt = value × 1000` |
| neither | `refreshExpiresAt = now + 60 days`, `refreshExpiryEstimated = true` |

### Refresh transitions (FR-028, FR-029)

| Pinterest's answer | Stored | Account |
|---|---|---|
| 2xx with `access_token` **and** `refresh_token` | both tokens replaced; `refreshIssuedAt = now`; refresh expiry re-dated from the reply | `active` |
| 2xx with `access_token` and **no** `refresh_token` (U8, legacy) | access token and its expiry only; the stored refresh token and its expiry are left exactly as they were | `active` |
| 2xx Docket cannot read | nothing | `active`; transient with `retryAt = now + 5 min` |
| 4xx with a definitive `error` (`invalid_grant`, `invalid_request`, `invalid_scope`) | nothing | `needs_reauth`, "Re-approve Docket on Pinterest to publish again." |
| 4xx naming the client (`invalid_client`, `unauthorized_client`) | nothing | `needs_reauth`, naming `PINTEREST_CLIENT_ID` / `PINTEREST_CLIENT_SECRET` and the setup guide |
| 429, 5xx, network, unparseable | nothing | `active`; transient with `retryAt = now + 5 min` (G11) |

Every success writes the whole blob in one go, so a rotated refresh token can never be lost between a
write of the access token and a write of the refresh token (FR-028).

## 4. Target posting values (G25)

Stored in `post_targets.posting_fields`, parsed by `pinterestPostingSchema`, reaching `validate` and
`advance` as `PostContent.posting.values`.

```
pinterestPostingSchema = z.object({
  v: z.literal(1).default(1),
  boardId: z.string().min(1).max(100).nullable().default(null),   // null = not chosen
  boardName: z.string().max(400).default(""),                     // display label only; never sent
  title: z.string().max(400).default(""),                         // refused above 100 code points
  link: z.string().max(4096).default(""),                         // refused above 2048 code points
})
```

- Every member defaults, so the composer may submit only what a person touched (TikTok's rule).
- The schema's maxima are **deliberately looser than Pinterest's**: a value the schema rejects becomes
  "not set", which would silently discard the person's typing. `validate` names the real limit and the
  measured count (K7).
- `boardName` is written by the panel through `labelKey` (G29, §6) and is **display only**: the request
  carries `boardId`. A tampered label can only mislabel the tamperer's own post; it is length-capped and
  rendered as text.

### Field views returned by `view({ values, details, postType })`

| Order | key | kind | Notes |
|---|---|---|---|
| 1 | `boardId` | `choice`, `required: true`, `labelKey: "boardName"`, placeholder "Choose a board…" | Options and disabled state per §5 (K16) |
| 2 | `title` | `text`, `optional: true`, `maxLength: 100`, `countingRule: "code_points"` | Pin title (FR-010) |
| 3 | `link` | `text`, `optional: true`, `maxLength: 2048`, `countingRule: "code_points"` | Where the pin clicks through to (FR-010) |

`heading(details)` → null (the account's name is already on the target card).
`notice()` → the Trial line with `doc` + `docLabel` (K32, K37).
`targetNote(values)` → `Board: <name>` / `Board chosen` / null (K21, FR-018).
`summaryNotes()` → the Trial line, "A pin needs one image and a board", and "About 100 pins a minute per
account" (FR-031, FR-030).
`afterPreview` → "The pin's title and link are Pinterest-only; other accounts ignore them."

## 5. Board list (G26 account details)

```
pinterestDetailsSchema = z.object({
  v: z.literal(1),
  boards: z.array(z.object({ id: z.string().min(1).max(100), name: z.string().max(400) })).max(2500),
  truncated: z.boolean(),                // the 10-page cap bit
})
```

Read by `GET /v5/boards?privacy=PUBLIC&page_size=250[&bookmark=…]`, following `bookmark` for at most
`PINTEREST_BOARD_PAGE_MAX = 10` pages (K20, FR-017). Order is Pinterest's. Nothing else from the board
object is kept — no privacy, no counts, no cover image. Never stored; cached 60 s in process (F9).

### The five picker states (FR-019, FR-020, SC-008)

| State | `details` | `view()` emits | `validate` emits |
|---|---|---|---|
| Loading | `null` | disabled control, reason "Pinterest's boards are still loading."; the stored board is the only option so the choice stays visible | `board_required` only when nothing is stored |
| Read failed | `null` | identical to loading; the panel shows `detailsError` and **Retry** above the fields (F9) | as above — the stored choice is never cleared |
| No boards | `{ boards: [], … }` | disabled control, no options, reason "This Pinterest account has no public boards. Create one on Pinterest, then choose it here." | `no_boards` (FR-020) |
| Boards, choice valid | `{ boards: [...] }` | one option per board | nothing |
| Boards, stored board missing | `{ boards: [...] }` | every board, plus the stored id appended as a **disabled** option "<name> — no longer on Pinterest" | `board_not_found` (K18) |

Beyond 250 boards the picker shows every board it paged (SC-008's 300-board case); beyond 2 500 it shows
the first 2 500 and `truncated` is true.

## 6. G29 — `labelKey` on a choice field view

```
| { kind: "choice"; value: string | null; options: PostingOptionView[]; required: boolean;
    placeholder: string;
    /** When set, choosing an option also stores that option's label under this key. */
    labelKey?: string }
```

Panel behaviour (`PostingFieldsPanel`): on change, `onChange(field.key, id)`, and when `labelKey` is set
`onChange(field.labelKey, label)` — the chosen option's label, or `""` when the placeholder is chosen.
Two functional updates compose, so one render applies both (F14).

Inert for every existing provider: TikTok declares no `labelKey`, so the panel makes exactly one call, as
it does today. *Reverse:* delete the member and the panel's second call; stored labels become unread
values that the provider's schema strips.

## 7. The create request

`POST https://api.pinterest.com/v5/pins`, `Authorization: Bearer <accessToken>`, JSON body:

| Key | Value | Omitted when |
|---|---|---|
| `board_id` | `values.boardId` | never (a missing board never reaches `advance`) |
| `media_source` | `{ source_type: "image_url", url: media[0].url }` | never |
| `description` | the target's effective text | the text is blank |
| `alt_text` | `media[0].altText` | the alt text is blank |
| `title` | `values.title` | empty |
| `link` | `values.link` | empty |

Nothing else is sent: no `note`, no `dominant_color`, no `board_section_id`, no `ai_disclosures`,
no `is_removable`, no `ad_account_id`.

## 8. Attempt summary (non-secret, allow-listed)

`AttemptSummary.request` — `{ step: "create_pin", boardId, bytes, mimeType, descriptionCodePoints, hasTitle, hasLink, hasAltText }`.
`AttemptSummary.response` — `{ status, pinId?, rateLimitRemaining?, retryAfterSeconds?, message? }`, where
`message` is already scrubbed and truncated. No token, no URL, no raw body (FR-024, constitution VII).

## 9. Published pin

- `external_id` = Pinterest's `id` from the create reply (FR-023).
- `url` = `https://www.pinterest.com/pin/<id>/`, built by `pinUrl(id)` — **best-effort and undocumented**
  (U5, FR-027). The reply's `link` field is the pin's outbound click-through address and is never used
  here, nor stored.

## 10. Declared limits (the `docs/limits.md` rows this creates)

| Category | Value | Counting | Source |
|---|---|---|---|
| text length | 800 | code points | `docs/research/pinterest.md` (`description` maxLength 800); the counting rule is a Docket choice (U4) |
| images | 1 | | `docs/research/pinterest.md` (one `image_url` per pin; carousels out of scope) |
| bytes per file | 20000000 | | `docs/research/pinterest.md` (Help Center "20 MB on web", UNVERIFIED as an API ceiling) |
| formats | image/jpeg, image/png, image/webp | | `docs/research/pinterest.md` (Pinterest also accepts BMP and TIFF, which Docket's library cannot hold) |
| alt text length | 500 | | `docs/research/pinterest.md` (`alt_text` maxLength 500) |
| media required | yes | | `docs/research/pinterest.md` (Pinterest has no text-only pin) |
| text only | no | | as above |
| videos | 0 | | out of scope; a later `pinterest-video` entry |
| publish limit | 100 / 60 s | | `docs/research/pinterest.md` (`org_write`, Standard access) |
| note: pin title | 100 code points, per target, optional | | `docs/research/pinterest.md` (`title` maxLength 100) |
| note: pin link | 2048 code points, per target, optional, absolute http(s) | | `docs/research/pinterest.md` (`link` maxLength 2048); the URL check is a Docket choice |
| note: board required | Every pin names exactly one board, chosen per target | | `docs/research/pinterest.md` ("Identity model") |
| note: aspect ratio | A warning outside 0.5–1.0 (2:3 recommended); never refused | | `docs/research/pinterest.md` (feed cropping, not rejection; UNVERIFIED) |

Each row also carries the section's **Enforced in** and **Test** columns, filled the way the `## X`
section fills them: `validateResolvedContent` for every capability refusal, `media planner` for `formats`
and `bytes per file`, `engine deferral` for the publish limit, and the generated test name
`tests/integration/limits/enforcement.test.ts` "pinterest: <category>".

Below the table, in prose — the pattern `## X` already uses for X's app-wide 10,000-per-day cap:

> While the deployer's Pinterest app has Trial access, the whole server shares 300 pin creations per day
> across every connected Pinterest account. Docket does not enforce that cap (it is per app, not per
> account), so it has no row; a 429 from it defers the post instead. It is stated on the account card, in
> the requirements summary and in `docs/pinterest-setup.md`.

Exact category spelling and the citation format follow `tests/helpers/limit-rows.ts` and the header of
`docs/limits.md`; `tests/integration/docs/limits-inventory.test.ts` is the arbiter. Two of its rules bite
here: a non-`note:` row for anything the provider does **not** declare fails, and **every** row —
`note:` rows included — must name a source, an enforcement point, and a test file that exists plus a
quoted test title that really appears in it. So each `note:` row above cites a Pinterest unit or
integration test by its literal name, not the generated enforcement suite.
