# Engagement inbox — verified facts

Checked 2026-10-19. Bluesky section confirmed from the installed
`@atproto/api` generated types and `docs/research/bluesky.md`. §2 (Meta and
Threads comment/reply/mention reading) is now researched against official
Meta documentation via `WebSearch` (see
`specs/084-meta-engagement-facts-and-scope-gate/research.md` §1 for why that
tool, and not a human task, is the mechanism); several cells remain
`unverified` because documentation does not state the answer, not because
nobody looked. Direct messages (§3) remain unverified pending a live session.

## 1. Bluesky — confirmed

Source: `node_modules/@atproto/api/dist/client/types/app/bsky/notification/listNotifications.d.ts`
(installed package, read directly — not summarised), cross-checked against
`docs/research/bluesky.md` (checked 2026-10-07).

**Reading.** `app.bsky.notification.listNotifications` returns:

| Field | Type | Verdict |
|---|---|---|
| `notifications[].uri`, `.cid` | string | **confirmed** — the item's platform identifier; `cid` is what a reply's strong ref needs |
| `.reason` | `'reply' \| 'mention' \| 'quote' \| 'like' \| 'repost' \| 'follow' \| …` | **confirmed** — `reply` and `mention` are in scope; the rest are not read |
| `.reasonSubject` | `string?` | **confirmed** — the subject the notification is about |
| `.record` | `{ [k: string]: unknown }` | **confirmed** as untyped at the generated-code layer; the known shape for a post reply comes from `app.bsky.feed.post`'s `Record` type (`node_modules/@atproto/api/dist/client/types/app/bsky/feed/post.d.ts`): `text`, `createdAt`, and `reply?: { root: StrongRef, parent: StrongRef }` where `StrongRef = { uri, cid }` (`.../com/atproto/repo/strongRef.d.ts`) |
| `.author` | `AppBskyActorDefs.ProfileView` | **confirmed** — `did` (stable), `handle`, `displayName?`, `avatar?` (`.../app/bsky/actor/defs.d.ts`) |
| `.indexedAt` | string | **confirmed** — when the AppView saw it |
| `.isRead` | boolean | **confirmed to exist; not used** — see decision below |
| `cursor` (top level) | `string?` | **confirmed** — pagination; `QueryParams` take `reasons[]`, `limit`, `cursor`. `seenAt` as a query param is documented "Deprecated: this parameter is unsupported and will cause an error" — never sent |

