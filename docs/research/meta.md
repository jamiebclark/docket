# Meta platforms — verified facts

Checked 2026-10-07 against developers.facebook.com (see "Limits verification,
2026-10-07" at the end for every per-platform limit; "Self-hoster setup
verification, 2026-10-04" and "Rate limits, 2026-10-04" before it; earlier sections last fully checked
2026-10-02). Re-verify before changing
provider code (use the `platform-researcher` agent). Items marked
**UNVERIFIED** could not be confirmed on an official page; cover them with
mocked tests and treat them as assumptions.

Comment, reply and mention **reading** facts (Facebook Page comments,
Instagram comments, Threads replies, Threads mentions) live in
`docs/research/engagement.md` §2, not here — this file covers publishing.

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
- Rate limit: **CONTRADICTORY, see "Limits verification, 2026-10-07"**: the
  content-publishing guide says 100 API-published posts per rolling 24 h, the
  `media_publish` and `content_publishing_limit` references say 50. Check at
  runtime with `GET /{ig-id}/content_publishing_limit`.
  Changed 2026-10-07: was "100 API-published posts per rolling 24 h" stated as fact.
- No text-only posts; media required. Media must be at a public URL.

### Stories
Source: https://developers.facebook.com/docs/instagram-platform/content-publishing#stories
and https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
Checked 2026-10-16.
- Container creation is the same two-call shape as a feed post, with
  `media_type=STORIES` and `image_url` (image) or `video_url` (video) instead
  of a feed container's params: `POST /{ig-id}/media` then
  `POST /{ig-id}/media_publish` (`creation_id`).
- No `caption`, no `alt_text`, no stickers or interactive elements - the
  endpoint accepts none of them for a `STORIES` container.
- Image Stories otherwise follow the same general image handling as a feed
  image (JPEG, 8 MB, 320-1440 px). No hard aspect range is documented for a
  Story; **9:16 is recommended** to avoid Instagram cropping the image or
  showing blank space around it. Docket never crops or pads on its own, so a
  non-9:16 Story image is sent unchanged and a notice says so.
- A published Story counts toward the same `content_publishing_limit` quota
  as every other container Docket creates for the account.
- `media_product_type` (read back on a published container) is documented to
  distinguish `FEED` / `REELS` / `STORY`, but its exact Story-published value
  is **NEEDS RESEARCH** - UNVERIFIED (K17). Nothing in Docket reads this field
  today, so no behaviour depends on the answer.

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

## Rate limits, 2026-10-04
Checked 2026-10-04. Main source: https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
(page fetched through a summarising tool; formulas and codes below are as
reported from that page, so re-read the page before relying on an exact
wording). Verdicts: confirmed / contradicted / not determinable.

### Q1. Facebook Pages with a Page token — CONFIRMED: BUC regime, per Page
- Pages API calls made with a Page (or system user) token fall under Business
  Use Case limits, not Platform limits: "Calls within 24 hours = 4800 * Number
  of Engaged Users", where engaged users are those who engaged with the Page
  in the last 24 h. Reported as scoped per Page, not pooled across the app.
  Source: https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
- The Pages API overview says all Pages requests are subject to rate limiting
  and app consumption is shown in the App Dashboard.
  Source: https://developers.facebook.com/docs/pages-api/overview
- A Page with very few engaged users gets a small budget. The page did not
  state a minimum floor for Pages (the Threads page states a floor of 10
  impressions, see Q5). **UNVERIFIED**: floor for Pages.

