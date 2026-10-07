# TikTok Content Posting API — verified facts

Checked 2026-10-07. Sources: developers.tiktok.com docs only. Pages were read through a fetch-and-summarise tool, so
numbers are as quoted by the page text; re-read the linked page before encoding a limit in code. Nothing was run live.
Host for API calls: `https://open.tiktokapis.com`. Authorize host: `https://www.tiktok.com`.

## Blockers for a self-hosted deployment (read first)
1. **Every deployer must register their own TikTok app and pass TikTok's audit** before posts can be public. Until then:
   private only (`SELF_ONLY`), the account must be private, and at most **5 users per 24 h**. App review itself "may take several
   days to two weeks"; the Content Posting audit is separate and has no published duration (**UNVERIFIED**; the feature map's
   "weeks" is not from an official page).
2. **Photo posts are `PULL_FROM_URL` only**, and PULL_FROM_URL needs the **URL prefix or domain verified** in the
   deployer's app (DNS signature for a domain, or a signature file uploaded at the URL prefix). The deployer must control
   the host that serves media. A raw S3/R2/B2 bucket endpoint they do not own cannot be verified. Workaround: serve media
   from a domain the deployer owns (custom bucket domain, or a Docket route on their own domain).
3. **Video can avoid URL verification** by using `FILE_UPLOAD` (chunked PUT of bytes to TikTok's `upload_url`), which
   means the worker reads the file and streams it. Direct post of video is therefore feasible without domain ownership.
4. **Redirect URI must be `https`** for Login Kit web (no `http`, no localhost). Same constraint class as Threads
   (`redirectRequirement: { https: true, publicHost: true }`).
5. **UX is mandatory and per-creator**: the composer must call `creator_info/query` and render a privacy picker with no
   default, interaction toggles, commercial-content disclosure, a consent declaration, and a preview, or the audit fails.
6. Sandbox mode exists but its rules (target-user count, what works) were **UNVERIFIED**; the sandbox page was not reachable.

## App registration and products
- Register at the TikTok for Developers portal; an organisation account is "highly recommended but not required".
  Required: client key and secret (issued), app icon (1024x1024, JPEG/JPG/PNG, up to 5 MB), app name, description,
  **Terms of Service URL and Privacy Policy URL**, platform details (web URL), and **redirect URIs** for Login Kit.
  https://developers.tiktok.com/docs/en/getting-started-create-an-app
- Two modes: **Sandbox** (try integrations without review) and **Production** (version submitted for review). Review needs
  a description and "at least one demo video that shows the complete end-to-end flow" (max 5 videos, 50 MB each). Statuses:
  Draft, In Review, Live, Not Approved. Review "may take several days to two weeks". No API access until approved.
  https://developers.tiktok.com/docs/en/getting-started-create-an-app
  https://developers.tiktok.com/docs/en/getting-started-faq
- Products to add: **Login Kit** (for OAuth) and **Content Posting API**; for Direct Post, enable the **Direct Post**
  configuration inside the Content Posting API product.
  https://developers.tiktok.com/docs/en/content-posting-api-get-started
- URL properties (needed only for PULL_FROM_URL) are verified on the app page, button "URL properties", **in Production
  mode** (so a Sandbox-only app cannot verify; **UNVERIFIED** whether review must pass first). Methods: **Domain**
  (signature string in DNS records; all paths and subdomains then count as owned) or **URL prefix** (`https://` + host +
  path + `/`; host must be a domain, not an IP; download the signature file and host it at that URL).
  https://developers.tiktok.com/docs/en/set-up-development-configuration
  https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide
- Trusted domains and webhooks are configured in the same page: domains start with `https://`, no wildcards or paths, up
  to 20. https://developers.tiktok.com/docs/en/set-up-development-configuration

## Scopes
| Scope | Meaning |
|---|---|
| `user.info.basic` | "Read a user's profile info (open id, avatar, display name ...)" |
| `video.publish` | "Directly post content to a user's TikTok profile." (Direct Post) |
| `video.upload` | "Share content to creator's account as a draft to further edit and post in TikTok." (Upload / inbox) |
https://developers.tiktok.com/docs/en/tiktok-api-scopes
- Direct Post needs `video.publish` approved for the app **and** authorised by the user; Upload needs `video.upload`.
  Whether `user.info.basic` is required for posting: not stated (creator info already returns nickname and avatar);
  **UNVERIFIED**. Request `user.info.basic,video.publish` (comma-separated) to get an `open_id` and display name.

## Direct Post vs Upload
- **Direct Post**: `POST /v2/post/publish/video/init/` (scope `video.publish`) publishes straight to the profile.
- **Upload** (inbox / draft): `POST /v2/post/publish/inbox/video/init/` (scope `video.upload`); the user "must click on
  inbox notifications to continue the editing flow in TikTok and complete the post". Rate limit 6 requests/min per token;
  error `spam_risk_too_many_pending_share`: **at most 5 pending shares within any 24-hour period**.
  https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video
  Whether Upload needs the audit: **UNVERIFIED** (the page says the scope must be approved; privacy is the user's choice
  in-app, so the SELF_ONLY rule is about Direct Post). Upload is not an end-to-end "publish": status ends at
  `SEND_TO_USER_INBOX`, not `PUBLISH_COMPLETE`.
- Docket is a scheduler, so Direct Post is the product; Upload is the fallback while unaudited.

## OAuth v2 (Login Kit for web)
- Authorize: `GET https://www.tiktok.com/v2/auth/authorize/` with `client_key`, `response_type=code`, `scope`
  (comma-separated), `redirect_uri`, `state`; optional `disable_auto_auth` (0/1). The callback carries `code`, `scopes`,
  `state`. https://developers.tiktok.com/docs/en/login-kit-web
- Redirect URI rules (web): absolute, begins with **`https`**, static (no query parameters), no fragment, **max 10 URIs**
  per app, each **under 512 characters**. No `http`/localhost for web.
  https://developers.tiktok.com/doc/login-kit-web
  Desktop is different: `http://localhost:<port>/callback/` and `http://127.0.0.1:<port>/callback/` are allowed, but **PKCE
  (S256) is mandatory** there (code verifier 43-128 chars). https://developers.tiktok.com/docs/en/login-kit-desktop
- **PKCE for web**: not mentioned in the web guide (no `code_challenge` in its parameter list) -> not required for a
  confidential web client. The token page lists `code_verifier` as "mobile/desktop only". **UNVERIFIED** whether sending PKCE
  on web is accepted. Docket should use the web flow (client secret).
  https://developers.tiktok.com/doc/oauth-user-access-token-management
- Token endpoint: `POST https://open.tiktokapis.com/v2/oauth/token/` (form-encoded). Auth-code grant params: `client_key`,
  `client_secret`, `code`, `grant_type=authorization_code`, `redirect_uri`. Refresh: `client_key`, `client_secret`,
  `grant_type=refresh_token`, `refresh_token`. Content-Type exact string: **UNVERIFIED** (standard
  `application/x-www-form-urlencoded`).
- Lifetimes: access token **86400 s (24 h)**, refresh token **31536000 s (365 days)**. "The returned `refresh_token` may be
  different than the one passed in the payload": **store the new one whenever it differs** (same pattern as X in
  `adding-a-provider.md`).
