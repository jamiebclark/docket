# Meta platforms — verified facts

Checked 2026-10-04 against developers.facebook.com (see "Self-hoster setup
verification, 2026-10-04" at the end; earlier sections last fully checked
2026-10-02). Re-verify before changing
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

## Self-hoster setup verification, 2026-10-04
Checked 2026-10-04. Context: Business-type app, Facebook Login for Business on
Standard Access (no App Review), plus the Threads use case. Verdicts are
confirmed / contradicted / not determinable from official docs.

### 1. App mode (Development vs Live) — CONTRADICTORY pages; partly not determinable
- Business apps have **no app modes**: "Business apps do not have app modes and
  instead rely exclusively on access levels to determine who can grant them
  permissions and who will be affected by features."
  Source: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/app-types/
  This contradicts Docket's assumption (docs/meta-setup.md step 4, Threads
  testers) that a Development/Live toggle governs who can connect.
- Counter-evidence (generic pages): the app-dashboard page says new apps start in
  Development mode and the toolbar toggle switches modes, and lists pre-Live
  requirements: privacy policy and terms URLs, category, platform, icon,
  business verification, data-handling answers.
  Source: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/
  The app-modes page only spells out Consumer apps: in Live mode Standard Access
  permissions "can only be requested from role users".
  Source: https://developers.facebook.com/docs/development/build-and-test/app-modes
  So the dashboard page may be generic and not apply to Business apps.
  **UNVERIFIED** whether a Business app with Facebook Login for Business shows
  a toggle in the dashboard; test it in the live dashboard.
- Who can connect: Standard Access "can only be requested from app users who have
  a role on the requesting app"; Business apps are "automatically approved for
  Standard Access for all permissions and features available to their app type".
  Source: https://developers.facebook.com/docs/graph-api/overview/access-levels
  Pages docs: "Apps in Development Mode can request any Permission from any app
  User who has a Role on the app" (https://developers.facebook.com/docs/pages-api/overview).
  Net effect for Docket: role users (admin/developer/tester) can connect; mode
  is irrelevant on Standard Access for role users.
- Publishing requirements: for apps used only by role users, "you do not need to
  complete verification". Business Verification is needed for Advanced Access.
  Source: https://developers.facebook.com/documentation/development/release/business-verification
  The privacy-policy URL / icon / category / data deletion URL list applies to
  going Live per the app-dashboard page above. A search snippet from Meta's docs
  also says Advanced Access to `public_profile` is required for Facebook Login
  for Business apps before go-live (to support external users); **UNVERIFIED**
  (the page body fetched did not contain it). **UNVERIFIED**: a data deletion
  URL requirement was not seen on any fetched official page.
- Docket needs none of these while only role users connect.

### 2. localhost redirect URIs — NOT DETERMINABLE for this use case
- Confirmed rule (2018 announcement): "You will still be able to use HTTP with
  "localhost" addresses, but only while your app is still in development mode."
  Source: https://developers.facebook.com/blog/post/2018/06/08/enforce-https-facebook-login/
- Current security page requires exact-match redirect URIs, Strict Mode "required
  for all apps", and HTTPS; it does not mention localhost.
  Source: https://developers.facebook.com/docs/facebook-login/security
- Because Business apps have no app modes (item 1), whether the exemption
  applies is **UNVERIFIED**. Keep the U2 test procedure and the
  hosts-file/mkcert fallback.
- Where the field lives: Facebook Login for Business **Settings → Client OAuth
  Settings → Valid OAuth Redirect URIs**.
  Source: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-login-for-instagram
  (the Facebook Login for Business page itself does not cover it). The
  per-use-case menu layout of the current dashboard is **UNVERIFIED**.

### 3. Login configuration token type — CONFIRMED (inference for the choice)
- Two types: "User access token" (real-time, user-triggered actions, tied to the
  person's account, short-lived) and "System-user access token" (automated
  operations, tied to the business portfolio, defaults to never expiring).
  Source: https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