### Q2. Instagram Graph API — CONFIRMED: BUC, per app and app-user pair
- "Calls within 24 hours = 4800 * Number of Impressions" (times content from
  the account's professional account entered a screen in the last 24 h),
  rolling 24 h window. Tracked per app and app user pair, i.e. per connected
  IG account's token for this app, not pooled across the app.
  Sources: https://developers.facebook.com/docs/instagram-platform/overview
  and https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
- Business Discovery and Hashtag Search follow Platform limits instead
  (Docket uses neither).
- Publish cap is separate and fixed: "100 API-published posts within a
  24-hour moving period"; carousels count as one post.
  Source: https://developers.facebook.com/docs/instagram-platform/content-publishing
  (the 50 vs 100 discrepancy with the media_publish reference above stands).

### Q3. Platform (app-level) limits — CONFIRMED
- "Calls within one hour = 200 * Number of Users", users being daily active
  users of the app (weekly/monthly used at low activity). This is an app-wide
  pool across all users, not per user. Applies to app-token calls and to
  calls not covered by a BUC.
- User-token calls also count against that user's own rolling one-hour limit,
  pooled across apps; values are undisclosed. Error 17 reports it.
- Practical reading for Docket: the user-token calls (`/me/accounts`, token
  exchange) are connect-time only, so Platform limits are rarely reached.
  How a small app with few DAUs is floored: **UNVERIFIED** (no minimum stated
  on the page as reported).
  Source: https://developers.facebook.com/docs/graph-api/overview/rate-limiting/

### Q4. Per-Page publishing cap for Facebook Pages — NOT DETERMINABLE (none documented)
- No posts-per-day cap appears on the rate-limiting page, the Pages API
  overview, or https://developers.facebook.com/docs/pages-api/posts.
  Only the BUC call budget (Q1) applies. Absence of a documented cap is not
  proof that none exists (Facebook may apply spam/integrity limits that are
  not published). **UNVERIFIED** beyond that. Keep `publish limit: none`
  and rely on error handling (Q6).

### Q5. Threads API — CONFIRMED: impressions-based call limit plus fixed quotas
- Call limit: "Calls within 24 hours = 4800 * Number of Impressions"; CPU
  time "720000 * number_of_impressions" for total_cputime; "2880000 * Number
  of Impressions" for total_time; impression floor of 10. Per Threads
  account (app-user pair; the page text on scope was not captured, so
  **UNVERIFIED** whether it says "per app and user pair").
  Source: https://developers.facebook.com/docs/threads/overview
- Fixed 24 h moving-window quotas: 250 API-published posts (carousel = 1),
  1,000 replies, 100 deletions, 500 location searches. The first two match
  the existing lines; deletions and location searches are new here.
  Sources: https://developers.facebook.com/docs/threads/overview and
  https://developers.facebook.com/docs/threads/troubleshooting
- No per-app call-volume limit was found on the Threads pages. The Threads
  pages fetched give no header or error-code detail; assume the Graph codes
  in Q6. **UNVERIFIED** for Threads-specific codes and headers.

### Q6. Headers and error codes — CONFIRMED, one gap in Docket's table
- Headers (https://developers.facebook.com/docs/graph-api/overview/rate-limiting/):
  - `X-App-Usage`: `call_count`, `total_cputime`, `total_time` (percentages).
  - `X-Business-Use-Case-Usage`: keyed by id, with `call_count`,
    `total_cputime`, `total_time`, `type`, `estimated_time_to_regain_access`
    (minutes), `ads_api_access_tier`. This is the one Pages and Instagram
    calls return.
  - `X-Ad-Account-Usage`: ads only; irrelevant.
  - `X-Page-Usage`: not mentioned on the page. Not a documented header.
- Codes:
  | Code | Meaning |
  |---|---|
  | 4 | App reached its rate limit (Platform) |
  | 17 | User reached their rate limit (subcode 2446079 = old Ads API) |
  | 32 | User or app reached its limit on a Pages API request |
  | 613 | Custom rate limit (subcode 1996 = inconsistent request volume) |
  | 80001 | Page calls with a Page or system user token (BUC) |
  | 80002 | Instagram (BUC) |
  | 80000, 80003-80006, 80008, 80009, 80014 | Ads, Custom Audience, LeadGen, Messenger, WhatsApp, Catalog; not used by Docket |
- Compare: `src/providers/meta/errors.ts` and `src/providers/threads/oauth.ts`
  treat only `[4, 17, 32, 613]` as rate-limited. **80001 and 80002 are
  missing**, and these are the codes Docket's Page-token and IG calls would
  actually receive when the BUC budget is exhausted. Whether they come back
  with HTTP 400 or 403 is **UNVERIFIED**; match on `error.code`, not status.
- Backoff: `estimated_time_to_regain_access` (minutes) in the BUC header is
  the documented wait hint. Use it when present.

### Q7. App role limits — CONFIRMED
- "Apps can have up to 500 administrators." Linked to a verified Business
  Manager: up to a combined 500 analytics users and testers. Other apps:
  "up to 50 testers". The developer role count was not reported in the
  fetched text. **UNVERIFIED** for developers.
  Source: https://developers.facebook.com/docs/development/build-and-test/app-roles
- Threads testers use the same roles list; a separate cap was not found.
  **UNVERIFIED**.

### Is one app per install a concern for a small install?
- No. Page BUC is per Page and IG BUC per app-user pair, so one app does not
  pool Pages or IG accounts together. Platform pool (200 x DAU) is touched
  only by connect-time user-token calls. Dozens of posts/day cost a few calls
  each (container create, polls, publish), far below 4800 x engaged users,
  unless a Page has almost no engagement: then the daily budget is small but
  unpublished. Role caps (50 testers, 500 admins) are well above a few users.
- Poll cost: IG status polling every 10 s doubling to 5 min is about 6-10
  calls per post; fine.

### Code impact notes for the caller (rate limits)
- **Corrected 2026-10-17 (081 research §5.1):** 80001 and 80002 are **already**
  in the rate-limited set — `GRAPH_ERROR_TABLE.rateLimited` is
  `[4, 17, 32, 613, 80001, 80002]` (`src/providers/meta/errors.ts:8`), added by
  commit `3a2626c` and asserted by `src/providers/meta/errors.test.ts:22`. The
  Threads path already reuses the same table. No code change needed here; this
  note previously said the codes were missing, which was stale.
- Optionally read `X-Business-Use-Case-Usage.estimated_time_to_regain_access`
  for backoff in the Meta provider HTTP client.
- docs/limits.md Facebook publish limit row: the research result is "no
  documented cap"; update the "NEEDS RESEARCH (U2)" note (not edited here).

## Insights (081)
Checked 2026-10-17. Method: web search tool, result URLs plus a model summary
of each page (same caveat as "Limits verification, 2026-10-07" above — weaker
than reading the page). Rule applied strictly throughout (spec FR-003): **only
a row marked CONFIRMED is declared or requested by provider code.** A row
marked PARTLY CONFIRMED or NOT CONFIRMED is not declared, not requested, and
not hoped for.

Does Instagram's `/insights` edge batch multiple media ids in one call? **NOT
DOCUMENTED, so treated as confirmed-negative-by-absence** — no `ids`-style
batch parameter appears anywhere in the Instagram insights or IG Media
reference, so `maxPostsPerRead: 1` is declared (research.md §1).

Instagram's story window: **CONFIRMED, 24 hours.** "Story media metrics are
only available for 24 hours." (research.md §1, source below.) This is the
`ephemeralPostTypes` lifetime G34 declares for Instagram stories.

### Instagram media (post) insights — CONFIRMED
Source: <https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights>,
<https://developers.facebook.com/docs/instagram-platform/insights/>. Checked 2026-10-17.

| Metric | Required permission | period / metric_type | Media types | Processing delay | Confidence |
|---|---|---|---|---|---|
| `views` | `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement` | lifetime (no `period` param) | all | up to 48 h | CONFIRMED |
| `reach` | same | lifetime | all | up to 48 h | CONFIRMED |
| `likes` | same | lifetime | all | up to 48 h | CONFIRMED |
| `comments` | same | lifetime | all | up to 48 h | CONFIRMED |
| `saved` | same | lifetime | all | up to 48 h | CONFIRMED |
| `shares` | same | lifetime | all | up to 48 h | CONFIRMED |
| `total_interactions` | same | lifetime | all | up to 48 h | CONFIRMED |

**`impressions` is a deprecation error, not an omission — CONFIRMED, with a
date.** Graph API v22.0 deprecated `impressions` on media and user insights
"applying to all versions April 21, 2025"; requests for media created on or
after 2024-07-02 return an error after that date. `views` is the documented
replacement. Also prohibited for the same reason: `clips_replays_count`,
`ig_reels_aggregated_all_plays_count`, `plays`.
Source: <https://developers.facebook.com/docs/graph-api/changelog/version22.0/>. Checked 2026-10-17.

### Instagram user (account) insights — CONFIRMED for three, one NOT CONFIRMED
Source: <https://developers.facebook.com/docs/instagram-platform/insights/>. Checked 2026-10-17.

| Metric | Required permission | period / metric_type | Processing delay | Confidence |
|---|---|---|---|---|
| `reach` | `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement` | `period=day` | up to 48 h | CONFIRMED |
| `follower_count` | same | `period=day`, retained 90 d, at most 30 d of history | up to 48 h | CONFIRMED |
| `profile_views` | same | `period=day` | up to 48 h | CONFIRMED |
| `views` (account-level, the `impressions` replacement) | same | **required `period`/`metric_type` combination not captured** | up to 48 h | **R1 — NOT CONFIRMED, not declared** |

### Facebook Page post insights — CONFIRMED (a smaller surface than the roadmap)
Source: <https://developers.facebook.com/docs/graph-api/reference/insights/>,
<https://developers.facebook.com/docs/platforminsights/page/>,
<https://developers.facebook.com/docs/permissions>. Checked 2026-10-17.

| Metric | Required permission | period / metric_type | Post types | Processing delay | Confidence |
|---|---|---|---|---|---|
| `post_reactions_by_type_total` | `read_insights`, `pages_read_engagement`, Page token held by a person with the `ANALYZE` task | lifetime | all | not stated | CONFIRMED |
| `post_clicks` | same | lifetime | all | not stated | CONFIRMED |

**FR-005 disagreement, recorded here and in `docs/decisions.md`.** The
roadmap's and spec FR-030's names — `post_impressions`, `page_impressions`,
`page_fans` and their breakdowns — are **deprecated**, announced 2025-08-15,
effective 2025-11-15 (eleven months before today): "the API will return an
**invalid metric error** when calling any of these metrics." The documented
replacements (`post_media_view`, `page_media_view`, `page_follows`) are
**themselves mid-migration**: `post_media_view`/`page_media_view` are
documented but flagged for deprecation as part of Graph API v25.0, with a
"Page Viewer Metric" (`post_total_media_view_unique`,
`page_total_media_view_unique`) planned "by the end of June 2026". Docket runs
v26.0 today (2026-10-17), past both dates, and the search summaries cannot say
which of `post_media_view` / `post_total_media_view_unique` actually answers on
v26.0 today — guessing costs the whole surface (a wrong metric name fails the
whole call). **Decision: ship only `post_reactions_by_type_total` and
`post_clicks` for posts (and `page_post_engagements`/`page_follows` for the
account, next table); the whole views/impressions/reach family is R2, NOT
CONFIRMED, not declared.**
Sources: <https://developers.facebook.com/blog/post/2025/08/15/page-insights-api-updates/>,
<https://developers.facebook.com/documentation/pages-api/platforminsights/page/deprecated-metrics>,
<https://developers.facebook.com/blog/post/2026/02/18/introducing-graph-api-v25-and-marketing-api-v25>.
Checked 2026-10-17.

Prohibited names (test-enforced, not comment-only): `post_impressions*`,
`page_impressions*`, `page_fans*`, `page_posts_impressions*`, and — until R2 is
answered — `post_media_view`, `page_media_view`, `post_total_media_view_unique`,
`page_total_media_view_unique`.

**A third precondition Docket cannot see in `granted_scopes`.** Without
`read_insights` the endpoint answers with an **empty dataset**, not an error.
An account may also hold `read_insights` and still get nothing because the
connecting person lacks the `ANALYZE` task on that Page. Eligibility (G33)
answers "may Docket call?", never "will Docket get numbers?"; an empty answer
presents as 080's existing `nothing_reported`, never as a failure. Named gap,
no code.

### Facebook Page insights (account-level) — CONFIRMED
Source: same as above.

| Metric | Required permission | period / metric_type | Processing delay | Confidence |
|---|---|---|---|---|
| `page_post_engagements` | `read_insights`, `pages_read_engagement`, `ANALYZE` task | day/week/days_28 | not stated | CONFIRMED |
| `page_follows` | same | not stated (documented replacement for `page_fans`) | not stated | CONFIRMED |

**Open period question (083, G38).** Both of these are classified `shape: "unknown"` in 083 because
Docket's account read pins no `period` param and `page_follows` has no documented period at all —
there is no way to say what span of time either number covers, so neither can be plotted over time.
Pinning a `period` on the account read would resolve `page_post_engagements` (not `page_follows`,
which names no period to pin); that is a reader change, out of scope for 083 under FR-005, and left
for whichever later entry decides it is worth doing. See `docs/decisions.md` ("083 — G38").

### Threads media (post) insights — CONFIRMED, declared and read
Source: <https://developers.facebook.com/docs/threads/insights>.
Checked 2026-10-17, re-checked against the official page 2026-10-27.

| Metric | Required permission | period | Processing delay | Confidence |
|---|---|---|---|---|
| `views` | `threads_manage_insights` | `lifetime` | not stated | CONFIRMED — Meta marks it **"in development"** |
| `likes` | same | `lifetime` | not stated | CONFIRMED |
| `replies` | same | `lifetime` | not stated | CONFIRMED |
| `reposts` | same | `lifetime` | not stated | CONFIRMED |
| `quotes` | same | `lifetime` | not stated | CONFIRMED |
| `shares` | same | `lifetime` | not stated | CONFIRMED — Meta marks it **"in development"** |

Endpoint: `GET /{threads-media-id}/insights?metric=…` on the Threads graph
host (matches Docket's existing Threads transport). Response shape is Graph's
`{ data: [{ name, period, values: [{ value }] }] }` — `values`, **not**
`total_value`, which is what the *user* insights edge returns.

The earlier pass recorded this enum as PARTLY CONFIRMED on third-party
corroboration only, and `src/providers/threads/insights.ts` therefore shipped
shape (b) — `unavailable`, reason "Docket has not confirmed which metrics the
Threads insights API reports". The R3 live check then confirmed the enum from
the official page but the provider was never upgraded with it, so that
placeholder reason stayed on screen. It is now shape (a): a real reader. See
`docs/decisions.md` ("Threads insights, shape (b) → shape (a)").

**"In development" is not a reason to drop a metric.** Both marked names are
part of the documented enum, so Graph does not reject the request — they may
simply not come back, and a key absent from a reading renders no row at all,
never a zero (FR-035). Dropping them would instead guarantee no row forever.

**Three declared keys are prefixed, and this is deliberate.** `views`, `likes`
and `shares` are also Instagram's own field names, and
`tests/integration/insights/provider-seam.test.ts` requires every provider's
declared keys to be disjoint so no shared mapping table can grow between two
platforms using the same word for different events. They are stored as
`threads_views`, `threads_likes` and `threads_shares`; `replies`, `reposts` and
`quotes` collide with nothing and stay Threads' own word. Same precedent as
TikTok's `tiktok_like_count`. The **request** always sends the raw names.

### Threads user (account) insights — NOT CONFIRMED, not declared (`account: []`)
The Threads *profile* edge (`/{threads-user-id}?fields=…`) exposes
`follower_count` and 7-day counters `likes_count`, `quotes_count`,
`reposts_count`, `views_count` — but these are **profile fields, not insight
metrics**, and are not the `user_insights` metric enum. Declaring a profile
field as an insights metric key would be a category error. **R4 — NOT
CONFIRMED.** Account surface stays `account: []` either way.
Source: <https://developers.facebook.com/documentation/threads/threads-profiles>. Checked 2026-10-17.

## Limits verification, 2026-10-07
Checked 2026-10-07. Scope: replace the interim, UNVERIFIED rows in
docs/limits.md. Method caveat: the fetch tool returns a model summary of each
page, not raw text, and it only reports what the page text contains; "not
specified" below means the summarised page did not state it, and absence is not
proof that no limit exists. Quotes are as reported by the tool.

### Facebook Page posts
Sources: https://developers.facebook.com/docs/graph-api/reference/page/photos/,
https://developers.facebook.com/docs/graph-api/reference/page/feed/,
https://developers.facebook.com/docs/pages-api/posts

| Limit | Verified value | Source and confidence |
|---|---|---|
| Text max length | **NOT DOCUMENTED. UNVERIFIED.** No character limit on the Page feed reference (`message`) or the Pages posts guide. The photo `caption` is described only as "The description of the photo. Supports Emoji". | Page feed + photos references. Keep a conservative interim cap; the 10,000 in code is not from an official page. Counting method also not documented. |
| Max photos in a multi-photo post | **NOT DOCUMENTED. UNVERIFIED.** `attached_media` takes an array (`attached_media[0]={"media_fbid":...}`, `[1]`, ...); no maximum is stated. The only count found on the feed page is for multi-link posts: "Minimum 2 and maximum of 5 objects" (10 with `multi_share_optimized`), which is a different feature. | photos + feed references. The 10 in code is not official. |
| Max photo file size | **10 MB**: "Files can not exceed 10MB. For .png files, we recommend not exceeding 1MB or the image may appear pixelated." | https://developers.facebook.com/docs/graph-api/reference/page/photos/ . High confidence for the 10 MB; the 1 MB PNG note is a recommendation, not a limit. |
| Accepted photo formats | "`.jpeg, .bmp, .png, .gif, .tiff`". WebP is **not** listed. | same page. High confidence. |
| Text-only posts | **Allowed**: `POST /{page-id}/feed` with `message` (and optional `link`). The guide documents text/link posts without media. | https://developers.facebook.com/docs/pages-api/posts and the feed reference. Medium-high: no sentence says "text-only is allowed", it is shown as the base case. |
| Dimensions / aspect limits | **Not specified** on the photos reference. | UNVERIFIED that none exist. |
| Alt text | `alt_text_custom` parameter on photos: "Accessible alternative description for an image". **No character limit stated.** | photos reference. Limit UNVERIFIED. |
| Native scheduling window | Two pages disagree: feed reference says "between 10 minutes and 75 days"; Pages posts guide says "between 10 minutes and 30 days". Docket does not use native scheduling. | feed reference vs posts guide. CONTRADICTORY. |
| Posts per 24 h | None documented (see "Rate limits, 2026-10-04" Q4). Re-checked: the feed reference mentions rate limiting without numbers. | UNVERIFIED beyond that. |

Best-supported values for Docket: bytes per file 10,000,000 documented (8,000,000
in code is safer than the limit, not wrong); formats JPEG/PNG are a subset of the
documented list; count and text length stay interim and must stay marked
UNVERIFIED.

### Instagram
Sources: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media,
https://developers.facebook.com/docs/instagram-platform/content-publishing,
https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media_publish,
https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit

| Limit | Verified value | Source and confidence |
|---|---|---|
| Caption | "Maximum 2200 characters, 30 hashtags, and 20 @ tags." Counting method (code points vs UTF-16 vs graphemes) **not stated: UNVERIFIED**. | ig-user/media reference. High for the numbers. |
| Hashtags / @mentions per caption | **30 hashtags, 20 @ tags** (new to Docket's capabilities; not enforced today). | same. |
| Alt text | "Alternative text, up to 1000 character, for an image." Re-confirmed. | same. |
| Image format | JPEG only; the guide adds "Extended JPEG formats such as MPO and JPS are not supported." | ig-user/media reference and content-publishing guide. |
| Image size | 8 MB maximum. | ig-user/media reference. The content-publishing guide as summarised did not repeat it. |
| Aspect ratio | "Must be within a 4:5 to 1.91:1 range". | ig-user/media reference. |
| Width | "Minimum width: 320" and "Maximum width: 1440". Re-confirmed, and the older note "scaled outside" is **not** in the summarised text; treat as UNVERIFIED whether out-of-range images are scaled or rejected. | ig-user/media reference. |
| Carousel | Up to 10 container IDs ("up to 10 total images, videos, or a mix"); carousel images are cropped to the first image, default 1:1 if no ratio is given. | media reference + guide. |
| Container creation | "An Instagram account can only create 400 containers within a rolling 24 hour period" (new, not in Docket). | ig-user/media reference. |
| Posts per 24 h | **CONTRADICTORY.** Guide: "Instagram accounts are limited to 100 API-published posts within a 24-hour moving period." `media_publish` reference: "An Instagram professional account can only publish 50 posts within a 24 hour moving period". `content_publishing_limit` reference: `quota_total` "(currently `50`)" with `quota_duration` 86400. The guide as summarised also contains a sentence "Accounts are limited to 50 published posts within a 24-hour period" in the carousel context, so the 50 may be a carousel cap; the page does not make this unambiguous. | Best-supported: **50 is what the endpoint that reports the quota says it is**; 100 is the guide's headline. Medium-low confidence. Read `quota_total` from `content_publishing_limit` at runtime, and do not schedule above 50 per 24 h per account to be safe. |
| Text-only | Not allowed; media required (unchanged). | content-publishing guide. |

### Threads
Sources: https://developers.facebook.com/docs/threads/posts,
https://developers.facebook.com/docs/threads/reference/publishing,
https://developers.facebook.com/docs/threads/overview,
https://developers.facebook.com/docs/threads/troubleshooting

| Limit | Verified value | Source and confidence |
|---|---|---|
| Text max | 500 characters. Counting: "Emojis are counted as the number of UTF-8 bytes" (posts guide links grapheme-splitter); the publishing reference says "emojis are counted as the number of UTF-8 bytes". Exact treatment of non-emoji characters is not stated: UNVERIFIED. | posts guide, publishing reference, overview ("Text posts are limited to 500 characters"). High. |
| Carousel | Minimum 2, maximum 20 children. | posts guide, overview. High. |
| Images | JPEG and PNG, 8 MB maximum, aspect ratio limit 10:1, minimum width 320 px, maximum width 1440 px. Re-confirmed. | posts guide and overview. High. |
| Links | "The number of links is restricted to 5 or less" (5 unique links per post). `link_attachment` ("The URL attached to a Threads post") works only on **text-only** posts. | posts guide. Medium-high (summarised). |
| Mentions | **Not specified: UNVERIFIED.** | posts guide, overview. |
| Topic tag | 1-50 characters, no periods or ampersands. | posts guide and publishing reference. |
| Alt text | "Maximum length: 1,000 characters." | publishing reference. High. |
| Posts per 24 h | "Threads profiles are limited to 250 API-published posts within a 24-hour moving period" (carousel counts as one, see Q5); troubleshooting shows `quota_total: 250, quota_duration: 86400`. Also replies 1,000, deletions 100, location searches 500 per 24 h. | overview + troubleshooting. High. |

### Per-account posting rate limits not yet in capabilities
- Facebook: none documented.
- Instagram: 400 containers per rolling 24 h (not modelled); publish 50 vs 100 above.
- Threads: 250 posts, 1,000 replies, 100 deletions, 500 location searches per 24 h; only posts are modelled and match.

### Code impact (from this section)
- Instagram publish limit is 100 / 86400 in code; official references say 50. Use 50 or read the runtime quota.
- Facebook `maxBytesPerFile` 8 MB is under the documented 10 MB; text length and image count have no official basis.
- Instagram caption hashtag (30) and mention (20) limits are documented but not validated by Docket.

## App Review is NOT needed for comment/reply scopes on your own accounts

Checked 2026-10-14, while scoping a reply-and-mention feature for Stencilvania.

Every Meta permission has two access levels, and the default one already covers
Docket's case:

- **Standard Access** — https://developers.facebook.com/docs/graph-api/overview/access-levels
  "Business, Consumer, and Gaming apps are automatically approved for Standard
  Access for all permissions and features available to their app type." No App
  Review. The catch: "Permissions with Standard Access can only be requested
  from app users who have a role on the requesting app."
- **Advanced Access** — "must be approved on an individual permission and
  feature basis through the App Review process", and since February 2023 may
  require a verified business. This is what you need to reach users who are
  *not* role-holders.

So an unpublished app in Development mode can use `instagram_manage_comments`,
`pages_read_engagement` and `threads_manage_replies` **against accounts whose
owner holds a role on the app** without any review. That is exactly the shape
Docket already uses for Threads: the app stays in development and the brand
account is added as a Threads Tester
(https://developers.facebook.com/docs/development/release — "If your app will
only be used by people who have a role on the app itself you do not need to
complete any of these processes").

App Review becomes necessary only if Docket is ever offered to people who are
not role-holders on the Meta app — a multi-tenant install, not a personal one.

**One thing still to verify empirically before building**: comments on your
posts are written by third parties, and Meta trims public user data at Standard
Access in places. Confirm with Graph API Explorer that commenter id/username
actually come back on your own media before designing around them. Start the
work with that spike.

Threads scopes seen in the docs: `threads_basic`, `threads_content_publish`,
`threads_manage_replies`, `threads_delete`, `threads_location_tagging`
(https://developers.facebook.com/docs/threads/overview). Docket currently
requests only the first two (`src/providers/threads/connect-group.ts`).

## Live verification, 2026-10-17 — R1-R4 closed by hand

Run against the real Page `833153016553917` (Weird Glens of Hollywood), post
`833153016553917_122104848675100128` (published 2025-11-18), in Graph API Explorer on
**v26.0**, app "Docket" (`1612880213950633`). This closes R1-R4 of
`specs/081-insights-reconnect-and-meta/research.md` §7 and corrects two things the
desk research got wrong.

### R2 — CONFIRMED: Facebook does get a views/reach pair

One call, `period=lifetime`, Page token:

```
/{post-id}/insights?metric=post_media_view,post_total_media_view_unique,post_reactions_by_type_total,post_clicks&period=lifetime
```

| metric | value | shape | the API's own description |
|---|---|---|---|
| `post_media_view` | 35 | number | "The number of times your Page's post entered a person's screen." |
| `post_total_media_view_unique` | 4 | number | "The number of total unique media viewers for FB post" |
| `post_reactions_by_type_total` | `{}` | **object** | "Lifetime: Total post reactions by type." |
| `post_clicks` | 0 | number | "Lifetime: The number of clicks anywhere in your post on News Feed..." |

`post_media_view` is views, `post_total_media_view_unique` is reach. Both were on the
prohibited list on the assumption R2 could not be answered; both are now declared.

Two facts the metric names do not tell you:

- **Values are not uniformly numeric.** `post_reactions_by_type_total` is a map of
  type -> count, and `{}` when the post has no reactions — a real zero, not a missing
  value. The reader kept only `typeof value === "number"`, so this metric was declared,
  labelled "Reactions" in the panel, and could never produce a number.
- **Pin `period`.** Without it, `post_total_media_view_unique` answers with a `lifetime`
  block *and* a `day` series in one array; a reader taking the last entry gets a recent
  day's zero instead of the lifetime value. `post_media_view` returns `lifetime` only.

Lifetime values still resolve on a post ~11 months old, so insights outlive the poll window.

### A Page access token is mandatory

`GET /{page-id}/posts` with a **user** token holding every scope:

```
code 190, error_subcode 2069032
"User Access Token Is Not Supported"
"A Page access token is required for this call for the new Pages experience."
```

The reader must use the stored per-Page token. (`readPageToken` already does.)

### `read_insights` is not granular — the `analyze` task gates it

`/debug_token` on a freshly granted user token lists per-Page target ids for
`pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`,
`instagram_manage_insights` and `instagram_content_publish` — but `read_insights`
appears **only in the flat scope list, with no target ids**.

Meta's Pages insights documentation requires `pages_read_engagement` + `read_insights` +
a Page token whose holder can perform the **`analyze` task** on that Page. That is a
Business-Manager role, not a scope. An account can therefore hold every permission Docket
asks for and still read nothing, and "Insights need a reconnect" would misdiagnose it —
reconnecting cannot grant a role. **This needs its own state; it is not covered yet.**

### `/me/accounts` is empty for portfolio-owned Pages

With `pages_show_list` granted, `/me/accounts` returned `{"data": []}` and the Explorer's
Page-token picker found nothing. The ids came from `/debug_token` granular scopes —
exactly the workaround `src/providers/meta/candidates.ts:61-66` already documents.
`/me/businesses` needs `business_management`, which Docket does not request.

### R1 — CONFIRMED (official docs)

Instagram user-level `views` requires `period=day` **and** `metric_type=total_value`.
Every IG interaction metric requires `metric_type=total_value`; the account read was not
sending it.

### R3, R4 — CONFIRMED (developers.facebook.com/docs/threads/insights)

- Threads **media**: `views`, `likes`, `replies`, `reposts`, `quotes`, `shares`.
  `shares` exists but Meta marks it **"in development"** — declaring it accepts that it
  may not return data.
- Threads **user_insights**: `views`, `likes`, `replies`, `reposts`, `quotes`, `clicks`,
  `followers_count`, `follower_demographics`. `since`/`until` are optional (default: a
  2-day range, yesterday through today) and are **not supported** by `followers_count`
  or `follower_demographics`.

### Correction: `profile_views` is gone

Meta's user-insights reference no longer lists `profile_views` (it lists
`profile_links_taps`); it was deprecated in January 2025 and removed that April. Graph
errors the whole request on an unknown metric name, so declaring it would have taken
`reach` and `follower_count` down with it. Removed and added to the prohibited list.

### `threads_manage_insights` is not grantable from the Graph API Explorer

It is absent from that tool's permission list entirely — Threads runs on its own API with
its own app configuration. A Threads insights grant cannot be exercised the way the
Facebook/Instagram one can, so the assumption that one reconnect flow covers all three
Meta surfaces does not hold for Threads.

## Post permalinks, 2026-10-29

Why: Pinterest, X and Bluesky have always answered a publish with the post's address, so
`post_targets.external_url` is set for them. Facebook, Instagram and Threads never did, so that
column was null for every Meta post Docket has ever published — which is why the Posts page showed
no link for them, and why an Instagram comment in the inbox had no post to point at. None of the
three returns the address in the publish reply, so each needs one extra read.

### CONFIRMED — the field per surface

| Surface | Node asked | Field | Value |
|---|---|---|---|
| Facebook Page post | the id Docket stores (`post_id` for photos, else `id`) | `permalink_url` | "The permanent static URL to the post on www.facebook.com" |
| Instagram media | the `media_publish` id | `permalink` | a permanent URL to the media; a public field |
| Threads post | the `threads_publish` id | `permalink` | `https://www.threads.net/@<user>/post/<id>` |

- Page post: https://developers.facebook.com/docs/graph-api/reference/post
- IG Media: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/
  — note `permalink` is **not** available on a child of an album; Docket asks about the parent it
  just published, so this does not bite.
- Threads: https://developers.facebook.com/docs/threads/posts/

### OPEN QUESTION — Facebook Reels have no documented field

A Reel publish answers with a **video** id, and the Video node's documented read fields are `id`,
`created_time`, `description`, `embed_html`, `format`, `event`, `from`, `icon`, `name`, `picture`,
`place`, `source`, `updated_time` — **no `permalink_url`**
(https://developers.facebook.com/docs/graph-api/reference/video/). The Reel status reply
(`video_reels` -> `status`) carries no post id either, so there is nothing to translate the video id
into a post id with.

Asking for `permalink_url` anyway may well work — it is widely used against Page videos — but it is
not documented, and a request per Reel that returns `null` is worse than not asking. Reels are
therefore left without an address on purpose. To close this, verify `permalink_url` on a real Page
video id, or find a documented video -> post id edge.

### Implementation note

`src/providers/meta/permalink.ts` is **best effort by contract**: the post is already published and
its id already known by the time it runs, so every failure answers `null` and the publish stays
`done`. A missing link is cosmetic; a publish turned ambiguous over one is not. It also refuses
anything that is not an `https://` URL, since the value is rendered as a link.
