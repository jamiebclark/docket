# X (formerly Twitter) — verified facts

Checked 2026-10-07 (publish limit re-confirmed; rest 2026-10-06) against docs.x.com (the `.md` renderings of each page). The
fetch tool summarises pages, so exact JSON bodies not shown on a page are marked
**UNVERIFIED** rather than guessed. docs.x.com became unreachable near the end
of the session; the items it blocked are listed under "Not confirmed". The
provider is built and tested against mocked HTTP only, so cover every
**UNVERIFIED** item with a test that tolerates both shapes. Re-verify before
changing provider code (use the `platform-researcher` agent).

Doc index (all pages): https://docs.x.com/llms.txt and https://docs.x.com/x-api/llms.txt

## Hosts
- API: `https://api.x.com` (the old `api.twitter.com` is not used by current docs).
- Authorize page: `https://x.com/i/oauth2/authorize`
- Token endpoint: `https://api.x.com/2/oauth2/token`
  https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code

## Access and pricing (brief; for a self-hoster docs note)
Source: https://docs.x.com/x-api/getting-started/pricing and https://docs.x.com/changelog.md
- The API is **pay-per-usage**: "No subscriptions". Credits are bought upfront
  in the Developer Console and deducted per request. No Free, Basic or Pro
  tier on the pricing page. Auto-recharge and a per-cycle spending limit exist;
  requests are blocked when the monthly spending limit is reached.
- Create post: **$0.015 per request**; a post **containing a URL: $0.20**
  (changelog 2026-04-16: "$0.015 per post (URLs cost $0.20 per Post)").
  Docket posts often carry links, so budget ~$0.20 each.
- Reads $0.005 per post, $0.010 per user; "Owned Reads" (your own app, own data,
  e.g. `GET /2/users/{id}/tweets`) **$0.001 per resource**. Resources are
  deduplicated per 24 h UTC day. Post reads are capped at 3 million per cycle.
- Media upload and `GET /2/users/me` cost: **UNVERIFIED** (not on the pricing page text seen).
- Quote-posting (`quote_tweet_id`) needs an Enterprise plan; not available self-serve.
  https://docs.x.com/x-api/posts/create-post.md
- Changelog 2026-10-02: new pay-per-use accounts get promotional credits ($20 on
  first saved card; first auto-recharge matched up to $50; expire after 3 months).
- Legacy subscription Basic/Pro (and migration dates) appear only on third-party
  pages in my results; the official pages do not mention them. **UNVERIFIED**.
- No documented per-app monthly post cap in the pay-per-use model, other than
  rate limits below and the spending limit. **UNVERIFIED** whether any
  daily cap exists beyond them.

## Auth: OAuth 2.0 Authorization Code with PKCE
Source: https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code
- Authorize URL query: `response_type=code`, `client_id`, `redirect_uri`
  (exact match with a registered URL, RFC 6749), `scope` (space separated),
  `state` (up to **500** characters), `code_challenge`, `code_challenge_method`
  (`S256` or `plain`; use S256).
