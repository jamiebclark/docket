# Pinterest API — verified facts

Checked 2026-10-14. Sources: developers.pinterest.com pages, read two ways — plain fetch (works for the
"guide"-style pages under `/docs/getting-started/...` and `/docs/work-with-organic-content-and-users/...`,
which are server-rendered) and a reader-proxy fetch of the same official URLs (needed for the `/docs/api/v5/...`
reference pages, which are a client-side-rendered Redoc/Swagger UI that returns only nav chrome to a plain
fetch). Every URL cited below is still a developers.pinterest.com page; the proxy only renders the JS, it is not
an independent source. The official OpenAPI file
(`https://raw.githubusercontent.com/pinterest/api-description/main/v5/openapi.yaml`, Apache-licensed, published
by Pinterest) exists but is too large for the fetch tool to search reliably — it kept returning only the
ad-account section — so schema facts below come from the reference pages, not the raw spec. Nothing was run
live (no app, no token). Pinterest's consumer Help Center (`help.pinterest.com`) is Pinterest's own site but is
not developer documentation; facts sourced there are marked and should be re-checked against the API reference
before being encoded as a hard validation rule, since the Help Center describes what the Pinterest app/web UI
accepts, not necessarily what the API enforces.

Host for API calls: `https://api.pinterest.com/v5`. Authorize host: `https://www.pinterest.com`. A second,
literal sandbox host exists (`https://api-sandbox.pinterest.com/v5`) — see "Two different things called
sandbox" below; do not conflate it with Trial access.

## Blockers for a self-hosted deployment (read first)
0. **Every account a deployer connects must itself be a business account, for any app registered on or after
   2026-09-14.** Added to this file 2026-10-14 after reading the page live during a real registration; the
   original pass missed it because it is a callout box on the access-tiers page, not part of its table.
   "If you registered your app on or after September 14, 2026, you may receive HTTP 403
   `PINNER_DATA_ACCESS_DENIED` error when you request a board or Pin without Pinterest's authorization."
   The body is `{"code": 403, "message": "PINNER_DATA_ACCESS_DENIED", "detail": "Your application does not
   have access to read pinner data. Your application must be approved for pinner data access."}`, and the
   changelog entry says plainly: "Approval is required for **non-business users** before the request can
   succeed. To request access after registration, contact your Pinterest account manager if you have one."
   The endpoints it names are `GET /v5/boards/{board_id}`, `GET /v5/boards/{board_id}/pins`,
   `GET /v5/boards/{board_id}/sections`, `GET /v5/boards/{board_id}/sections/{section_id}/pins` and
   `GET /v5/pins/{pin_id}`. **`GET /v5/boards` — the list call Docket's board picker actually makes — is not
   on that list**, so Docket's own reads may be unaffected even for a personal account; that is an inference
   from the omission, not a statement Pinterest makes, so treat connecting a personal account as UNVERIFIED
   and tell deployers to connect business accounts. Nothing here restricts *which* accounts may authorise an
   app: app ownership and account connection are separate, as in any OAuth flow.
   https://developers.pinterest.com/docs/key-concepts/access-tiers/ ,
   https://developers.pinterest.com/docs/changelog/changelog/#pinner-data-access-denial-error
1. **A Pinterest business account is required before any app can be registered.** "Access to the Pinterest API
   requires you to have business account." A deployer who only has a personal Pinterest account cannot start.
   https://developers.pinterest.com/docs/developer-tools/quickstart-tools/
2. **Every deployer registers their own app and starts on Trial access**, which is reviewed ("Application
   requests are reviewed each business day") and can be denied (common reasons: "Privacy policy is inaccurate or
   not accessible", "App description is incomplete or unclear").
   https://developers.pinterest.com/docs/getting-started/connect-app/ ,
   https://developers.pinterest.com/docs/key-concepts/access-tiers/
3. **Trial access is functionally private, on the real production host.** "All Pins and Boards created with
   Trial access are only visible to their creator as Sandbox entities." Reads and writes work (boards, pins,
   analytics, catalogs can all be created), but nothing a Trial app posts is visible to anyone else until the
   app is upgraded. There is no documented cap on how long an app may stay on Trial.
   https://developers.pinterest.com/docs/key-concepts/access-tiers/
4. **Upgrading to Standard access needs a demo video**, submitted from the app's "My apps" page: "a video
   recording of your app completing an action using the Pinterest API", showing the OAuth flow is used properly
   and that no credentials are collected directly. Same posture as TikTok's audit, lighter-weight (one video,
   not a described review period) and reviewed on the same "each business day" cadence as Trial.
   https://developers.pinterest.com/docs/key-concepts/access-tiers/
