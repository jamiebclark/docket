# Meta platforms — verified facts

Checked 2026-10-02 against developers.facebook.com. Re-verify before changing
provider code (use the `platform-researcher` agent). Items marked
**UNVERIFIED** could not be confirmed on an official page; cover them with
mocked tests and treat them as assumptions.

## Graph API version
- Latest: **v26.0** (released 2026-07-29); v25.0 before it.
  Source: https://developers.facebook.com/docs/graph-api/changelog
- Configure via env (`META_GRAPH_VERSION`, default `v26.0`).

## Facebook Pages
Source: https://developers.facebook.com/docs/pages-api/posts
- Text/link post: `POST /{page-id}/feed` with `message` and optional `link`.
- Photo: `POST /{page-id}/photos` with `url` (public image URL) and caption.
- Multi-photo: upload each photo with `published=false`, then
  `POST /{page-id}/feed` with `attached_media=[{"media_fbid": "<id>"}, ...]`.
  **UNVERIFIED** (doc page mentions the approach without detail).
- Native scheduling (`published=false` + `scheduled_publish_time`, 10 min–30
  days ahead) exists — **do not use it**; Docket's scheduler owns timing.
- Permissions: `pages_manage_posts`, `pages_read_engagement`,
  `pages_show_list` (to list Pages via `/me/accounts`); docs also list
  `pages_manage_engagement`, `pages_read_user_engagement`. User must have
  CREATE_CONTENT / MANAGE / MODERATE tasks on the Page. Calls use a Page token.
- Tokens (https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived):
  - short-lived user token → `GET /oauth/access_token?grant_type=fb_exchange_token&client_id&client_secret&fb_exchange_token` (server side) → long-lived user token (~60 days).
  - `GET /{user-id}/accounts` with the long-lived user token → Page tokens
    with **no expiry**; invalidated on password change, role removal, app
    deauthorisation, etc. Detect invalidation (error code 190) → `needs_reauth`.

## Instagram
Overview: https://developers.facebook.com/docs/instagram-platform/overview

### Login path — decision: Facebook Login for Business
| | Instagram Login | Facebook Login for Business |
|---|---|---|
| Host | graph.instagram.com | graph.facebook.com |
| Scopes | `instagram_business_basic`, `instagram_business_content_publish` | `instagram_basic`, `instagram_content_publish`, `pages_read_engagement` (+ `ads_management`/`ads_read` if Page access is via Business Manager) |
| Token | IG user token 1 h → `ig_exchange_token` 60 d → `ig_refresh_token` (≥24 h old) | Facebook user / Page token |
| Needs FB Page | no | yes |

One Facebook Login flow covers both a Page and its linked IG professional
account: `GET /me/accounts?fields=id,name,access_token,instagram_business_account`.
Source: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-login-for-instagram

### Publishing
Source: https://developers.facebook.com/docs/instagram-platform/content-publishing
and https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
- `POST /{ig-id}/media` (`image_url`, `caption`, `alt_text`) → container id;
  then `POST /{ig-id}/media_publish` (`creation_id`).
- Container status: `GET /{container-id}?fields=status_code` →
  `EXPIRED | ERROR | FINISHED | IN_PROGRESS | PUBLISHED`. Publish only when
  `FINISHED`. Containers expire after **24 h**.
- Carousel: one container per item (`is_carousel_item=true`), then a
  container with `media_type=CAROUSEL` and `children`; **max 10 items**. All
  images are cropped to the first image's aspect ratio.
- Images: **JPEG only** (no MPO/JPS), max **8 MB**, aspect ratio **4:5 to
  1.91:1**, width 320–1440 px (scaled outside), converted to sRGB.
- Alt text: `alt_text` (≤1000 chars) on images and carousel images, since
  2025-03-24. Not reels/stories.
- Rate limit: **100 API-published posts per rolling 24 h** per account;
  check with `GET /{ig-id}/content_publishing_limit`.
- No text-only posts; media required. Media must be at a public URL.

## Threads
Get started: https://developers.facebook.com/docs/threads/get-started
- Separate Threads app ID + secret (Threads use case in the Meta app dashboard).
- Testers: invite as "Threads Tester"; the user must accept in Threads under
  Settings → Website permissions.
- **Hosts changed**: docs now show `https://threads.com/oauth/authorize` and
  `POST https://graph.threads.com/oauth/access_token`
  (https://developers.facebook.com/documentation/threads/get-started/get-access-tokens-and-permissions).
  The long-lived-token page still shows `graph.threads.net`. **UNVERIFIED**
  whether `.net` still works — make the base URL configurable
  (`THREADS_GRAPH_BASE`, default `https://graph.threads.com`).
- Scopes: `threads_basic` (required), `threads_content_publish`.
- Tokens (https://developers.facebook.com/docs/threads/get-started/long-lived-tokens):
  short-lived 1 h; long-lived 60 d via
  `GET /access_token?grant_type=th_exchange_token&client_secret&access_token`;
  refresh via `GET /refresh_access_token?grant_type=th_refresh_token&access_token`
  once ≥24 h old and unexpired (another 60 d).
- Publishing (https://developers.facebook.com/docs/threads/posts,
  https://developers.facebook.com/docs/threads/reference/publishing):
  `POST /{user-id}/threads` with `media_type` = `TEXT | IMAGE | VIDEO | CAROUSEL`,
  `text`, `image_url`, `alt_text` (≤1000 chars) → container; then
  `POST /{user-id}/threads_publish` with `creation_id`.
  Recommended wait ~30 s; or poll `GET /{container-id}?fields=status`
  (same status values as IG), once a minute, up to 5 min
  (https://developers.facebook.com/docs/threads/troubleshooting).
  `auto_publish_text=true` lets text posts skip the publish step (we keep the
  two-step flow for uniformity unless a spec decides otherwise).
- Limits: text **500 chars** (emoji counted by UTF-8 bytes); images JPEG/PNG,
  ≤8 MB, width 320–1440, aspect ≤10:1; carousel **2–20 items**.
- Rate limit: **250 posts / 24 h** (+1000 replies); check
  `GET /{user-id}/threads_publishing_limit?fields=quota_usage,config`.

## Local OAuth redirects
- Facebook Login: `http://localhost` redirects are allowed while the app is in
  development mode even with "Enforce HTTPS" on (2018 announcement:
  https://developers.facebook.com/blog/post/2018/06/08/enforce-https-facebook-login/).
  Otherwise HTTPS + Strict Mode exact match
  (https://developers.facebook.com/docs/facebook-login/security). **UNVERIFIED**
  in the current dashboard — test it.
- Threads: **no localhost**, HTTPS required. Use a hosts-file hostname
  (e.g. `docket.local` → 127.0.0.1) with an mkcert certificate, as in Meta's
  sample app (https://github.com/fbsamples/threads_api). Owner chose this.
- Manual token paste fallback: Graph API Explorer can generate user tokens
  with chosen scopes (then exchange as above). Threads: the dashboard "User
  Token Generator" / Explorer "Generate Threads Access Token" — **UNVERIFIED**
  officially.