- Revoke: `POST https://open.tiktokapis.com/v2/oauth/revoke/` with `client_key`, `client_secret`, `access_token`.
  Webhook `authorization.removed` fires when a user deauthorises.
  https://developers.tiktok.com/doc/webhooks-events/
- The token response also returns `open_id` (needed to identify the account); field list otherwise **UNVERIFIED**.

## Audit and unaudited limits
From the Content Sharing Guidelines:
- "Unaudited API Clients can allow up to **5 users** to post in a 24 hour window."
- All user accounts using the client to post "must be set to **private** at the time of posting."
- "Unaudited API Clients can only post contents in `SELF_ONLY` viewership." The API error is `403
  unaudited_client_can_only_post_to_private_accounts`. To make a post public later, the owner must make the account public and
  then set each post to "Everyone".
- Both audited and unaudited clients are subject to a **creator cap** and a per-creator posting cap of typically **about 15
  posts per day**, shared across all API clients. Errors: `spam_risk_too_many_posts` (daily cap), `reached_active_user_cap`
  (daily active-user quota), `spam_risk_user_banned_from_posting`.
  https://developers.tiktok.com/docs/en/content-sharing-guidelines
  https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
- To lift the restrictions the client "must undergo an audit to verify compliance with our Terms of Service". The
  application route, review time and required evidence are **UNVERIFIED** (no audit-form page was reachable). The App
  Review FAQ says to use the Support form for "user cap increases". https://developers.tiktok.com/docs/en/getting-started-faq
  Implication: a deployer's app that is not audited is a personal-use poster with SELF_ONLY posts.