5. **Rate limits are much tighter on Trial**: 300 requests/day/app for pin-and-board creation (`org_write`), and
   1000 requests/day/app universally, versus 100/minute/user/app and 100/second/user/app on Standard. The 300/day
   figure is per **app**, not per account, so it is shared across every connected Docket account on an unaudited
   deployer's app. https://developers.pinterest.com/docs/reference/rate-limits/
6. **Two different things are called "sandbox"; do not conflate them.** (a) Trial-access pins/boards created on
   the normal `api.pinterest.com` host, visible only to their creator (above). (b) A literal second host,
   `api-sandbox.pinterest.com`, with its own token type: "You cannot use the Sandbox token in your production
   environment, nor can you use a production token for Sandbox", used mainly for testing ads/catalogs without
   touching real data. Docket's provider only ever needs (a); it should never call the `-sandbox` host.
   https://developers.pinterest.com/docs/developer-tools/sandbox/
7. **No idempotency key exists on pin creation** (not in the reference page's request schema). A timeout or
   unparseable response after sending `POST /v5/pins` is genuinely ambiguous; see "Errors and idempotency" below.

## Access tiers and app registration
- Register by logging into (or creating) a business account, going to "My apps", accepting the Developer Terms
  of Service, then "Connect app" with a request form; submit "your request for trial access"; reviewed each
  business day, email notification of approval/denial.
  https://developers.pinterest.com/docs/getting-started/connect-app/
- Once approved, the app page ("My apps") shows the app ID (used as `client_id`) and app secret (`client_secret`).
  https://developers.pinterest.com/docs/developer-tools/quickstart-tools/
- Access tiers, side by side (https://developers.pinterest.com/docs/key-concepts/access-tiers/):
  | | Trial | Standard |
  |---|---|---|
  | Visibility | Pins/boards visible only to the creator ("Sandbox entities") | Publicly visible |
  | Rate limiting | Per day, per app | Per minute, per user, per app (much higher) |
  | What works | All read and write operations (pins, boards, ads, audiences, catalogs) | Same operations, no Trial-only restriction found |
  | Upgrade path | N/A | Submit from "My apps": app must already hold Trial access, comply with Developer
    Guidelines, and include a demo video of the OAuth flow in use |
- Redirect URIs: registered on the app; "We accept multiple redirect URIs when configuring your app"; the
  `redirect_uri` sent during OAuth "will be matched against the redirect URIs listed in your app profile. They
  must be an exact match"; "The specified redirect URI must not cause the responding server to send a secondary
  redirect" (no open-redirect chaining). No explicit `https`-only or no-localhost rule was found on an official
  page (example in the docs uses `https://example.com/`); **UNVERIFIED** whether `http://localhost` is accepted —
  treat as `redirectRequirement: { https: true, publicHost: true }` conservatively until tested, same posture
  Docket already uses for Threads/X. https://developers.pinterest.com/docs/getting-started/connect-app/

## OAuth
- Authorize: `GET https://www.pinterest.com/oauth/` with `client_id`, `redirect_uri` (exact match), `response_type=code`,
  `scope` (space- or comma-separated; "at least one is required"), optional `state`.
  https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/
- Token exchange: `POST https://api.pinterest.com/v5/oauth/token`, authenticated with **HTTP Basic**
  (`Authorization: Basic base64(client_id:client_secret)`, documented with the worked example
  `123:456` → `MTIzOjQ1Ng==`), body `grant_type=authorization_code`, `code`, `redirect_uri` (must match exactly),
  optional `continuous_refresh` ("only applicable to apps created before September 25, 2025" — see below).
  Token type: `bearer`.
- Response (authorization_code grant): `access_token` (prefixed `pina`), `refresh_token` (prefixed `pinr`),
  `token_type: "bearer"`, `expires_in: 2592000` (30 days), `refresh_token_expires_in` (see rotation note below),
  `scope`. https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/
- **Refresh-token lifetime depends on when the app was created**:
  - Apps created **on or after 2025-09-25** automatically get a **"continuous refresh token"**: 60-day
    expiration (`refresh_token_expires_in: 5184000`), **refreshable indefinitely** as long as it is refreshed
    again before the 60 days are up ("Repeat these steps before 60 days in order to keep the continuous refresh
    token valid"). Every refresh response includes a **new** `refresh_token` and a new `refresh_token_expires_at`
    (epoch seconds) — rotates every time, store the new one each time, same discipline as TikTok/X.
  - Apps created **before 2025-09-25** get a legacy refresh token (`refresh_token_expires_in: 31536000`, 365
    days) unless they pass `continuous_refresh` at the authorization-code step to opt into the new behaviour.
    Whether the legacy 365-day token rotates on refresh is **UNVERIFIED** (the page does not say; the continuous
    token clearly does).
  - A deployer self-hosting Docket registers a brand-new app, so in practice every Docket-created Pinterest app
    gets the continuous, rotating, indefinitely-renewable refresh token automatically.
- Refresh request: `POST https://api.pinterest.com/v5/oauth/token`, same Basic auth, `grant_type=refresh_token`,
  `refresh_token`, optional `scope` (to narrow the grant). Refresh response mirrors the above:
  `access_token`, `expires_in: 2592000`, `refresh_token`, `refresh_token_expires_in`, `refresh_token_expires_at`,
  `scope`, `token_type: "bearer"`.
  https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/
- **PKCE**: not mentioned anywhere on the authentication page (no `code_challenge`/`code_verifier` parameters
  documented). Treat as unsupported/not required; use the confidential-client Basic-auth flow only, same choice
  Docket already made for TikTok's web flow.
- Revocation/webhooks for deauthorisation: no page was found describing one; **UNVERIFIED**. A revoked token
  most likely surfaces as a `401` on the next call (see Errors).

## Scopes
| Scope | Meaning |
|---|---|
| `user_accounts:read` | "See user accounts and followers." |
| `user_accounts:write` | "Update user accounts and followers." |
| `boards:read` | "See public boards, including group boards." |
| `boards:read_secret` | See secret boards. |
| `boards:write` | "Create, update or delete public boards." |
| `boards:write_secret` | Create/update/delete secret boards. |
| `pins:read` | "See public pins." |
| `pins:read_secret` | See secret pins. |
| `pins:write` | "Create, update or delete public pins." |
| `pins:write_secret` | Create/update/delete secret pins. |
https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/
- To read the authenticated account: `user_accounts:read` (`GET /v5/user_account`).
- To list boards (needed to resolve `board_id` before every pin create): `boards:read`.
- To create a pin: `pins:write`. `boards:write` is **not** needed just to post into an existing board — it is
  only needed to create/update/delete boards themselves. The minimum set for "connect + list boards + publish"
  is therefore `user_accounts:read boards:read pins:write` (add `pins:read` to read analytics or list existing
  pins for duplicate-checking). https://developers.pinterest.com/docs/developer-tools/quickstart-tools/ (its
  "production limited token" example requests exactly `pins:read boards:read user_accounts:read`, i.e. the
  read-only subset, confirming the read/write split above).
- No scope for pin analytics beyond `pins:read` was found; see "Returned identifiers" / analytics below.

## Identity model: account, boards, and where the board choice lives
- `GET /v5/user_account` (scope `user_accounts:read`) returns the connected account: `id`, `username`,
  `account_type` (example value `"PINNER"`; business-account-specific values not enumerated on the page —
  **UNVERIFIED** full enum), `business_name`, `about`, `profile_image`, `website_url`, `board_count`,
  `pin_count`, `follower_count`, `following_count`, `monthly_views`. By default this is "the token user_account";
  Business Access deployments may pass `ad_account_id` to read a different owned account.
  https://developers.pinterest.com/docs/api/v5/user_account-get/
- `GET /v5/boards` (scope `boards:read`) lists the connected account's boards. Query: `page_size` (1-250,
  default 25), `bookmark` (opaque pagination cursor), `privacy` (enum `ALL`, `PUBLIC`, `PROTECTED`, `SECRET`,
  `PUBLIC_AND_SECRET`), `ad_account_id`. Response: `bookmark` (cursor for the next page) and `items[]`: `id`,
  `name`, `description`, `privacy`, `created_at`, `board_pins_modified_at`, `pin_count`, `collaborator_count`,
  `follower_count`, `is_ads_only`, `owner.username`, `media.image_cover_url`, `media.pin_thumbnail_urls[]`.
  https://developers.pinterest.com/docs/api/v5/boards-list/
- A personal account may hold "up to 2,000 boards of any type (public, private, and secret), including group
  boards you didn't create" and "up to 200,000 Pins including secret Pins and your Pins on group boards".
  https://developers.pinterest.com/docs/work-with-organic-content-and-users/create-boards-and-pins/
- **Every pin create call requires exactly one `board_id`** — a pin belongs to one board, chosen at create time;
  there is no "default board" on the account object and no way to post without naming a board. For Docket this
  means the board choice is a **per-target posting field** (`posting`, G25 — the same pattern TikTok uses for its
  privacy picker), not an account setting: the account has many boards, and each scheduled post must pick one.
  `accountDetails` (G26) should read `GET /v5/boards` live so the picker reflects boards created/renamed/deleted
  on Pinterest after the account was connected.
- Secret boards exist (`privacy: SECRET`, listed via `boards:read_secret`); Docket likely only needs public
  boards for scheduled content, so default the board picker's query to `privacy=PUBLIC` (or `PUBLIC_AND_SECRET`
  if secret-board posting is wanted later) and gate `boards:read_secret` behind that decision.