- Docket's flow is user-triggered and uses `/me/accounts`, so choose **User
  access token**. (The choice is our inference from these definitions; the docs
  do not name Docket's flow.) A configuration also needs the permissions picked;
  the app must be a Business-type app.

### 4. Delegated Page access — PARTLY CONFIRMED
- A Page owner is not required: "the app User must own or be able to perform a
  Task on the Page." Admin access in the UI grants all tasks. Source:
  https://developers.facebook.com/docs/pages-api/overview
- Posting needs `CREATE_CONTENT`, `MANAGE` and/or `MODERATE` per the manage-pages
  page (https://developers.facebook.com/docs/pages-api/manage-pages); the Page
  photos reference says a Page token "requested by a person who can perform the
  `CREATE_CONTENT` task" (https://developers.facebook.com/docs/graph-api/reference/page/photos/).
  So a user with task access can obtain a Page token with `pages_manage_posts`.
  `/{user-id}/accounts` returns "Pages that a person owns or is able to perform
  tasks on" (https://developers.facebook.com/docs/graph-api/reference/user/accounts/).
- New Pages experience "Facebook access" vs "task access" wording: **UNVERIFIED**.
  The new-Pages-experience page (https://developers.facebook.com/docs/pages-api/new-pages-experience)
  says the same permissions and tasks apply per endpoint; the fetched text did
  not describe "Facebook access" or Business Portfolio behaviour.
- When a Business-Portfolio-only Page is missing from `/me/accounts` without
  `business_management`/`ads_management`: **UNVERIFIED** for Facebook Pages. The
  only official statement found is for Instagram publishing: "If the app user was
  granted a role on the Page connected to your app user's Instagram professional
  account via the Business Manager, your app will also need: `ads_management`,
  `ads_read`" (https://developers.facebook.com/docs/instagram-platform/content-publishing).
  The manage-pages page names `business_management` only for business system
  users. Workaround that is documented: none found; practical advice (give the
  user a direct Page task via the Page's own access settings) is **UNVERIFIED**.

### 5. Instagram via Facebook Login: required Page task — CONFIRMED; IG-only NOT DETERMINABLE
- "The app user whose token is used in the request must be able to perform
  `MANAGE` or `CREATE_CONTENT` tasks on the Page" connected to the Instagram
  account. Needs `instagram_basic` + `instagram_content_publish` (+
  `pages_read_engagement` for Facebook Login).
  Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media_publish
  and https://developers.facebook.com/docs/instagram-platform/content-publishing
- Getting-started lists MANAGE, CREATE_CONTENT, MODERATE or ADVERTISE for reading
  IG data (https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/get-started);
  publishing needs MANAGE or CREATE_CONTENT specifically.
- IG-only access without a Page role: the Facebook Login path requires Page tasks
  and a linked Page; no official statement found that IG-only access suffices
  (that is the Instagram Login path, a different flow). Treat as not enough.
- Page Publishing Authorization (PPA) may block publishing until completed.
- Doc discrepancy: the media_publish reference says 50 posts per 24 h while the
  content-publishing guide says 100. Existing line above keeps 100;
  **UNVERIFIED** which is current — read `content_publishing_limit` at runtime.

### 6. Threads testers — PARTLY CONFIRMED
- Add: App Dashboard → App roles → Roles → **Add People** → **Threads Tester**.
  The docs say the invitation goes to the "Threads user's profile"; whether a
  username is typed is **UNVERIFIED**.
- Accept: "Website permissions" section under Account Settings on the Threads
  website or app. The docs do not give the exact menu path; the repo's
  "Settings → Account → Website permissions" is plausible but **UNVERIFIED**.
- Meta developer account for invitee: not stated — **UNVERIFIED**.
- Beyond testers: "each permission must first be approved through the App Review
  process, and your app must be published." Source:
  https://developers.facebook.com/docs/threads/get-started
- No delegated/managed access: **NOT DETERMINABLE** as a negative statement.
  The docs only describe the Threads user logging in and choosing which data to
  allow (https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions),
  with no mention of managed or delegated roles. Treat owner-only as the working
  assumption.

### 7. One app for both use cases — LIKELY YES, with a caveat
- "You can add the **Access Threads API** use case to an app with the **Manage
  everything on your Page** use case"; it "can't" be combined with
  "Authenticate and request data from users with Facebook Login" (incompatible).
  Source: https://developers.facebook.com/documentation/development/create-an-app
- Multiple use cases are allowed when compatible
  (https://developers.facebook.com/docs/development/create-an-app/app-dashboard/).
  The Pages create-an-app guide customizes Facebook Login for Business under the
  Page use case (https://developers.facebook.com/documentation/pages-api/create-an-app).
- **UNVERIFIED**: Docket's exact pair (a Business app with the separate-named
  "Facebook Login for Business" use case plus Threads) was not stated; the
  dashboard only shows compatible use cases. Docket already treats the Threads
  app id/secret as a separate pair.

### 8. Page photo `url` fetched by Facebook — CONFIRMED (public reachability implied)
- `url` is "a photo that is already on the internet"; Facebook fetches it.
  Sources: https://developers.facebook.com/docs/graph-api/reference/page/photos/,
  https://developers.facebook.com/docs/pages-api/posts
- Docs do not literally say "publicly accessible" for this endpoint (Instagram
  and Threads guides do for media). Treat the host as needing to be public.

### Code impact notes for the caller
- No limit/endpoint/host change found. Doc claims to revisit: the Development vs
  Live assumptions in docs/meta-setup.md, and the 50 vs 100 IG limit.