- Scopes: `tweet.read`, `tweet.write` (post), `users.read`, `offline.access`
  (refresh token), `media.write` (upload media). Create post requires
  `tweet.read`, `tweet.write`, `users.read`
  (https://docs.x.com/x-api/posts/create-post.md); `GET /2/users/me` requires
  `users.read` and `tweet.read`
  (https://docs.x.com/x-api/users/get-my-user.md); media upload endpoints
  require `media.write`
  (https://docs.x.com/x-api/media/initialize-media-upload.md).
  Full set to request: `tweet.read tweet.write users.read media.write offline.access`.
- Authorization code lifetime: the page says the auth code "has a time limit of
  **30 seconds**" after approval; exchange immediately in the callback.
- Access token: valid **2 hours** by default; `expires_in: 7200` in the token
  response. Response fields: `token_type` ("bearer"), `expires_in`,
  `access_token`, `refresh_token`, `scope`
  (shown on https://docs.x.com/fundamentals/authentication/oauth-2-0/oauth-1-0a-token-exchange.md,
  which returns the same shape).
- Refresh token: only issued with `offline.access`. Refresh request:
  `POST https://api.x.com/2/oauth2/token`, form-encoded
  `grant_type=refresh_token`, `refresh_token`, and `client_id` (body
  `client_id` required for public clients).
  The token-exchange page states refresh tokens last **~6 months and are
  single-use**. The authorization-code page says nothing about expiry or
  rotation, so treat as: **a refresh returns a new refresh token; persist it every time,
  serialise refreshes per account** (same discipline as Bluesky). Exact 6-month
  figure and error body for a reused token: **UNVERIFIED**.
- Client types: confidential (web apps, bots; has a client secret) authenticates
  the token call with `Authorization: Basic base64(client_id:client_secret)` and
  need not send `client_id`; public clients must send `client_id` in the body.
  https://docs.x.com/fundamentals/authentication/oauth-2-0/oauth-1-0a-token-exchange.md
  (same rule quoted on the authorization-code page). A self-hoster registers
  their own app, so use confidential with Basic auth.
- Redirect URIs: exact match including trailing slash; registered in the
  Developer Console. From a search snippet of the developer-apps page (page body
  unreachable at the end): max 10 callback URLs, https in production, local
  development must use `http://127.0.0.1`, not `localhost`; schemes such as
  `javascript:`, `data:`, `file:` refused. **UNVERIFIED** (confirm at
  https://docs.x.com/resources/fundamentals/developer-apps). Safe plan:
  `redirectRequirement` https + public host, with the 127.0.0.1 note in setup docs.
- OAuth 1.0a user context (api key + secret, per-user token + secret) still
  works for the same endpoints (UserToken scheme in the references) and a
  token exchange exists (changelog 2026-09-21). Docket should not use it:
  signing is complex and OAuth 2.0 covers every endpoint needed.
  https://docs.x.com/fundamentals/authentication/overview.md
- App permission level (Read / Read and write) in the Developer Console must
  permit writing: **UNVERIFIED** (page unreachable).

## Create post: `POST https://api.x.com/2/tweets`
Source: https://docs.x.com/x-api/posts/create-post.md and
https://docs.x.com/x-api/posts/manage-tweets/quickstart.md
- Auth: `Authorization: Bearer <user access token>`; `Content-Type: application/json`.
- Body: `text` (string; "Required unless media is provided"),
  `media: { media_ids: ["..."] }` (1 to 4 items; "up to 4 photos, 1 animated GIF,
  or 1 video"), `reply: { in_reply_to_tweet_id, exclude_reply_user_ids? }`,
  `quote_tweet_id` (Enterprise only), `poll {options (2-4), duration_minutes (5-10080)}`,
  `reply_settings` (`following`, `mentionedUsers`, `subscribers`, `verified`),
  `geo`, `community_id`, `for_super_followers_only`, `paid_partnership`
  (added 2026-06-03), `made_with_ai`, `nullcast`, `edit_options`, `card_uri`,
  `direct_message_deep_link`.
- Minimal request: `{"text":"Hello from the X API!"}`; with media:
  `{"text":"...","media":{"media_ids":["1234567890123456789"]}}`; reply:
  `{"text":"...","reply":{"in_reply_to_tweet_id":"1234567890"}}`.
- Success: **HTTP 201**, `{"data":{"id":"1445880548472328192","text":"..."}}`;
  the schema also lists `edit_history_post_ids` (array of ids) and an optional
  `errors` array. `id` is a numeric **string**; keep it a string.
- Threads: post the first, then each next post with
  `reply.in_reply_to_tweet_id` = previous id. Docket posts one post per target,
  so threads are optional.
- Error shape (Problem objects): `type` (URI), `title`, `detail`, usually
  `status`; example from the page:
  `{"status":403,"type":"about:blank","title":"Forbidden","detail":"User video duration exceeded"}`.
  https://docs.x.com/x-api/fundamentals/response-codes-and-errors.md
  Problem `type` variants named in the schema: ResourceNotFound, InvalidRequest,
  NotAuthorizedForResource, NotAuthorizedForField, DisallowedResource,
  InternalError, ResourceUnavailable.
- Status codes: **401** invalid or missing credentials (an expired access token
  lands here; refresh then retry); **403** valid auth but forbidden (permission,
  video over the limit, and duplicates, see below); **429** rate limit or usage cap
  exceeded; **500/502/503/504** wait and retry.
- **403 duplicate content**: not on any official page I could fetch. Third
  parties quote detail `You are not allowed to create a Tweet with duplicate content.`
  **UNVERIFIED**. Treat any 403 on create as `fatal_error` and show `detail`.
- The 429 JSON body shape for v2 and the exact 401 body for an expired token:
  **UNVERIFIED** (match on status, not body). 429 may also mean the spending
  limit or credits are exhausted ("Rate limit or usage cap exceeded"), so a
  429 with `x-rate-limit-remaining` not 0 should not be retried quickly.

## Rate limits
Source: https://docs.x.com/x-api/fundamentals/rate-limits.md (table columns: Per App, Per User)
| Endpoint | Per app | Per user |
|---|---|---|
| `POST /2/tweets` | 10,000 / 24 h | **100 / 15 min** |
| `DELETE /2/tweets/:id` | n/a | 50 / 15 min |
| `POST /2/media/upload` | 50,000 / 24 h | 500 / 15 min |
| `POST /2/media/upload/initialize`, `/:id/append`, `/:id/finalize` | 180,000 / 24 h | 1,875 / 15 min |
| `POST /2/media/metadata` | 50,000 / 24 h | 500 / 15 min |
| `GET /2/users/me` | n/a | 75 / 15 min |
| `GET /2/users/:id/tweets` | 10,000 / 15 min | 900 / 15 min |
- Headers on every response: `x-rate-limit-limit`, `x-rate-limit-remaining`,
  `x-rate-limit-reset` (Unix timestamp in seconds when the window resets). On 429
  wait until `x-rate-limit-reset`. The page does not mention
  `x-user-limit-24hour-*` headers or `Retry-After`.
  https://docs.x.com/x-api/fundamentals/response-codes-and-errors.md
- A 24-hour per-user post cap is not on the page. Older docs/tier pages had
  per-user daily caps; **UNVERIFIED** whether any applies now.
- Re-checked 2026-10-07 at https://docs.x.com/x-api/fundamentals/rate-limits
  (and the `.md` rendering): the row reads `POST /2/tweets | 10,000/24hrs |
  100/15min` (per app | per user). **100 per 15 min per user is now confirmed
  on the official page**; the "interim" label in docs/limits.md can be dropped.
  The 10,000 / 24 h figure is per app, shared by every account. No per-user
  daily cap and no `x-user-limit-24hour-*` headers appear on the page (fetch
  tool summary; absence is not proof). Checked 2026-10-07.

## Media upload (v2)
Sources: https://docs.x.com/x-api/media/quickstart/media-upload-chunked.md,
https://docs.x.com/x-api/media/initialize-media-upload.md,
.../append-media-upload.md, .../finalize-media-upload.md,
.../create-media-metadata.md, .../quickstart/best-practices.md
- Auth: OAuth 2.0 user token with **`media.write`** works (every upload page
  lists `OAuth2UserToken` with `media.write`, or OAuth 1.0a `UserToken`).
- The old `command=INIT|APPEND|FINALIZE` form on the v1.1 style endpoint is not
  to be used: "Do not send command=INIT, APPEND or FINALIZE" to `/2/media/upload`.
- Chunked flow:
  1. `POST /2/media/upload/initialize` JSON body `media_type`, `total_bytes`,
     `media_category` (optional `shared`, `additional_owners`). Response
     `data.id` (media id, string), `media_key`, `expires_after_secs`.
  2. `POST /2/media/upload/{id}/append`, multipart (JSON also allowed) with
     `media` (chunk) and `segment_index` (0 to 9999). Keep each segment at or
     below **5 MB** (server max 8 MB). Response `{"data":{"expires_at": <epoch s>}}`.
  3. `POST /2/media/upload/{id}/finalize`. Response `data`: `id`, `media_key`,
     `size`, `expires_after_secs`, optional `processing_info`
     (`state`, `progress_percent`, `check_after_secs`), optional `image`/`video`.
  4. If `processing_info` is present, poll
     `GET /2/media/upload?command=STATUS&media_id=<id>` until
     `state` is `succeeded` (states: pending, in_progress, succeeded, failed),
     waiting `check_after_secs` between polls. Fits Docket's step machine
     (`continue` + `notBefore`).
- `media_category` enum: `amplify_video, tweet_gif, tweet_image, tweet_video, dm_gif, dm_image, dm_video, subtitles`.
  Omitted means a Post category. Use `tweet_image` for images.
- `media_type` enum includes `image/jpeg, image/png, image/gif, image/webp,
  image/bmp, image/pjpeg, image/tiff` and videos `video/mp4, video/webm,
  video/mp2t, video/quicktime`. The best-practices page lists supported image
  types as **JPG, PNG, GIF, WEBP**; use those four.
- Limits: images **5 MB**, animated GIF **15 MB**, post video 8 GB / 20 min
  (Premium 16 GB / 125 min, effective since changelog 2026-09-01); 4 photos
  or 1 GIF or 1 video per post. Upload limits and post-create limits are
  enforced separately.
- Whether the single-request `POST /2/media/upload` (multipart, one-shot, used
  for small images) is current: it has a rate-limit row, so the endpoint
  exists, but its request/response schema page was unreachable. **UNVERIFIED**.
  Safe mock design: use the chunked flow for images too (one `append` with
  `segment_index` 0, since 5 MB max image fits one segment).
- Alt text: `POST /2/media/metadata`, scope `media.write`, JSON body
  `{"id":"<media id>","metadata":{"alt_text":{"text":"..."}}}`; `text`
  **maxLength 1000**; response `data` holds the media id and
  `associated_metadata`. Set it after finalize and before the post. (The 1000
  limit is from the schema; the older documented limit was 1000 as well.)
- Media can still be rejected when attached to a post after a successful upload.

## Text counting
Sources: https://docs.x.com/fundamentals/counting-characters.md and
twitter-text config https://github.com/twitter/twitter-text/blob/master/config/v3.json
- Limit **280** weighted characters for non-Premium. Longer limits for Premium
  accounts exist but are not documented on the page; **UNVERIFIED**, so Docket
  should use 280 (`create post` rejects longer text for non-Premium).
- v3 config (verbatim values): `maxWeightedTweetLength` 280, `scale` 100,
  `defaultWeight` 200, `transformedURLLength` 23, `emojiParsingEnabled` true.
  Weight 100 (one char) for code points **0 to 4351**, **8192 to 8205**,
  **8208 to 8223**, **8242 to 8247** (decimal). Everything else (CJK, Cyrillic
  extended, etc.) weighs 200. So count units = sum(weight) / 100 and a unit
  total over 280 fails.
- URLs: wrapped by t.co, **23** characters regardless of length.
- Emoji: "All emojis count as 2 characters, regardless of complexity", including
  skin tones and ZWJ sequences.
- Text is normalised to NFC before counting. Attached media counts 0.
  Auto-populated reply mentions do not count; typed @mentions and hashtags do.
- Implementation notes (derived, from the above): normalise NFC, find URLs
  (twitter-text URL detection: a scheme-less `example.com` also counts), replace
  each with 23, split rest into emoji grapheme clusters (2 each) and other
  code points (weight by range). URL detection and emoji regex differ from
  `Intl.Segmenter`, so expect small drift; leave a warning margin.
- npm: `twitter-text` latest **3.1.0**, Apache-2.0, repo `twitter/twitter-text`,
  no deprecation field (https://registry.npmjs.org/twitter-text). Repo shows
  2,291 commits, not archived; last commit date and publish date not seen, and it
  is JavaScript without TS types in the main package, so it looks
  **unmaintained** (UNVERIFIED). Recommendation: implement the rule in-house
  from the v3 config above rather than add the dependency.

## Account card and post URL
- `GET https://api.x.com/2/users/me` with `users.read` + `tweet.read`.
  Response `{"data":{"id","name","username"}, ...}`; `data.id` is the externalId,
  `username` is the handle, `name` the display name.
  https://docs.x.com/x-api/users/get-my-user.md
- Post URL: `https://x.com/<username>/status/<post id>`. Not stated on a docs page
  I fetched; the form `https://x.com/i/status/<id>` also resolves.
  **UNVERIFIED** (well-known behaviour, no official page found).

## Ambiguous publish results
- No idempotency key on `POST /2/tweets` is documented (none in the body schema
  above). **Do not retry a create that may have been sent.**
- Check after a timeout: `GET /2/users/:id/tweets` (the user's own id, from
  `users/me`), up to 3,200 most recent Posts, params `since_id`, `exclude`
  (retweets, replies), `max_results`, `tweet.fields` (e.g. `created_at`).
  Needs an OAuth 2.0 user token; rate limit 900 / 15 min per user; billed as an
  Owned Read ($0.001 per resource).
  https://docs.x.com/x-api/posts/timelines/introduction.md and pricing page.
  Exact `max_results` min/max/default and scopes: **UNVERIFIED** (reference
  page unreachable). Match on `text` and `created_at` after the attempt time.
  Keep it as a human aid; Docket's rule stays `ambiguous` for a timeout
  after sending.
- Duplicate protection: an identical text posted again is refused with a 403
  (third-party reports only; window unknown). **UNVERIFIED**. That makes a
  blind retry safe from double posting but unreliable as proof.

## Not confirmed (docs.x.com unreachable at the end of the session)
- Developer-apps page text on callback URL rules and app permission levels.
- `POST /2/media/upload` one-shot schema; `GET /2/users/:id/tweets` parameter ranges.
- Duplicate-content 403 body; 429 body; refresh-token reuse error body.

## Implications for Docket
- Connect mode: `oauth` group `x`, confidential client (self-hoster's own X
  app) with Basic auth on the token call, PKCE S256, scopes
  `tweet.read tweet.write users.read media.write offline.access`. Env:
  `X_CLIENT_ID`, `X_CLIENT_SECRET`. Verify identity with `GET /2/users/me`;
  externalId = `data.id`, displayName = `@username`. Store `accessToken`,
  `refreshToken`; `expiresAt` = now + `expires_in`. `redirectRequirement`:
  https and public host (document `http://127.0.0.1` for dev as UNVERIFIED).
- Refresh: define `needsRefresh` (within about 5 minutes of expiry, access tokens last 2 h) and
  `refreshCredentials`; persist the new refresh token every time (single-use);
  a refused refresh is `needs_reauth`; 5xx or network is `transient`. A 401
  on create is `retryable_error` with `credentialsExpired: true`.
- Counting rule: custom `x-weighted`, unit "characters", per the v3 config
  (NFC; URLs 23; emoji graphemes 2; code points weight 1 in the four ranges,
  else 2), `maxLength` 280.
- Capabilities: `maxImages` 4, mime `image/jpeg`, `image/png`, `image/gif`,
  `image/webp`; `maxBytesPerFile` 5,000,000 (the doc says 5 MB; use decimal to be
  safe; GIF 15 MB not distinguished); `maxAltTextLength` 1000;
  `textOnlyAllowed` true; `required` false; `postTypes` `["text","image","carousel"]`
  (or just text and image). Video and GIF out of scope.
- Steps: text post goes straight to `create_post` (`mayPublish`); with images,
  one non-publishing `upload_image` step per image (initialize, one append,
  finalize, poll status via `continue` + `notBefore` if `processing_info`,
  then `/2/media/metadata` for alt text), then `create_post`. Ambiguity
  only on `create_post`: timeout, reset or unparseable 2xx. 4xx is `fatal_error`
  (403 included); 429 is `retryable_error` with `notBefore` from
  `x-rate-limit-reset` (seconds) before a create is sent.
- Default publish limit: `{ count: 100, windowSeconds: 900 }` (per-user cap on create);
  consider also a conservative per-day figure only if X documents one.
- Cost note for the self-hoster docs: $0.015 per post, $0.20 with a URL, credits
  bought in advance; running out of credits probably surfaces as 429 or 403
  (**UNVERIFIED**).
- Open risks: pay-per-use pricing and promotions changed three times in 2026
  (Feb, Apr, Oct); unverified duplicate and 429 bodies; refresh-token lifetime;
  callback localhost rule; weighted counting drift against X's own parser
  (URL detection, emoji regex); Premium accounts allow longer posts but Docket
  uses 280; media may be rejected at post time after a good upload; whole-month
  billing surprises if a post fails after charge (no refund policy found).