**Identity.** A Bluesky commenter carries a stable identifier (`did`), a
handle and usually a display name, all **confirmed** from the installed
types. This is the one surface in this entry where the identity question
(FR-001's equivalent) is already settled — no human task needed.

**Decision: Docket never calls `app.bsky.notification.updateSeen`.** Marking
notifications read on the platform is a visible side effect on the brand's
own account, from software run for a different purpose. Docket keeps its own
cursor and its own read state. (`updateSeen.d.ts` confirms the call takes
only `{ seenAt: string }` and nothing else — no partial or scoped variant
exists to reduce the side effect.)

**Replying.** A reply is an `app.bsky.feed.post` created with
`com.atproto.repo.createRecord`, `reply: { root: StrongRef, parent: StrongRef }`.
The parent is the inbound item itself (`notification.uri` + `.cid`); the root
is `record.reply.root` when present, otherwise the item itself — both values
come from the notification payload, so no extra call is needed to address the
reply. **Confirmed** from `post.d.ts` and `strongRef.d.ts`.

**Limits.** 300 graphemes / 3,000 UTF-8 bytes per post, both enforced; a
`createRecord` costs 3 points against 5,000/hour and 35,000/day per account,
shared with every other app writing to it — **confirmed**, `docs/research/bluesky.md`
(checked 2026-10-07).

**Read rate limits — unverified.** `docs/research/bluesky.md` documents write
points only and is silent on `listNotifications` read limits. The design
does not depend on a number: reads are bounded per account per run
(`ENGAGEMENT_READ_PAGES_PER_RUN`) and a 429 is handled by the existing
`rateLimitNotBefore` backoff.

**Deletion and edit signals — unverified.** How a deleted or edited reply
presents itself on a later `listNotifications` read (absence, a tombstone, or
a changed record) is not stated in the installed types and was not tried
live. The design treats absence from a re-read as no signal at all; Bluesky
items are never auto-withdrawn until this is confirmed.

## 2. Meta and Threads comment/reply/mention reading

Checked 2026-10-19, via `WebSearch` constrained to official Meta documentation
domains (`developers.facebook.com`), plus `docs/research/meta.md`'s own
2026-10-14 "App Review is NOT needed for comment/reply scopes on your own
accounts" note, which read the Graph API access-levels page directly. Four
surfaces, answered separately — Threads replies and Threads mentions are two
different APIs with two different permissions, never merged. Evidence grade
follows `specs/084-meta-engagement-facts-and-scope-gate/contracts/research-section-2.md`
§3: `page` means the official page's own text was read; `search-summary`
means an official-domain search result quoted the fact verbatim.

### Facebook Page comments

| # | Question | Answer | Source | Checked | Evidence |
|---|---|---|---|---|---|
| 1 | Endpoint | `GET /{object-id}/comments` — "Most Graph API nodes have a /comments edge that lists all the comments on that object." | https://developers.facebook.com/docs/graph-api/reference/v2.2/object/comments | 2026-10-19 | search-summary |
| 2 | Permission, and is it inside reach of a self-hosted install? | `pages_read_engagement` **and `pages_read_user_content`**. The second is the one that permits reading *user-generated* content — the comments other people leave; a commenter's comment is user-generated content by definition. Both **Standard Access** — "Business, Consumer, and Gaming apps are automatically approved for Standard Access for all permissions and features available to their app type," usable without App Review against accounts whose owner holds a role on the app. | https://developers.facebook.com/documentation/development/permissions (pages_read_user_content) · https://developers.facebook.com/docs/graph-api/overview/access-levels (quoted directly in `docs/research/meta.md`, checked 2026-10-14) | 2026-10-14 (meta.md) / 2026-10-19 (this cross-check and the pages_read_user_content correction) | page |
| 3 | Commenter identity fields | **CONFIRMED.** `from`, "The person that made this comment", of type `User`; the `from` field "includes the `name` and `id` of the commenter" — `from{name,id}`. Access is conditional: "For any comments or replies owned by (on) a Page, you must use a Page access token if you want User information to be included in the response." Docket reads with the stored Page access token (`src/providers/meta/credentials.ts`, `readPageToken`), so the condition is met. **No handle field and no profile-link field is documented** on the Comment object. | https://developers.facebook.com/docs/graph-api/reference/comment | 2026-10-19 | search-summary |
| 4 | Identifier stable across two comments? | **Yes**, within one app and one Page — the scope Docket uses. Page-scoped: "The PSID will remain unique for the user-page combination irrespective of which app retrieves it," and PSIDs "will be returned for … `Comment/comments`, `PagePost/comments`." App-scoped (independently sufficient): "An App-Scoped User ID is unique to the app and cannot be used by other apps," and "If your app stores the IDs of people who do not use your app, such as the IDs of people who comment on your Page's posts, these IDs will change from their original ID to an app-scoped ID." Not promised stable across two *different* Pages, and the design does not need it to be. | https://developers.facebook.com/docs/pages/access-tokens/psid-api/faq · https://developers.facebook.com/documentation/facebook-login/guides/map-users and https://developers.facebook.com/docs/apps/faq | 2026-10-19 | search-summary |
| 5 | Reply at this access level? (recorded, not built — FR-015) | **unverified** — tried: searched for a reply-to-comment endpoint; found only `object/private_replies` (a different, DM-shaped feature), no comment-reply endpoint or permission confirmed. |  |  |  |
| 6 | Pagination | Cursor-based: `cursors.after` / `cursors.before`, the Graph API's general paging shape, confirmed to apply to the `/comments` edge. | https://developers.facebook.com/docs/graph-api/reference/v2.2/object/comments?locale=en_GB | 2026-10-19 | search-summary |
| 7 | Read rate limits | No comment-specific limit found; the general app-level BUC limit applies to every call: "Calls within one hour = 200 * Number of Users," reported via the `X-App-Usage` header. | https://developers.facebook.com/docs/graph-api/overview/rate-limiting/ | 2026-10-19 | search-summary |
| 8 | Deleted/edited presentation | Deletion: **absence is not a signal.** The comments-edge reference states `total_count` "can be greater than or equal to the actual number of comments returned due to comment privacy or deletion" — the document itself makes absence ambiguous between a privacy setting and a deletion. Edits: still **unverified** — no `edited_time`, revision count or equivalent field appears in the documented field list. | https://developers.facebook.com/docs/graph-api/reference/v2.4/object/comments | 2026-10-19 | search-summary |
| 9 | Per-account or per-post listable? | Per-post only — the `/comments` edge hangs off one object id; no Page-level "all comments" endpoint was found. | same as Q1 | 2026-10-19 | search-summary |
| 10 | How does an installation list the brand's own recent posts on this surface — which edge, what identifier shape does it return, and what is its pagination shape? | `GET /{page-id}/posts` — "shows only the posts that were published by this page." **Not** `/feed`, which also returns posts others published on the Page. Returns `{page-id}_{post-id}` ids — the same shape Docket's publish path records (`src/providers/facebook/publish.ts`, prefers `post_id`) and the same shape `src/providers/facebook/insights.ts` already calls the only one the insights edge answers for. General Graph cursor paging. | https://developers.facebook.com/docs/pages-api/ and https://developers.facebook.com/docs/graph-api/reference/page/feed/ | 2026-10-19 | search-summary |

Field expansion with `.limit()` and per-edge nested paging cursors — "Field expansion allows you to
not only perform nested queries, but also limit results by adding a `.limit()` argument to any field
or edge," and "nested fields will include their own paging cursors in the response." This is the
reason one Graph call reads five of the brand's own posts *with* their comments instead of six calls
reading them separately: `GET /{id}/posts?fields=id,created_time,comments.limit(10){id,message,created_time,from}&limit=5`.
Source: https://developers.facebook.com/docs/graph-api/using-graph-api · checked 2026-10-19 · search-summary.

**Consequence:** **readable.**

| Surface | Comments endpoint | Permission | Own-posts listing (Q10) | Identity shape (Q3) | **Ships** |
|---|---|---|---|---|---|
| Facebook Page comments | ✅ `/{post-id}/comments` (Q1) | ✅ (Q2) + see note above | ✅ `/{page-id}/posts` | ✅ `from{name,id}` | **readable** |
| Instagram comments | ✅ `/{ig-media-id}/comments` (Q1) | ✅ (Q2) | ✅ `/{ig-user-id}/media` | ✅ `username` | **readable** |

The `unavailable` path is still built and still tested (US6, FR-039) — the surfaces are decided
independently, so if a reviewer rejects a `search-summary` grade above, that surface flips to
`unavailable` by editing one object literal and nothing else. `ENGAGEMENT_SCOPES_DECLARED` gains
`pages_read_user_content` alongside `pages_read_engagement`; every Facebook Page connected before
this entry lacks the new scope and is skipped by the claim as missing a declared read scope until
its owner opts in with `META_ENGAGEMENT_SCOPES=true` and reconnects (084's permission gate, US6
scenario 3). `src/providers/meta/connect-group.ts`'s `ENGAGEMENT_SCOPES_DECLARED` is the only other
file this entry's facts touch outside the reader code itself.

### Instagram comments

| # | Question | Answer | Source | Checked | Evidence |
|---|---|---|---|---|---|
| 1 | Endpoint | `GET /{ig-media-id}/comments` returns top-level IG Comments on an IG Media object. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/comments/ | 2026-10-19 | search-summary |
| 2 | Permission, and is it inside reach of a self-hosted install? | Depends on login flow: Instagram API with Instagram Login needs `instagram_business_basic` + `instagram_business_manage_comments`; Instagram API with Facebook Login needs `instagram_basic` + `instagram_manage_comments` + `pages_read_engagement`. Both are **Standard Access**, same general rule as above — confirmed, `docs/research/meta.md` names `instagram_manage_comments` explicitly as usable without App Review. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/comments/ and the access-levels page (meta.md, 2026-10-14) | 2026-10-14 (meta.md) / 2026-10-19 | page |
| 3 | Commenter identity fields | **CONFIRMED, and narrower.** The returnable fields are `hidden`, `id`, `like_count`, `media`, `replies`, `text`, `timestamp`, `user` and `username`. `user` "is only returned if the user making the query also owns the comment, otherwise, the username field will be included" — stated the other way round on the comments edge: "the `user` and `biography` fields will not be included in responses unless the User making the request owns the Comment; instead, we will return `username` for all commenters." For a comment left by somebody else — every comment that becomes an inbox item — Instagram supplies `username` and **no identifier at all**. No display name, no identifier and no profile link for someone else's comment. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/comments/ and https://developers.facebook.com/docs/instagram-api/reference/comment/ | 2026-10-19 | search-summary |
| 4 | Identifier stable across two comments? | **No identifier is returned at all** for a comment Docket does not own, so there is nothing to be stable. A username is not an identity. | same as Q3 | 2026-10-19 | search-summary |
| 5 | Reply at this access level? (recorded, not built — FR-015) | **unverified** — tried: found the hide/unhide endpoint (`POST /{ig-comment-id}?hide={hide}`, needs `instagram_basic` + `instagram_manage_comments` + `manage_pages`/`pages_show_list`) but no reply-to-comment endpoint or permission quoted. |  |  |  |
| 6 | Pagination | The endpoint "returns only top-level comments, with replies to comments not included unless you use field expansion to request the replies field" — general Graph API cursor paging applies. | same as Q1 | 2026-10-19 | search-summary |
| 7 | Read rate limits | Same general app-level BUC limit as Facebook Page comments — no Instagram-comment-specific number found. | https://developers.facebook.com/docs/graph-api/overview/rate-limiting/ | 2026-10-19 | search-summary |
| 8 | Deleted/edited presentation | Deletion: absence is not a signal, same reasoning as Facebook Page comments. Edits: still **unverified**. The existing `hidden` field note stays — "comments made by media object owners on their own media objects will always be displayed, even if hide=true" is a moderation flag the media owner sets, not an upstream signal. | https://developers.facebook.com/docs/instagram-api/reference/comment/ | 2026-10-19 | search-summary |
| 9 | Per-account or per-post listable? | Per-post only — the `/comments` edge hangs off one `ig-media-id`; no account-level "all comments" endpoint was found. | same as Q1 | 2026-10-19 | search-summary |
| 10 | How does an installation list the brand's own recent posts on this surface — which edge, what identifier shape does it return, and what is its pagination shape? | `GET /{ig-user-id}/media` — "gets all IG Media on an IG User." Returns `ig-media-id`s, which is what `/{ig-media-id}/comments` takes and exactly what `media_publish` returns and `post_targets.external_id` holds (`src/providers/instagram/publish.ts:320`). General Graph cursor paging, plus documented `since`/`until` time-based pagination. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/ | 2026-10-19 | search-summary |

Field expansion applies here too, already half-recorded above in Q6 ("not included unless you use
field expansion to request the `replies` field") — see the Facebook Page comments section above for
the fact in its own right, with its own source.

**Consequence:** **readable.** Instagram's identity row is genuinely different from Facebook's — one
has an identifier and the other does not — reasoned independently, per the FR-006 table under
Facebook Page comments above. The `unavailable` path is still built and still tested (US6, FR-039).
`ENGAGEMENT_SCOPES_DECLARED` may list the confirmed Instagram scope(s).

### What the implementation (085) learned beyond what §2 gave — recorded as assumption, not fact (FR-048)

Three were anticipated by planning; none of the three, and nothing met while writing the reader
beyond them, needed a fourth. Each is an assumption the design works around, not a gap that blocks
either surface's `readable` verdict.

1. **Default ordering of both own-posts listings, and of Instagram's comments edge, is undocumented.**
   Neither `/{page-id}/posts`, `/{ig-user-id}/media` nor `/{ig-media-id}/comments`'s reference page
   states an ordering guarantee. `src/providers/meta/engagement-sweep.ts` is built not to depend on
   one — the fresh step filters each comment by its own `saidAt` against `freshSince` rather than by
   position in the response, and the catch-up step advances by the response's own cursor rather than
   by an assumed newest-first or oldest-first order. The mocked tests (`engagement-sweep.test.ts`)
   fix an order for determinism, but that order is the test's choice, not a platform promise.
2. **Instagram's `user`-returned-only-when-owned rule is the self-comment discriminator, and the word
   "owns" is ambiguous** between owning the comment (left it) and owning the media (posted it) — the
   two quoted phrasings on the comments-edge reference ("the user making the query also owns the
   comment") and the comment-object reference ("unless the User making the request owns the Comment")
   do not resolve which. `instagramEngagement`'s `isSelf` does not rely on resolving it: the primary
   check is a `username` match against the cached `selfUsername` from `prefetchSelf`, with a matching
   `user.id` as a secondary signal only when `user` happens to be present. Neither surface's design
   depends on "owns" meaning one thing rather than the other.
3. **Nested paging cursors inside a field-expanded `comments` block are documented in general terms
   ("nested fields will include their own paging cursors in the response"), not for the `/comments`
   edge specifically.** The drain step exists partly because of this: if a busy post's inline
   `comments.paging.cursors.after` is absent where the design expects one, the post is simply not
   queued into `pending` and its remaining comments wait for the catch-up to reach that post instead —
   a missing cursor degrades to "read it again later," never to a crash or a silently dropped comment.

### Threads replies

| # | Question | Answer | Source | Checked | Evidence |
|---|---|---|---|---|---|
| 1 | Endpoint | **unverified** — tried: searched for a GET replies-listing endpoint; found only the publish-side `threads_publishing_limit` endpoint (`GET /{threads-user-id}/threads_publishing_limit`) and a general "Mentions"/"Posts" doc-section list, no reply-read endpoint path quoted. |  |  |  |
| 2 | Permission, and is it inside reach of a self-hosted install? | `threads_manage_replies` (manage), `threads_read_replies` (optional feature) are named for the "Access the Threads API" use case; `docs/research/meta.md` (2026-10-14) separately confirms `threads_manage_replies` is **Standard Access**, no App Review, usable against a Threads Tester account. | https://developers.facebook.com/documentation/threads/overview, https://developers.facebook.com/docs/permissions, meta.md 2026-10-14 | 2026-10-14 (meta.md) / 2026-10-19 | page |
| 3 | Commenter (replier) identity fields | **unverified** — tried: no reply object field list was quoted back by any search. |  |  |  |
| 4 | Identifier stable across two replies? | **unverified** — same reason as Q3. |  |  |  |
| 5 | Reply at this access level? (recorded, not built — FR-015) | Replying itself is confirmed to exist ("create a reply on behalf of a Threads profile" via `threads_content_publish` + `threads_manage_replies`), but this entry builds no reply-sending — recorded only. | https://developers.facebook.com/documentation/threads/overview | 2026-10-19 | search-summary |
| 6 | Pagination | **unverified** — tried: searched for the replies-listing endpoint's cursor shape; none quoted. |  |  |  |
| 7 | Read rate limits | **unverified** for reads. A *publish* limit was found ("Threads profiles are limited to 1,000 replies within a 24-hour moving period") but nothing confirms it applies to reading replies, and it is a different limit from the one this question asks about. |  |  |  |
| 8 | Deleted/edited presentation | **unverified** — tried: found "hide or unhide replies to a thread" (a moderation action Docket's own account takes) but no field describing an upstream delete/edit presentation. |  |  |  |
| 9 | Per-account or per-post listable? | **unverified** — tried: no endpoint confirmed under Q1, so no listing shape to check. |  |  |  |

**Consequence:** must ship declared-but-`unavailable`. The permission name
and its access level are confirmed, but the endpoint itself is not — the
contract's "endpoint is unconfirmed" reason. `ENGAGEMENT_SCOPES_DECLARED` may
list `threads_manage_replies`; no code reads or displays a Threads replier
identity in this entry.

**Re-checked 2026-10-19 (086).** Official Meta documentation was searched again for this surface's
read endpoint path, object field list and pagination shape. Results named the capability and the
permission and quoted neither a path, a field list nor a cursor shape. The verdict is unchanged.
Also found and **rejected**: Keyword Search returns reply-shaped fields and a
`threads_keyword_search` permission that can sort a user's own mentioned threads — a different
endpoint with a different permission, so its shape is not evidence for this surface's
(constitution I).

**Still missing, and all that is missing — confirming these three unblocks a reader:**
1. the read endpoint path (and whether it hangs off the account or off a post);
2. the returned object's field list, including every author identity field the inbox would show
   and whether its identifier is stable across two items;
3. the pagination shape — the cursor parameter, the cursor's own field, and how exhaustion is
   signalled.

Confirmed and **not** missing: the permission name and that it sits inside the access level a
self-hosted install can hold.

### Threads mentions

Threads mentions is a separate surface from Threads replies — a different
permission, a different API shape, answered independently (contract §1).

| # | Question | Answer | Source | Checked | Evidence |
|---|---|---|---|---|---|
| 1 | Endpoint | **unverified** — tried four separate searches for a mentions-listing endpoint path; none returned a quoted path. |  |  |  |
| 2 | Permission, and is it inside reach of a self-hosted install? | `threads_manage_mentions` — "allows an app to fetch content where the user is mentioned in on behalf of a Threads user." Access level not separately confirmed for this specific permission, but the general rule ("Business, Consumer, and Gaming apps are automatically approved for Standard Access for all permissions and features available to their app type") is confirmed to apply to every Meta permission, not just the ones already named. | https://developers.facebook.com/documentation/threads/overview; general rule via https://developers.facebook.com/docs/graph-api/overview/access-levels | 2026-10-19 | search-summary |
| 3 | Mentioner identity fields | **unverified** — tried: no mention object field list was quoted back by any search. |  |  |  |
| 4 | Identifier stable across two mentions? | **unverified** — same reason as Q3. |  |  |  |
| 5 | Reply at this access level? (recorded, not built — FR-015) | **unverified** — tried: not confirmed whether replying to a mention uses the reply endpoint/permission above or a separate one. |  |  |  |
| 6 | Pagination | **unverified** — same reason as Q1. |  |  |  |
| 7 | Read rate limits | **unverified** — no mentions-specific limit found; not assumed to share the replies publish limit above without confirmation. |  |  |  |
| 8 | Deleted/edited presentation | **unverified** — tried: searched the Threads mention object reference for a deletion or edit indicator (an `is_deleted`, `edited_time` or status-style field); no field list for the mention object was quoted back by any search, so nothing confirms how a removed or edited mention presents on a later read. |  |  |  |
| 9 | Per-account or per-post listable? | **unverified** — same reason as Q1: no mentions-listing endpoint was confirmed, so there is nothing to classify as per-account or per-post. |  |  |  |

**Consequence:** must ship declared-but-`unavailable`. Only the permission
name is confirmed; the endpoint and identity shape are not. `ENGAGEMENT_SCOPES_DECLARED`
may list `threads_manage_mentions`; no code reads or displays a Threads
mention in this entry.

**Re-checked 2026-10-19 (086).** Official Meta documentation was searched again for this surface's
read endpoint path, object field list and pagination shape. Results named the capability and the
permission and quoted neither a path, a field list nor a cursor shape. The verdict is unchanged.
Also found and **rejected**: Keyword Search returns reply-shaped fields and a
`threads_keyword_search` permission that can sort a user's own mentioned threads — a different
endpoint with a different permission, so its shape is not evidence for this surface's
(constitution I).

**Still missing, and all that is missing — confirming these three unblocks a reader:**
1. the read endpoint path (and whether it hangs off the account or off a post);
2. the returned object's field list, including every author identity field the inbox would show
   and whether its identifier is stable across two items;
3. the pagination shape — the cursor parameter, the cursor's own field, and how exhaustion is
   signalled.

Confirmed and **not** missing: the permission name and that it sits inside the access level a
self-hosted install can hold.

**Code impact.** The confirmed cells above (permission names and access
levels for all four surfaces) are the only facts this entry's code may use —
in `src/providers/meta/connect-group.ts` and
`src/providers/threads/connect-group.ts`, and nowhere else, since no reader
exists yet for any of the four surfaces.

**Blocked, not skipped.** Building real reading for any of the four surfaces
is blocked on confirming each surface's endpoint and commenter/replier
identity shape — most of which documentation alone did not settle. The
Phase 9 human task below records which of those gaps need a live session and
which this pass settled. Every identity field any future Meta or Threads
surface displays (display name, handle, identifier, profile link, and
whether the identifier is stable across two items) must trace to a confirmed
verdict, not to this section's `unverified` rows (FR-005, FR-010, FR-055).

## 3. Direct messages — unverified, every platform in scope

No platform's DM facts exist anywhere in this repo: `docs/research/bluesky.md`
and `docs/research/meta.md` cover posting only, and no DM-specific research
document exists. Tried: searched both files and the Graph API changelog
listing for a messaging endpoint or permission; found none recorded. Meta
messaging permissions are outside the Standard Access set this entry assumes
(unconfirmed — not tried live). US5 stays specified and unbuilt; no DM
reading, drafting or sending is implemented anywhere in this entry.

Phase 7 (`specs/077-engagement-inbox/tasks.md`) built only the seam: `direct_message`
is modelled as a declared inbound kind and shown as Private wherever it appears
(inbox list, item view, review row), exercised through the mock provider alone.
Every platform above remains blocked for DMs until one of them commits a DM
research section here with a confirmed verdict (constitution I); building real
reading, drafting or sending for any platform is out of scope until then.

## Phase 9 human task (T083, T084) — unachievable by the implement pipeline, and what §2 settled instead

This documentation pass (specs/084, 2026-10-19) settled, by reading official
Meta documentation through `WebSearch` rather than by running anything live:

- the read endpoint for Facebook Page comments and Instagram comments (both
  `page`/`search-summary` evidence);
- the permission name and its access level (Standard Access, no App Review)
  for all four surfaces — Facebook Page comments, Instagram comments, Threads
  replies, Threads mentions;
- Instagram comments' pagination shape (top-level only, `replies` field
  expansion for nested replies) and its `hidden` moderation flag;
- that the two Threads surfaces are genuinely independent APIs with
  independent permissions (`threads_manage_replies`/`threads_read_replies`
  for replies, `threads_manage_mentions` for mentions), never to be merged.

What this pass could **not** settle, because no official page it reached
stated the answer (not because nobody looked — see each surface's table in
§2 above for exactly what was tried):

- commenter/replier/mentioner identity fields, for the two Threads surfaces —
  the blocker for their "buildable" verdict. Facebook Page comments and
  Instagram comments were settled by `085-facebook-instagram-comments-reader`
  (2026-10-19): see their §2 tables above;
- whether a commenter's identifier is stable across two items by the same
  person, for the two Threads surfaces (depends on the identity shape above).
  Facebook and Instagram were settled by the same 085 pass;
- the Threads replies and Threads mentions read endpoints themselves, their
  pagination, and their deleted/edited presentation;
- read rate limits specific to any of the four surfaces (only the general
  app-level BUC limit and Threads' unrelated *publish* limit were found).

These genuinely need a live session, a second person to comment or mention,
and a browser to observe real responses — T083 and T084 need a live Meta
Business app, a real Facebook Page, a real Instagram Business account, a
real Threads account, and a browser session to read a comment, reply or
mention back through each platform's API. The implement pipeline runs
headless, with no browser, no live Meta app credentials and no second person
to act as commenter — none of the resources T083 names are available to it.
Per `tasks.md`'s own instruction for this task ("if the window to run this
closes before anyone does, mark this task ... as unachievable and state why,
rather than leaving it silently open"), T083 is recorded here as
unachievable by this pipeline run. T084 depends on T083 and is unachievable
for the same reason until a person with those resources runs T083 live and
records confirmed verdicts above.

This does not block anything already built: Phases 1–8 and the §2 tables
above already treat the still-open questions as `unverified` and gate US3's
real Meta/Threads surfaces on this task, exactly as the spec requires.