## Creating a pin
`POST https://api.pinterest.com/v5/pins`, scope `pins:write` (+ `boards:read` to have resolved `board_id`
beforehand). https://developers.pinterest.com/docs/api/v5/pins-create/ and
https://developers.pinterest.com/docs/work-with-organic-content-and-users/create-boards-and-pins/
- **Required**: `board_id` (string). **Required in practice**: `media_source` (the reference page's schema
  lists it beside the optional fields, but a pin cannot exist without media; treat it as required).
- **Optional fields and documented length limits** (from the reference page's schema, all nullable):
  `title` ≤ **100** characters, `description` ≤ **800** characters, `alt_text` ≤ **500** characters,
  `link` ≤ **2048** characters, `note` (no stated limit found — **UNVERIFIED**), `dominant_color` (nullable hex
  string), `board_section_id`, `parent_pin_id`, `sponsor_id`, `is_removable` (boolean; "if you set it to `true`,
  the Pin becomes ad-only" and is auto-added to an "Ad-only Pins" board, skipping `board_id` — not a path Docket
  needs), `ai_disclosures` (object; documented enum value `AI_MODIFIED` seen).
- **`media_source` variants** (the reference page's interactive schema only renders the default-selected tab
  through our fetch tooling, `image_base64`; the other variants are documented on the companion guide page):
  - `image_url` (**PULL from a URL you host**, like TikTok's `PULL_FROM_URL` but — importantly — **no domain or
    URL-prefix verification requirement was found anywhere** in Pinterest's docs, unlike TikTok/Meta. This is a
    major simplification for Docket: `{ "source_type": "image_url", "url": "<https url>" }` should just work from
    Docket's own public media host.)
  - `image_base64`: `{ "source_type": "image_base64", "content_type": "image/jpeg", "data": "<base64>", "is_standard": <bool?> }`.
  - `video_id` (after the upload flow below): `{ "source_type": "video_id", "media_id": "<id>", "cover_image_url": "<https url>" }`
    (cover image may instead be `cover_image_base64` or `cover_image_key_frame_time` — "if that time is past the
    end of the video, Pinterest uses the last frame" per the guide page).
  - `multiple_image_urls` / `multiple_image_base64` (carousel pins, one item per slide, each with its own `title`
    and `link`): documented consistently across several third-party integration guides as **2 to 5 items**, but
    this exact bound was **not confirmed on an official page** reachable by this research — **UNVERIFIED**, keep
    the 2-5 figure provisional.
- **Response** (`GET`/`POST` share the Pin schema): `id`, `created_at`, `link`, `title`, `description`,
  `alt_text`, `dominant_color`, `board_id`, `board_owner`, `board_section_id`, `parent_pin_id`, `creative_type`,
  `is_owner`, `is_removable`, `is_standard`, `is_product`, `has_been_promoted`, `media` (image sizes, or video
  details), `pin_metrics`, `ai_disclosures`. **No permalink/URL-to-the-pin-itself field is in the schema** — the
  well-known `https://www.pinterest.com/pin/<id>/` form is common knowledge, not a documented API field;
  **UNVERIFIED**, construct it client-side and flag it as best-effort (same posture as X's post-URL note).
  https://developers.pinterest.com/docs/api/v5/pins-get/
- Pin analytics (cheap read): `GET /v5/pins/{pin_id}/analytics`, scope `pins:read`, required `start_date`,
  `end_date` (both `YYYY-MM-DD`), `metric_types` (e.g. `VIDEO_MRC_VIEW`, `VIDEO_V50_WATCH_TIME`), optional
  `split_field` (default `NO_SPLIT`), `app_types` (default `ALL`). https://developers.pinterest.com/docs/api/v5/pins-analytics/

## Video pins
Supported via a **four-step** flow (no direct pull-by-URL for video; only `image_url` pulls, never `video_url`):
https://developers.pinterest.com/docs/work-with-organic-content-and-users/create-boards-and-pins/
1. `POST /v5/media` — register intent. Body `media_type` (enum seen on the reference page: `video`,
   `video_long_form`, `tvsci_ads_video`, `image_latent_disclosure`, `video_latent_disclosure`,
   `media_library_image`, `media_library_video` — use `video`). Scopes `pins:read pins:write`. Response:
   `media_id`, `upload_url` (an S3-accelerate bucket URL,
   `https://pinterest-media-upload.s3-accelerate.amazonaws.com/` in the documented example),
   `upload_parameters` (an object of form fields to replay verbatim: `Content-Type: multipart/form-data`,
   `key`, `policy`, `x-amz-algorithm`, `x-amz-credential`, `x-amz-date`, `x-amz-security-token`,
   `x-amz-signature`). https://developers.pinterest.com/docs/api/v5/media-create/
2. `POST <upload_url>` with `Content-Type: multipart/form-data`, every `upload_parameters` key/value pair as
   form fields, plus the video file itself (`.mp4`/`.mov`/`.m4v`). **No `Authorization: Bearer` header on this
   call** — the signed form fields are the auth. Success: **`204 No Content`**.
3. Poll `GET /v5/media/{media_id}` until `status` is `succeeded`. The reference page's example response only
   shows `status: "registered"`; the full enum (presumably including `succeeded`, `failed`, and an
   in-progress value) was **not found verbatim on a reachable page** — **UNVERIFIED** the exact string set,
   though the guide page explicitly instructs "Once you receive a succeeded status you can proceed to step 4",
   confirming `succeeded` is a real value. Treat any value that is neither `succeeded` nor the registered/initial
   state as a failure until the real enum is confirmed. https://developers.pinterest.com/docs/api/v5/media-get/
4. `POST /v5/pins` with `media_source.source_type: "video_id"`, the `media_id`, and a cover image (see above).
   "Video Pins may require additional processing time after creation... you may see an incorrect value for the
   `creative_type` field until processing finishes" — i.e. the pin can come back `done` from Docket's point of
   view (it has an id and is live) while Pinterest is still finishing video processing in the background; no
   further polling is required for Docket's purposes.
- **Specs** (Help Center, not the API reference — re-verify before hard-coding):
  file types `.MP4`/`.MOV`/`.M4V` (`.MOV` only on Android/iOS per one list, but the create-boards guide's upload
  step accepts `.mp4/.mov/.m4v` generally), encoding **H.264 or H.265**, duration **minimum 4 seconds, maximum 5
  minutes**, recommended aspect ratio **9:16 (1080×1920)** for full-bleed, with **1:2, 2:3, 3:4, 4:5, 1:1** also
  listed as options. https://help.pinterest.com/en/article/review-pin-specs
- **Not found on any official page**: maximum video file size in bytes (third-party aggregators repeat "2 GB"
  but none is developers.pinterest.com or help.pinterest.com — **UNVERIFIED**), frame-rate limits
  (**UNVERIFIED**), and whether video specifically needs extra review beyond the general Trial
  sandbox-visibility rule (**UNVERIFIED** — no separate video-specific access gate was found; assume the same
  Trial/Standard rule as everything else).
- A cover image is required in practice: "To create video Pins, provide a video and a cover image."

## Image requirements
Source: Help Center (not the API reference — the reference page documents the `image_url`/`image_base64`
request shape but not server-side validation ranges). https://help.pinterest.com/en/article/review-pin-specs
- File types: **BMP, JPEG, PNG, TIFF, WEBP**.
- Max file size: **20 MB on web**; **1 GB recommended** on Android/iOS (consumer apps, not necessarily the API's
  own ceiling — **UNVERIFIED** whether `POST /v5/pins` with `image_url` enforces 20 MB or something else).
- Aspect ratio: Pinterest **recommends 2:3** (1000×1500 px); "Pins with an aspect ratio greater than 2:3 might
  get cut off in people's feeds" — this reads as a **display/cropping** behaviour, not a hard API rejection;
  **UNVERIFIED** whether the API ever returns an error for an out-of-range image versus silently cropping it in
  the feed. No official minimum/maximum pixel dimensions were found for the API itself.
- No official statement of what the create-pin call does (error vs. silent handling) when an image violates any
  of the above; treat as **UNVERIFIED** and conservative (format-convert and size-cap client-side, as Docket
  already does for every other provider, rather than relying on Pinterest to reject).

## Rate limits and publish limits
https://developers.pinterest.com/docs/reference/rate-limits/
| Category | Trial | Standard |
|---|---|---|
| Universal (all endpoints) | 1000 requests/day/app | 100 requests/second/user/app |
| `org_write` (pin + board create — the category that gates `POST /v5/pins`) | 300/day/app | 100/minute/user/app |
| `org_read` (boards/pins list, `user_account` get) | 1000/day/app | 1000/minute/user/app |
| `catalogs_read` / `catalogs_write` | 1000/day/app | 100/minute/user/app |
| `ads_read` | 1000/day/app | 1000/minute/user/app |
| `ads_write` | 300/day/app | 400/minute/user/app |
| `ads_analytics` | 1000/day/app | 300/minute/user/app |
- Response headers on every call: `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` (seconds
  until the window resets; example value `1`). "All rate limits are subject to change without notice."
- **429 body shape**: the reference page's status-code table says only "The user has sent too many requests in
  a given amount of time and is being rate limited." No JSON example was found on an official page —
  **UNVERIFIED** exact body; match on status `429` and use `x-ratelimit-reset` for `notBefore`, don't parse the
  body.
- No separate "daily pin cap" distinct from the `org_write` rate-limit window was found; the 300/day (Trial) or
  100/minute (Standard, effectively ~144,000/day ceiling before the universal 100/sec cap binds first) figures
  above **are** the publish limit.

## Errors and idempotency
- Documented status codes for `POST /v5/pins` (https://developers.pinterest.com/docs/api/v5/pins-create/):
  `200` success, `201` "Resource create operation completed successfully", `400` "request could not be
  understood... due to unexpected data", `401` "Authentication is required and has either failed or not been
  provided", `403` "valid[auth], but the server is refusing action. The user might not have the necessary
  permissions for a resource", `404` "requested resource could not be found", `429` rate limited (above),
  `default` "An unexpected error response" (the bucket for 5xx).
- **Error body shape**: not shown on the reference page through our fetch tooling for any status code. Several
  independent **community** reports (community.pinterest.biz, not developers.pinterest.com, so **UNVERIFIED** as
  proof) consistently show `{"code": <int>, "message": "<string>"}`, e.g. `{"code":12,"message":"Something went
  wrong on our end. Sorry about that."}`. Do not rely on `code` values without an official source; match on HTTP
  status only.
- A dedicated error-code reference page exists
  (https://developers.pinterest.com/docs/reference/error-codes/) but, as read, it is scoped to **catalog/product
  feed validation errors** (e.g. "Google Product Category is invalid", "Price is missing from product
  metadata") — **not** general Pins/Boards/OAuth errors. Do not use it as the source for pin-creation error
  handling.
- Suggested mapping: `401` → token expired/revoked (`credentialsExpired: true`, retry after refresh; if refresh
  also fails, `needs_reauth`). `403`/`404`/`400` on create → `fatal_error` (insufficient scope, invalid or
  not-owned `board_id`, bad field value — Pinterest's docs do not distinguish these by a separate code, so show
  the body's `message` as sent). `429` → `retryable_error` with `notBefore` from `x-ratelimit-reset`. `default`
  (5xx) before the create call → `retryable_error`; a 5xx/timeout/reset **after** the create call was sent →
  `ambiguous`.
- **No idempotency key or client-token field exists on `POST /v5/pins`** (not in the documented request schema).
  A timeout, connection reset, or unparseable 2xx after sending the create request is therefore genuinely
  ambiguous and **must** be returned as `ambiguous`, never retried blindly (same rule as X). The only documented
  way to check afterwards is `GET /v5/pins` (scope `pins:read`, paginated with `bookmark`/`page_size`, "a list of
  the Pins owned by the operation user_account") — match the most recent items by `board_id` and `title`/`link`
  close to the attempt time. The reference page notes "known performance issues when filtering by field
  `creative_type` and including protected pins" for this endpoint; treat the check as a best-effort human aid,
  not proof, exactly like Docket already does for X. https://developers.pinterest.com/docs/api/v5/pins-list/

## Returned identifiers
- `POST /v5/pins` returns the full Pin object: store `id` as the external id. There is **no documented
  permalink field**; Docket would need to construct `https://www.pinterest.com/pin/<id>/` itself and mark it
  best-effort/unverified in the UI, or omit the `url` on `done` and let the account's own board/profile link
  stand in. `link` in the response is the **outbound** URL the pin points at (what the user clicks through to),
  not the pin's own page — don't confuse the two.
- `board_id` and `board_owner` on the response let Docket confirm which board the pin landed in, useful for the
  ambiguous-duplicate check above.

## API base URL, version, sandbox, region, deprecation
- Base: `https://api.pinterest.com/v5`. v5 is the current and (per multiple API-description changelog entries
  on GitHub, pinterest/api-description, and the deprecated-marked v4 Ads API reference page still reachable at
  `/docs/api/v4/`) the only actively supported version; **v3 and the Ads v4 API are deprecated** — do not build
  against either. https://developers.pinterest.com/docs/api/v4/ (marked deprecated),
  https://github.com/pinterest/api-description/releases
- A literal sandbox host, `https://api-sandbox.pinterest.com/v5`, exists with its own token type, "mainly for
  testing ads/catalogs" per its own doc page; it is a different concept from Trial-access's sandbox-only
  **visibility** on the production host (see Blockers #6). Docket's provider should only ever target
  `api.pinterest.com`. https://developers.pinterest.com/docs/developer-tools/sandbox/
- Region restriction on the core organic Pins/Boards API: **no official page found stating one**. Some
  business/ads features (e.g. country availability for ad accounts) are restricted, but nothing suggests the
  organic pin-creation path itself is geofenced. **UNVERIFIED** either way; no evidence found of a restriction
  for Docket's use case.

## What this means for Docket
Mapped onto `SocialProvider` (`src/providers/types.ts`) and the patterns in `docs/adding-a-provider.md`:
- **`connect`**: `oauth` strategy, a new `OAuthConnectGroup` (`pinterest`). `authorizationUrl` builds
  `https://www.pinterest.com/oauth/?client_id=...&redirect_uri=...&response_type=code&scope=...&state=...`.
  `exchangeCode` calls `POST https://api.pinterest.com/v5/oauth/token` with HTTP Basic
  (`PINTEREST_CLIENT_ID`/`PINTEREST_CLIENT_SECRET`) and `grant_type=authorization_code`; no PKCE. Fetch
  `GET /v5/user_account` to get `externalId` (`id`) and `displayName` (`username`, or `business_name` if
  present). `redirectRequirement`: `{ https: true, publicHost: true }` conservatively (exact rule UNVERIFIED).
  `setupDoc` should state the business-account requirement and the Trial-review wait up front.
- **`settingsSchema`**: likely `z.object({})` — nothing account-level is needed, because the one thing that
  varies per post (the board) is **not** an account setting; it is a **per-target posting field**.
- **`posting` (G25)**: a `valuesSchema` holding `{ boardId: string | null }`, a `view()` rendering a `choice`
  field populated from `accountDetails` (G26, below), `required: true` (a pin cannot be created without a
  board), and `targetNote` showing the chosen board's name. This is structurally like TikTok's privacy picker,
  but simpler (one required field, no toggles).
- **`accountDetails` (G26)**: reads `GET /v5/boards?privacy=PUBLIC&page_size=250` (paginate with `bookmark` if
  an account has more than 250 boards — up to 2,000 are possible) and returns the list of `{id, name}` for the
  picker. Cache briefly like TikTok's creator-info read.
- **`capabilities.text`**: `title` ≤ 100, `description` ≤ 800, `alt_text` ≤ 500, `link` ≤ 2048 — all simple
  character counts per the reference schema's `maxLength`; Pinterest does not document a weighting/NFC rule like
  X or Threads, so `countingRule: "code_points"` is the safest default (**UNVERIFIED** that Pinterest counts the
  same way; no page states it explicitly). Docket's `text` field maps most naturally to `description` (what a
  Pin's body text is), with `title` and `link` as separate concerns the composer doesn't currently model per
  other providers — flag this mismatch for the spec: Pinterest wants three separate text slots
  (title/description/link), not one.
- **`capabilities.media`**: `maxImages`: 1 for a plain pin, with carousel support (2-5, **UNVERIFIED** exact
  bound) as a `postType: "carousel"` option, matching the existing `PostShape`/`PostTypeChoice` machinery
  (though Pinterest's carousel is one request with an `items[]` array, not per-item upload steps — unlike every
  other provider Docket has). `allowedMimeTypes`: `image/bmp, image/jpeg, image/png, image/tiff, image/webp`
  (Help Center, re-verify). `maxBytesPerFile`: 20,000,000 (Help Center "20 MB", **UNVERIFIED** as an API-enforced
  ceiling). `maxAltTextLength`: 500. `required: true` (Pinterest has no text-only post type). No official
  min/max pixel dimensions found; `recommendedAspectRatio` ≈ 0.667 (2:3) is documented, hard min/max are not
  (**UNVERIFIED**) — leave `minAspectRatio`/`maxAspectRatio` unset or very loose until confirmed, since an
  incorrect hard limit would wrongly refuse valid pins.
- **`capabilities.video`**: `maxVideos: 1`, `withImages: false` (no mixed video+image pin was documented),
  `containers`: only `"mp4"` and `"mov"` exist in Docket's `VideoContainer` type, which does not cover `.m4v`
  (Pinterest's own container list includes `.m4v`) — flag this gap for whoever implements the provider.
  `videoCodecs`: `h264`, and `hevc` (ffprobe's name for H.265, not "h265" — note the naming mismatch against
  Pinterest's own "H.264 or H.265" wording). `minDurationSeconds: 4`, `maxDurationSeconds: 300` (5 minutes, per
  Help Center; ignore third-party claims of 15 minutes, which do not match the official page).
  `maxBytes`: **UNVERIFIED**, no official number found — do not hard-code the commonly repeated "2 GB" without
  re-confirming. Aspect ratio is documented as a **discrete set** (1:2, 2:3, 3:4, 4:5, 1:1, plus 9:16
  recommended for full-bleed), which doesn't map cleanly onto Docket's continuous `minAspectRatio`/
  `maxAspectRatio`; a reasonable (but **UNVERIFIED**) continuous approximation is `minAspectRatio: 0.5`
  (1:2) to `maxAspectRatio: 1` (1:1), with `recommendedAspectRatio: 0.667` (2:3) — confirm against a live upload
  before shipping. `indexAtFront`: not documented either way (**UNVERIFIED**).
- **Steps (`stepFor`/`advance`)**: this provider is simpler than Instagram/TikTok/Threads for the common case,
  because `image_url` needs no upload step at all (no domain verification, no polling):
  - Single image or carousel pin: one step, `create_pin` (`mayPublish: true`), sending `media_source.image_url`
    (single) or `media_source.multiple_image_urls` (carousel, all items in one call).
  - Video pin: `register_media` (not `mayPublish`) → `upload_video` (direct multipart `POST` to the returned
    `upload_url`, reading the file by HTTP `Range` the way Docket's other chunked uploads do, not `mayPublish`)
    → `check_media_status` (`continue` + `notBefore` poll until `succeeded`, not `mayPublish`) → `create_pin`
    (`mayPublish: true`, sending `media_source.video_id` + cover image). No step runs *after* `create_pin`, so
    `afterPublish` (G23) is not needed — once `create_pin` is sent, the only two outcomes are `done` (parsed
    response with an `id`) or `ambiguous` (timeout/reset/unparseable 2xx).
  - Every step before `create_pin` is safe to retry as `retryable_error` on a transient failure (connection
    refused, 5xx, 429 before the request reaches Pinterest).
- **`defaultPublishLimit`**: Pinterest's own `org_write` category gives `{ count: 100, windowSeconds: 60 }` on
  Standard access — set that as the default once an account is flagged Standard. While Trial, the effective cap
  is `{ count: 300, windowSeconds: 86400 }` **per app**, shared across every account the deployer has connected
  — Docket's per-account `defaultPublishLimit` model doesn't express a cross-account shared cap; note this gap
  explicitly in the spec/setup doc (same class of problem as TikTok's unaudited 5-users/24h cap) rather than
  silently under- or over-counting.
- **`creationAllowance`**: not needed — there is no Instagram-style rolling container-creation allowance separate
  from the request-rate limit above.
- **Error handling**: `401` → `retryable_error` with `credentialsExpired: true` (then refresh); a failed refresh
  → `needs_reauth`. `400`/`403`/`404` on `create_pin` → `fatal_error` with Pinterest's `message` shown as sent
  (body shape unconfirmed officially — show whatever text comes back, scrubbed). `429` → `retryable_error`,
  `notBefore` from `x-ratelimit-reset`. Timeout/reset/unparseable 2xx **after** `create_pin` is sent →
  `ambiguous`, never retried (no idempotency key exists, see above).
- **`refreshCredentials`/`needsRefresh`**: store `accessToken`, `refreshToken`, `expiresAt` (`now + expires_in`,
  30 days), and `refreshTokenExpiresAt`. `needsRefresh` true within some margin of `expiresAt` (access tokens
  are long-lived at 30 days, so a generous margin — e.g. a day — is fine, unlike Bluesky's 5-minute JWT margin).
  Persist the **new** `refresh_token` every single refresh (it rotates for the continuous-token path that every
  freshly-created Docket app will be on); if a refresh ever fails outright, `needs_reauth`; 5xx/network →
  `transient`.

## Blockers / unverified (recap)
- Business account + Trial review + Standard-access demo-video upgrade are all out-of-band, human steps a
  deployer must complete before Docket can post publicly through their Pinterest app; until Standard is
  granted, everything Docket "publishes" is invisible to anyone but the connected account's owner.
- PKCE is undocumented — assumed unsupported; confidential client + Basic auth only.
- Legacy (pre-2025-09-25) app refresh-token rotation behaviour is unconfirmed; irrelevant for apps Docket's
  deployers create today, which get the continuous, always-rotating 60-day refresh token automatically.
- No idempotency key on pin creation; a timeout after `create_pin` is unresolvable with certainty — `GET
  /v5/pins` is best-effort only.
- Max video file size in bytes, the full `media` status enum beyond `registered`/`succeeded`, exact error-body
  JSON shape for every status code, and the exact carousel item-count bound (2-5, third-party only) are all
  unconfirmed on an official page reachable by this research — re-verify each with the `platform-researcher`
  agent (live token + account) before encoding as a hard constant, the same caution `x.md` asks for its own
  unverified items.
- No official min/max pixel dimensions for images, and no statement of whether an out-of-range image is
  rejected or just cropped in the feed — Docket should keep doing its own client-side image adaptation rather
  than relying on Pinterest's validation.
- Whether the organic Pins API is region-restricted at all: no evidence found either way.