## Query creator info (call before every post attempt)
`POST /v2/post/publish/creator_info/query/`, scope `video.publish`, headers `Authorization: Bearer <access_token>`,
`Content-Type: application/json; charset=UTF-8`. **Rate limit 20 requests/min per access token.**
https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
Response fields: `creator_avatar_url` (TTL 2 hours), `creator_username`, `creator_nickname`, `privacy_level_options`
(list; account-type dependent), `comment_disabled`, `duet_disabled`, `stitch_disabled` (ignore duet/stitch for photo-only
clients), `max_video_post_duration_sec` (ignore for photo-only).
Errors: 200 `spam_risk_too_many_posts`, `spam_risk_user_banned_from_posting`, `reached_active_user_cap`; 401
`access_token_invalid`, `scope_not_authorized`; 429 `rate_limit_exceeded`; 5xx retry.
Note: several "errors" come back as HTTP 200 with an error code in the body; check the body, not just the status.

## Required UX (audit checklist)
https://developers.tiktok.com/docs/en/content-sharing-guidelines (and https://developers.tiktok.com/doc/content-sharing-guidelines)
- Show the creator's **nickname** (so the user knows which account receives the post); fetch the latest creator info on
  each posting attempt; stop and tell the user if the creator cannot post right now (cap reached) or if the video
  exceeds `max_video_post_duration_sec`.
- **Privacy**: user picks from a dropdown built from `privacy_level_options`; "there should be no default value". Branded
  content cannot be `SELF_ONLY` (disable "only me" when branded content is on).
- **Interactions**: Allow Comment / Duet / Stitch, **none checked by default**, user turns them on; grey out those that
  `creator_info` says are disabled. Photo posts show **Comment only**.
- **Commercial content disclosure**: a toggle, **off by default**; when on, two checkboxes, "Your brand" and "Branded
  content"; at least one required (disable Publish until chosen).
- **Declaration** shown before posting: "By posting, you agree to TikTok's Music Usage Confirmation." For branded content:
  "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation." (same for both boxes).
  Exact link targets: re-read the page.
