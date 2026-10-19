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
follows [contracts/research-section-2.md](../../specs/084-meta-engagement-facts-and-scope-gate/contracts/research-section-2.md)
§3: `page` means the official page's own text was read; `search-summary`
means an official-domain search result quoted the fact verbatim.

### Facebook Page comments

| # | Question | Answer | Source | Checked | Evidence |
|---|---|---|---|---|---|
| 1 | Endpoint | `GET /{object-id}/comments` — "Most Graph API nodes have a /comments edge that lists all the comments on that object." | https://developers.facebook.com/docs/graph-api/reference/v2.2/object/comments | 2026-10-19 | search-summary |
| 2 | Permission, and is it inside reach of a self-hosted install? | `pages_read_engagement`. **Standard Access** — "Business, Consumer, and Gaming apps are automatically approved for Standard Access for all permissions and features available to their app type," usable without App Review against accounts whose owner holds a role on the app. | https://developers.facebook.com/docs/graph-api/overview/access-levels (quoted directly in `docs/research/meta.md`, checked 2026-10-14) | 2026-10-14 (meta.md) / 2026-10-19 (this cross-check) | page |
| 3 | Commenter identity fields | **unverified** — tried: searched the Comment object reference; the returned summary names `id`, `message`, `created_time`, `comment_count` and the `/comments` sub-edge, but does not quote a `from` field or any other identity field. No identity shape confirmed. |  |  |  |
| 4 | Identifier stable across two comments? | **unverified** — tried: cannot be answered without Q3's identifier shape first. |  |  |  |
| 5 | Reply at this access level? (recorded, not built — FR-015) | **unverified** — tried: searched for a reply-to-comment endpoint; found only `object/private_replies` (a different, DM-shaped feature), no comment-reply endpoint or permission confirmed. |  |  |  |
| 6 | Pagination | Cursor-based: `cursors.after` / `cursors.before`, the Graph API's general paging shape, confirmed to apply to the `/comments` edge. | https://developers.facebook.com/docs/graph-api/reference/v2.2/object/comments?locale=en_GB | 2026-10-19 | search-summary |
| 7 | Read rate limits | No comment-specific limit found; the general app-level BUC limit applies to every call: "Calls within one hour = 200 * Number of Users," reported via the `X-App-Usage` header. | https://developers.facebook.com/docs/graph-api/overview/rate-limiting/ | 2026-10-19 | search-summary |
| 8 | Deleted/edited presentation | **unverified** — tried: searched the Comment object reference for a tombstone, deletion flag or edit timestamp; none was quoted back (a `hidden` moderation flag was found, but only on the Instagram Comment object, not confirmed here). |  |  |  |
| 9 | Per-account or per-post listable? | Per-post only — the `/comments` edge hangs off one object id; no Page-level "all comments" endpoint was found. | same as Q1 | 2026-10-19 | search-summary |

**Consequence:** must ship declared-but-`unavailable`. The permission and its
access level are confirmed buildable, but the identity shape (Q3) is not —
the second edge case the contract names. `ENGAGEMENT_SCOPES_DECLARED` may
still list `pages_read_engagement` (US5's opt-in widening does not require
the surface to be readable yet); no code reads or displays a Facebook Page
commenter identity in this entry.

### Instagram comments

| # | Question | Answer | Source | Checked | Evidence |
|---|---|---|---|---|---|
| 1 | Endpoint | `GET /{ig-media-id}/comments` returns top-level IG Comments on an IG Media object. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/comments/ | 2026-10-19 | search-summary |
| 2 | Permission, and is it inside reach of a self-hosted install? | Depends on login flow: Instagram API with Instagram Login needs `instagram_business_basic` + `instagram_business_manage_comments`; Instagram API with Facebook Login needs `instagram_basic` + `instagram_manage_comments` + `pages_read_engagement`. Both are **Standard Access**, same general rule as above — confirmed, `docs/research/meta.md` names `instagram_manage_comments` explicitly as usable without App Review. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/comments/ and the access-levels page (meta.md, 2026-10-14) | 2026-10-14 (meta.md) / 2026-10-19 | page |
| 3 | Commenter identity fields | **unverified** — tried: searched the IG Comment reference; only the `hidden` returnable field was quoted back, no `from`/username/identifier field. |  |  |  |
| 4 | Identifier stable across two comments? | **unverified** — same reason as Q3. |  |  |  |
| 5 | Reply at this access level? (recorded, not built — FR-015) | **unverified** — tried: found the hide/unhide endpoint (`POST /{ig-comment-id}?hide={hide}`, needs `instagram_basic` + `instagram_manage_comments` + `manage_pages`/`pages_show_list`) but no reply-to-comment endpoint or permission quoted. |  |  |  |
| 6 | Pagination | The endpoint "returns only top-level comments, with replies to comments not included unless you use field expansion to request the replies field" — general Graph API cursor paging applies. | same as Q1 | 2026-10-19 | search-summary |
| 7 | Read rate limits | Same general app-level BUC limit as Facebook Page comments — no Instagram-comment-specific number found. | https://developers.facebook.com/docs/graph-api/overview/rate-limiting/ | 2026-10-19 | search-summary |
| 8 | Deleted/edited presentation | A `hidden` field exists on the IG Comment object ("comments made by media object owners on their own media objects will always be displayed, even if hide=true") — but that is a moderation flag Docket's own account sets, not an upstream delete/edit signal. Deletion/edit presentation itself: **unverified**, not tried beyond this. | https://developers.facebook.com/docs/instagram-api/reference/comment/ | 2026-10-19 | search-summary |
| 9 | Per-account or per-post listable? | Per-post only — the `/comments` edge hangs off one `ig-media-id`; no account-level "all comments" endpoint was found. | same as Q1 | 2026-10-19 | search-summary |

**Consequence:** must ship declared-but-`unavailable`, same reason as
Facebook Page comments — endpoint, permission and pagination are buildable,
identity is not. `ENGAGEMENT_SCOPES_DECLARED` may list the confirmed
Instagram scope(s); no code reads or displays an Instagram commenter
identity in this entry.

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
| 8 | Deleted/edited presentation | **unverified** — no field found. |  |  |  |
| 9 | Per-account or per-post listable? | **unverified** — no endpoint confirmed under Q1. |  |  |  |

**Consequence:** must ship declared-but-`unavailable`. Only the permission
name is confirmed; the endpoint and identity shape are not. `ENGAGEMENT_SCOPES_DECLARED`
may list `threads_manage_mentions`; no code reads or displays a Threads
mention in this entry.

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

- commenter/replier/mentioner identity fields, for all four surfaces — the
  blocker for every "buildable" verdict;
- whether a commenter's identifier is stable across two items by the same
  person, for all four surfaces (depends on the identity shape above);
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