- Show a **content preview** and get express consent before sending media ("Only start sending content materials to TikTok
  after the user has expressly consented"); tell the user "it may take a few minutes for the content to process and be
  visible".
- Title is required in the UI; let the user edit any preset text/hashtags. **No promotional watermark or logo** on the
  creator's content.
- A scheduled post cannot satisfy "express consent at send time" by itself; whether consent captured at scheduling time
  passes audit is **UNVERIFIED** and is the biggest product risk for a scheduler.

## Video post: `POST /v2/post/publish/video/init/`
Scope `video.publish`; headers as above. **Rate limit 6 requests/min per access token.**
https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
- `post_info`: `privacy_level` (required; `PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `FOLLOWER_OF_CREATOR`,
  `SELF_ONLY`; must be one of the creator's `privacy_level_options`), `title` (caption, **max 2200 UTF-16 code units**),
  `disable_duet`, `disable_stitch`, `disable_comment`, `video_cover_timestamp_ms`, `brand_content_toggle`,
  `brand_organic_toggle`, `is_aigc`.
- `source_info`: `source` = `FILE_UPLOAD` (`video_size`, `chunk_size`, `total_chunk_count`) or `PULL_FROM_URL` (`video_url`).
- Response: `publish_id` (max 64 chars) and, for FILE_UPLOAD, `upload_url` (max 256 chars, **valid 1 hour**).
- Errors: 400 `invalid_param`; 403 `spam_risk_too_many_posts`, `unaudited_client_can_only_post_to_private_accounts`,
  `url_ownership_unverified`; 401 `access_token_invalid`; 429 `rate_limit_exceeded`.

### FILE_UPLOAD chunking
https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide
- Each chunk **>= 5 MB and <= 64 MB**; the **final chunk may be up to 128 MB** (it absorbs the remainder).
  Videos **under 5 MB** are uploaded whole (one chunk).
- `total_chunk_count` = `floor(video_size / chunk_size)`; **min 1, max 1000** chunks.
- Chunks are uploaded **sequentially** with `PUT <upload_url>`; headers `Content-Type` (e.g. `video/mp4`),
  `Content-Length` (chunk bytes), `Content-Range: bytes FIRST-LAST/TOTAL`. Success: `206` for intermediate chunks, `201`
  when complete. Expired URL: `403`. (Upload page lists Content-Type `video/mp4`, `video/quicktime`, `video/webm`.)
- Example from the guide: a 50 MB file with 10,000,000-byte chunks -> 5 chunks.

### PULL_FROM_URL
- Domain or URL prefix **must be verified**; URL must be `https` and **must not redirect** ("URLs that return HTTP 3xx are
  considered invalid"); the download task **times out one hour** after it starts. Error `url_ownership_unverified`.
- Conflict for self-hosting: the deployer's media host must be verifiable (see Blockers). Docket's public media URLs,
  if served from a bucket endpoint the deployer does not own, will be refused. `FILE_UPLOAD` avoids this for video only.

### Video specs
Media Transfer Guide: formats **MP4 (recommended), WebM, MOV**; codecs **H.264 (recommended), H.265, VP8, VP9**; frame rate
**23-60 FPS**; dimensions **min 360 px, max 4096 px** (height and width); file size **max 4 GB**; duration "up to 10
minutes via API (though users may have lower limits)".
**Conflict**: the Direct Post guide states **max video duration 300 seconds**. The authoritative number is the creator's
`max_video_post_duration_sec` from `creator_info`; use that, never a constant. Aspect ratio limits and bitrate are not
documented: **UNVERIFIED**. Fail reasons for violations: `file_format_check_failed`, `duration_check_failed`,
`frame_rate_check_failed`. https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide

## Photo post: `POST /v2/post/publish/content/init/`
https://developers.tiktok.com/doc/content-posting-api-reference-photo-post
- Scope `video.publish` (Direct Post) or `video.upload` (draft). **6 requests/min per token.**
- `media_type` = `PHOTO` (only value); `post_mode` = `DIRECT_POST` or `MEDIA_UPLOAD`.
- `post_info.title` **max 90** UTF-16 code units; `post_info.description` **max 4000**.
- `source_info`: `source` **only `PULL_FROM_URL`**; `photo_images` **up to 35** URLs; `photo_cover_index` (from 0).
- Image limits (Media Transfer Guide): **WebP or JPEG**, **max 1080p**, **max 20 MB each**. (PNG is not listed.)
- Errors: `invalid_param`, `spam_risk_too_many_posts`, `spam_risk_too_many_pending_share` (5 pending in 24 h), 401
  `access_token_invalid`, 429 `rate_limit_exceeded`, plus `url_ownership_unverified`. The photo Direct Post body fields for
  privacy and interaction toggles are in the same `post_info` object as video (same names, **UNVERIFIED** for photo-specific
  extras such as `auto_add_music`).
- Conflict: a photo post cannot be made without a verified URL prefix/domain (see Blockers).

## Status: `POST /v2/post/publish/status/fetch/`
https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
- Scope `video.upload` or `video.publish`. Body `{ "publish_id": "..." }`. **30 requests/min per token.**
- `status`: `PROCESSING_UPLOAD` (file upload in progress), `PROCESSING_DOWNLOAD` (URL pull in progress),
  `SEND_TO_USER_INBOX` (draft notification sent), `PUBLISH_COMPLETE`, `FAILED`.
- Other fields: `fail_reason`, `publicaly_available_post_id` (sic; a list, returned only when the post is public **and
  approved**, so unaudited/SELF_ONLY posts yield no id and no public URL), `uploaded_bytes`, `downloaded_bytes`.
- `fail_reason` values listed: `file_format_check_failed`, `duration_check_failed`, `frame_rate_check_failed`,
  `picture_size_check_failed`, `internal`, `video_pull_failed`, `photo_pull_failed`, `publish_cancelled`, `auth_removed`,
  plus `spam_risk` variants (full list **UNVERIFIED**; re-read the page).
- Errors: `invalid_publish_id`, `token_not_authorized_for_specified_publish_id`, `access_token_invalid`,
  `scope_not_authorized`, `rate_limit_exceeded`, `internal_error`.
- Docket implication: the TikTok post id/URL may be absent at `PUBLISH_COMPLETE`; the profile URL needs `creator_username`
  from creator info, and the video URL needs the public post id. Plan to store `publish_id` as the external id.

## Webhooks
- Callback URL is set in the developer portal; TikTok POSTs JSON, expects an immediate **200**, retries up to **72 hours**
  with exponential backoff, then discards. https://developers.tiktok.com/docs/en/webhooks-overview
- Signature: header **`Tiktok-Signature`**, HMAC-SHA256 with `client_secret` as the key over `signed_payload`
  (timestamp + "." + raw JSON body); no tolerance window prescribed (choose your own).
  https://developers.tiktok.com/doc/webhooks-verification
- Common payload fields: `client_key`, `event`, `create_time`, `user_openid`, `content`. Events on the general events page:
  `authorization.removed` (`reason` 0-5), `video.upload.failed` and `video.publish.completed` (Video Kit, `share_id`),
  `portability.download.ready`. https://developers.tiktok.com/doc/webhooks-events/
- Content Posting events `post.publish.failed`, `post.publish.complete`, `post.publish.inbox_delivered`,
  `post.publish.publicly_available` (params `publish_id`, `publish_type`) appear in an official search excerpt but I could
  **not open a page that lists them**: **UNVERIFIED**.
- A self-hosted deployment would need a public HTTPS webhook URL per deployer; polling status is the dependable path
  (30 req/min per token is ample).

## Docket integration notes (facts only)
- Each deployer needs their own `TIKTOK_CLIENT_KEY`/`TIKTOK_CLIENT_SECRET`, an https callback they register, ToS and Privacy
  Policy URLs (the app can supply its own pages), and an audit to go public. The setup doc must say so, as `meta-setup.md` does for Meta.
- Token life: refresh daily; handle rotation. A 24 h access token means almost every publish needs a refresh check
  (`needsRefresh` pattern).
- Publish "may publish" step = the final send (FILE_UPLOAD last chunk, or `init` for PULL_FROM_URL); a timeout after `init`
  is ambiguous if the post could already be created; `publish_id` makes the status check a safe read.
- Per-creator cap ~15 posts/day, so a `defaultPublishLimit` should be conservative; unaudited accounts: 5 users per 24 h
  across the whole app.
