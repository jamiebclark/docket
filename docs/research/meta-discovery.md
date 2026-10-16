# Meta/Threads topic discovery — verified facts

Checked 2026-10-16 against developers.facebook.com (Graph API / Instagram
Platform / Threads docs, current as of **Graph API v26.0** per
`docs/research/meta.md`). Scope: can Docket build a **topic discovery
queue** — poll hashtags/keywords on a schedule, fetch *other people's*
public posts, and surface them for a brand owner to review and engage with
manually — on Facebook, Instagram, or Threads. This file does not touch
Bluesky (see `docs/research/bluesky-discovery.md`, owned separately) and
does not modify `docs/research/meta.md`. Method caveat, same as `meta.md`
and `pinterest.md`: several pages were read through a summarising fetch
tool, so quotes below are as reported by that tool; re-read the live page
before encoding a number as a hard constant. Items marked **UNVERIFIED**
could not be confirmed on an official page.

## Instagram

### 1. Does IG Hashtag Search still exist, and where do its docs live now
**Yes, it is current** — but its documentation lives under the
`instagram-platform` path, not the legacy `instagram-api` path. Every URL
of the form `developers.facebook.com/docs/instagram-api/...` (the shape
surfaced by search engines, including `/docs/instagram-api/hashtag-search`,
`/docs/instagram-api/reference/hashtag/recent-media`,
`/docs/instagram-api/reference/hashtag/top-media`) returned **HTTP 404**
when fetched directly on 2026-10-16. The same content is live at the
`instagram-platform` paths below. Treat any `instagram-api/...` URL as
stale; do not cite it as a current source even though search results still
index it.

- Resolve hashtag name → ID: `GET /ig_hashtag_search?user_id={ig-user-id}&q={hashtag-name}` →
  returns `{ "data": [ { "id": "<IG_HASHTAG_ID>" } ] }`.
  Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag-search
- Recent media: `GET /{ig-hashtag-id}/recent_media?user_id={ig-user-id}&fields=...`.
  Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag/recent-media
- Top media: `GET /{ig-hashtag-id}/top_media?user_id={ig-user-id}&fields=...`.
  Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag/top-media
- IG Hashtag object itself: `GET /{ig-hashtag-id}` → fields `id`, `name`
  (name without the leading `#`). No create/update/delete.
  Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag

### 2. Permissions / App Review
- Permission string: **`instagram_basic`**, plus — if the querying user's
  Page role came through Business Manager — one of `ads_management`,
  `business_management`, or `pages_read_engagement`.
  Source (both the hashtag-search and the hashtag-object reference pages,
  text matches): as above.
- Gating **feature**, separate from the permission strings: **"Instagram
  Public Content Access."** "The Instagram Public Content Access feature
  allows your app to access Instagram Graph API's Hashtag Search
  endpoints." Allowed usages, quoted verbatim: "to discover content
  associated with your hashtag campaigns, understand public sentiment
  around your brand or identify contest, competition and sweepstakes
  entrants. It can also be used to provide customer support and better
  understand and manage your audience." No "disallowed usages" list was
  found on the overview page.
  Source: https://developers.facebook.com/docs/instagram-platform/overview
- Docket's proposed use case (poll hashtags, surface other people's posts
  for a human to review and manually engage with) reads as a fit for
  "discover content associated with your hashtag campaigns" and "better
  understand and manage your audience" — there is no explicit carve-out
  excluding a review queue, but Meta does not enumerate use cases
  exhaustively either; this is our reading, not a quoted guarantee.
- Access level: **Advanced Access, via App Review + Business
  Verification.** Standard Access is "intended for apps used only by people
  with roles on them"; Advanced Access is "required if your app serves
  Instagram professional accounts that you don't own or manage" — hashtag
  search by definition returns content from accounts Docket's deployer does
  not own, so Advanced Access applies. App Review requires "a screencast
  walking through exactly how each permission is used," a privacy-policy
  URL, a terms-of-service URL, and a live test environment reviewers can
  log into.
  Source: https://developers.facebook.com/docs/instagram-platform/overview
  (access-levels framing cross-checked against the same Standard/Advanced
  split used elsewhere in `meta.md`'s "Self-hoster setup verification"
  section). This is a materially heavier lift than anything else Docket
  does today: publishing itself stays on Standard Access for role users
  (see `meta.md` item 1); hashtag search for other people's content does
  not — every self-hosted Docket deployer who wants this feature would need
  to pass Meta App Review and Business Verification, not just add role
  users.
- Confirmed: an Instagram Business or Creator account linked to a Facebook
  Page is required — the `user_id` parameter on every hashtag endpoint is
  "the ID for the person querying the data," i.e. an IG professional
  account, and the feature is only reachable through Facebook Login for
  Business (next section), which itself requires a linked Page.

### 3. Which login flow
**Facebook Login for Business only — not the standalone "Instagram API
with Instagram Login" flow.** The Instagram Platform overview's
feature-support table marks Hashtag Search available under Facebook Login
and **not** under Instagram Login. Instagram Login's permission set is
`instagram_business_basic`, `instagram_business_content_publish`,
`instagram_business_manage_comments`, `instagram_business_manage_messages`
— no `instagram_basic`, no "Instagram Public Content Access" feature.
Instagram Login's supported features are comment moderation, content
publishing, insights, mentions, and messaging; hashtag search, product
tagging, and partnership ads are marked unavailable for it.
Source: https://developers.facebook.com/docs/instagram-platform/overview
(feature-comparison table) and
https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/overview
- Docket already chose Facebook Login for Business for publishing (see
  `meta.md`, "Login path — decision"), so no new auth *path* is needed —
  but the specific permission (`instagram_basic`) and feature (Instagram
  Public Content Access) are additive on top of what Docket's publishing
  flow requests today, and the Advanced Access / App Review bar is new.

### 4. Rate limits
Confirmed, precisely: **"You can query a maximum of 30 unique hashtags
within a 7 day period"** (IG Hashtag object reference) and, with the
distinct-but-related `recently_searched_hashtags` endpoint: **"IG Users can
query a maximum of 30 unique hashtags within a rolling, 7 day period."**
What happens at the limit — exact behaviour from the same page: **"A
queried hashtag will count against that user's limit as soon as it is
queried. Subsequent queries on that hashtag within 7 days of the initial
query will not count against the user's limit."** In other words the cap
is on *distinct hashtags queried*, not on *query volume* against an
already-queried hashtag — polling the same 10 hashtags every hour for a
week only ever costs 10 against the 30, but adding an 11th through 31st new
hashtag within that rolling week fails once the count is exhausted. The
reference pages do not state the HTTP status/error code returned once the
30-hashtag ceiling is hit; **UNVERIFIED** — treat it as a standard Graph
API error response and confirm against a live app before shipping.
Sources: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag
and https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/recently_searched_hashtags
- Separately, call-volume rate limiting: "Business Discovery and Hashtag
  Search API are subject to Platform Rate Limits" (not the Instagram BUC
  impressions-based limits that gate publishing/other IG endpoints — see
  `meta.md` "Rate limits, 2026-10-04" Q2). The Platform limit formula itself
  (`meta.md` Q3: `200 * Number of Users` per app per rolling hour for
  app-token calls; user-token calls pool against an undisclosed per-user
  hourly cap) is unchanged by this research; no hashtag-specific numeric
  override was found beyond the 30-hashtags/7-days cap above.
  Source: https://developers.facebook.com/docs/instagram-platform/overview

### 5. Fields on returned media, and the author question
Confirmed fields on `recent_media` / `top_media` results (identical
field list on both edges): **`caption`, `children`, `comments_count`,
`id`, `like_count`, `media_type`, `media_url`, `permalink`, `timestamp`** —
matches your expectation plus `children` (for carousels) and the two
engagement counts.
- **Confirmed: no author/username field.** The `recent_media` reference
  page states explicitly: **"You cannot request the `username` field on
  returned media objects."** There is no `owner`/`user` object in the field
  list either. This means a hashtag-search result gives you the post's
  content and a `permalink` (which, followed in a browser, reveals the
  author) but **no machine-readable author identity** — Docket would have
  to either scrape the permalink (out of scope, against ToS) or present the
  permalink to the human reviewer and let them see the author when they
  click through. This is the single biggest structural limitation for a
  "who posted this" discovery queue.
  Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag/recent-media

### 6. How far back, and pagination
- **`recent_media` only returns media published within 24 hours of query
  execution.** Quoted verbatim from the reference page: "Only returns media
  objects published within 24 hours of query execution." This means a
  nightly or even twice-daily poll will miss posts; the practical floor for
  not dropping results is polling more often than every 24 hours per
  hashtag.
  Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag/recent-media
- `top_media` has no documented 24-hour window — it returns the hashtag's
  currently most-popular media regardless of age, so it's a different
  (and less useful for "recently posted, let me review it quickly")
  shape than `recent_media`.
  Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag/top-media
- Pagination: **maximum `limit` of 50 results per page**; **only an
  `after` cursor is returned — no `before` cursor** ("This endpoint only
  returns an `after` cursor for paginated results; a `before` cursor will
  not be included"). Both edges behave the same way.
  Sources: both reference pages above.

### Verdict component — Instagram hashtag search is usable but narrow
It is **not dead** (it is current, documented, reachable), but it is a poor
fit for a general-purpose discovery queue as originally imagined:
- `recent_media`'s 24-hour window forces frequent polling (and burns the
  30-hashtags/7-days budget faster if hashtags rotate).
- No author field at all — every result needs a human to open the
  permalink before they know who to engage with, which is tolerable for a
  manual-review queue (the stated goal) but rules out any automation on top
  of it (e.g. "notify this account's manager" can't be keyed off anything
  the API returns).
- The feature needs Advanced Access + App Review + Business Verification —
  a real, non-trivial gate for every self-hosted Docket deployer who wants
  it, unlike publishing (Standard Access suffices today per `meta.md`).

## Facebook

### 7. Is any keyword/hashtag discovery of public Facebook posts supported
**No — confirmed dead on all three fronts you named:**
- **`/search?type=post`**: there is no current, documented `post` type
  on the Graph API `/search` endpoint. Versioned reference pages for
  `/search` under the current API structure (e.g.
  `developers.facebook.com/docs/graph-api/reference/v19.0/search`) return
  **HTTP 404** as of 2026-10-16 — the endpoint's dedicated reference page no
  longer resolves at all, consistent with it having been pulled rather than
  merely restricted. Public-post keyword search was removed from the Graph
  API in **2015** (the original semantic Graph Search feature was removed
  separately, 2019). **UNVERIFIED** as a single citable Meta source for
  the exact 2015 date — this is corroborated by multiple third-party
  developer write-ups, not an official Meta changelog entry; the
  stronger, directly-observed fact is the current 404 on the reference
  page itself, which stands on its own as evidence the endpoint is gone.
  Checked: attempted fetch of
  https://developers.facebook.com/docs/graph-api/reference/v19.0/search
  and https://developers.facebook.com/docs/graph-api/reference/search/,
  both 404.
- **CrowdTangle**: confirmed shut down. Meta's own Transparency Center
  page states: **"CrowdTangle is no longer available"** as of **August 14,
  2024**, replaced by "Meta Content Library and Content Library API,
  [which] provide useful, high-quality data to researchers."
  Source: https://transparency.meta.com/researchtools/other-data-catalogue/crowdtangle/
  (Meta's own site, not a third party — acceptable per this file's source
  rules since it's an official Meta transparency property, distinct from
  developer-facing API docs.)
- **Meta Content Library and API**: exists, but is **research-only and
  explicitly excludes commercial brands.** Eligibility is restricted to
  (a) accredited, degree-granting, not-for-profit academic institutions, or
  (b) non-academic not-for-profit research organizations "whose primary
  purpose or core activity is to conduct scientific or public interest
  research." The eligibility page explicitly excludes "a business whose
  sole purpose is to make a profit." Access additionally requires approval
  by a specific named intermediary — "the Inter-university Consortium for
  Political and Social Research (ICPSR) or the Secure Data Access Center
  (CASD)" — and goes through a four-step process (Research Tools Manager
  application → CASD review, 2-3 weeks → Meta review, 2-3 weeks → email
  approval). **A commercial brand like a Docket deployer is categorically
  ineligible** — this is not a slow or expensive path, it is a closed door.
  Sources: https://developers.facebook.com/docs/content-library-and-api/
  and https://developers.facebook.com/docs/content-library-and-api/get-access

### 8. What a Page owner *can* read about their own relevant content
With `pages_read_user_content` (per Page token):
- **`GET /{page-id}/tagged`** — "public posts in which the Page has been
  tagged." This surfaces other people's posts, but only when they
  explicitly tagged the brand's Page — not a keyword/hashtag match. The
  endpoint's own caveat: results "include posts from other Pages only if
  those Pages are authentic" (i.e. Meta filters for authenticity, not a
  documented technical detail Docket needs to replicate).
  Source: https://developers.facebook.com/docs/pages-api/overview and the
  Page `/tagged` edge documentation surfaced via search — **UNVERIFIED**
  against a direct live fetch of the dedicated reference page (search-tool
  summary only); re-confirm the exact permission string and response shape
  before building against it.
- `GET /{page-id}/feed` (already used by Docket for posting, per
  `meta.md`) also returns "visitors to this Page" and public tagged posts
  mixed in with the Page's own posts, per the Pages API overview's
  description of what `/feed` aggregates — this is a side effect of the
  feed's existing design, not a discovery feature, and is not filterable
  by keyword.
- Comments on the brand's own posts are already reachable via the
  `comments` edge (standard Graph API Page/post comments) — this is
  "engagement on content the brand already published," not discovery of
  other people's unrelated posts, and is out of scope for a hashtag-style
  discovery queue, but is the one legitimate "other people's content"
  surface Facebook still fully supports.
- **No hashtag-equivalent exists for Facebook at all.** Facebook posts
  (Page or personal) have never had a Graph-API-documented hashtag object
  or hashtag-search edge analogous to Instagram's `ig_hashtag_search`. This
  is a confirmed absence (no reference page for it exists under
  `developers.facebook.com/docs/graph-api/reference/` or
  `developers.facebook.com/docs/pages-api/`), not merely something not
  found by this research pass.

### Verdict component — Facebook discovery is fully dead for a commercial deployer
There is no supported way, at any access tier a Docket deployer could
plausibly reach, to poll Facebook for public posts by keyword or hashtag.
The only legitimate "other people's content" surface is `/tagged` (requires
the other person to tag the Page) and comments on the brand's own posts —
neither is a topic/keyword discovery queue.

## Threads

### 1. Keyword search endpoint — confirmed, current, and unlike Instagram's: it does carry the author
**`GET /keyword_search`** (host `graph.threads.net`, e.g.
`https://graph.threads.net/v1.0/keyword_search`). Added per Meta's own
Threads API changelog: **"Support for Keyword Search has been added"**
(December 9, 2024 entry).
Sources: https://developers.facebook.com/docs/threads/keyword-search/ and
https://developers.facebook.com/docs/threads/changelog#december-9--2024
- Parameters: required `q` (the keyword/phrase); optional `search_type`
  (`TOP` / `RECENT`), `search_mode` (`KEYWORD` / `TAG`), `media_type`
  (`TEXT` / `IMAGE` / `VIDEO`), `since`, `until` (Unix timestamps — see
  below), `limit` (max **100**), `author_username` (narrow to one author).
  Source: https://developers.facebook.com/docs/threads/keyword-search/
- Permission strings: **`threads_basic`** (required for all Threads API
  calls, per `meta.md`'s existing Threads section) plus
  **`threads_keyword_search`** specifically for this endpoint.
  Source: same page.

### 2. Does it return other people's public threads — the decisive question
**Yes, this is the key difference from Instagram's hashtag search: it is
built to surface other users' public posts, and does carry a `username`
field** — but only once the app has been granted the permission through
App Review:
- **Without `threads_keyword_search` approval (Standard Access): "the
  search will be performed only on posts owned by the authenticated
  user."** This matches the Instagram-style Standard/Advanced split —
  Docket cannot discover anyone else's content until approved.
  Source: https://developers.facebook.com/docs/threads/keyword-search/
- **With approval, "public posts will be searchable"** — i.e. other
  users' public Threads posts, which is exactly the discovery primitive
  Docket needs, and which Instagram's hashtag search (author-less) cannot
  provide.

### 3. Returned fields, including permalink and author username
Confirmed fields per result: **`id`, `text`, `media_type`, `permalink`,
`timestamp`, `username`, `has_replies`, `is_quote_post`, `is_reply`.**
**`username` is present** — a materially better discovery primitive than
Instagram's hashtag search, which explicitly withholds it. One caveat
found on the same page: **"The owner field is excluded and will not be
returned"** — so there's a `username` string but no `owner` object/numeric
ID; good enough to show a human "posted by @handle," not enough to make a
further authenticated API call about that specific account without an
extra lookup Docket doesn't otherwise need.
Source: https://developers.facebook.com/docs/threads/keyword-search/

### 4. Rate limits
**A user can send a maximum of 2,200 queries within a rolling 24-hour
period.** This is **per user, across apps** — quoted behaviour: "This limit
applies to a user across apps and is not differentiated for different
apps. If multiple apps send requests for the same user, those queries will
apply to the same limit for that user." A helpful carve-out: **"Queries
which return no results do not count against this limit."** This is a much
roomier budget than Instagram's 30-unique-hashtags-per-7-days cap, and it's
a volume cap (per call), not a distinct-keyword cap, so re-querying the
same keywords repeatedly throughout the day is the expected usage pattern,
not a workaround.
Source: https://developers.facebook.com/docs/threads/keyword-search/
This is a **separate quota from the rest of the Threads API** — the
publishing quota (`threads_publishing_limit`, 250 posts/24h — see
`meta.md`) and this 2,200-queries/24h figure are independent counters on
the same account.

### 5. App Review, app types, regions
**Requires App Review for Advanced Access** to search posts beyond the
authenticated user's own content; "Your app may need to go through
business verification and access verification as well" per community
reporting cross-checked against the documented Standard/Advanced pattern —
the specific sentence about business/access verification is **UNVERIFIED**
as an exact quote from an official page (it was only seen via a search
summary of a Threads post by a third-party developer, not fetched directly
off developers.facebook.com); the Standard-vs-Advanced access-level
mechanism itself, however, matches the same documented pattern Instagram
and the rest of the Graph API use (`meta.md`'s access-levels discussion),
so treat "App Review required for other-users'-content access" as
confirmed and the exact wording of any extra verification steps as
unconfirmed. No app-type or region restriction was found on the official
keyword-search page; **UNVERIFIED** as a negative (absence of a
restriction is not proof none exists).

### 6. Liking another user's thread — and what engagement *is* available
**No like/unlike endpoint exists.** The Threads troubleshooting page (which
documents the publishing-container status values and all four documented
quota types — publishing, replying, deleting, location search) contains no
mention of a like action at all, and no reference page for a
likes/reactions edge was found anywhere under `developers.facebook.com/docs/threads/`.
This is the same negative result as Instagram (below) and Facebook (per
`meta.md`'s existing deprecation note) — liking is not an API surface
anywhere in the Meta family today.
Source (absence): https://developers.facebook.com/docs/threads/troubleshooting
and the full Threads docs tree searched for this report; no likes
reference page exists.
- What **is** available for engagement: Threads supports creating **replies**
  (`reply_to_id` on the publish flow, per `meta.md`'s existing Threads
  publishing section — a reply is just a normal container/publish call
  with the parent set), **reposts**, and **quote posts** (the `is_quote_post`
  field on a fetched post confirms the object model supports it; creation
  of a quote post is documented as a container+publish flow, same two-step
  pattern as a normal post). **UNVERIFIED** against a direct fetch of the
  exact parameter name for repost/quote creation (`quote_post_id` or
  similar) — the publishing reference page for this was not re-fetched in
  this pass; confirm the exact field name before building a "repost this"
  button, but the capability itself (reply/repost/quote all exist, like
  does not) is solid.

### 7. How far back, and date filtering
`since`/`until` accept Unix timestamps, with a documented minimum: **the
`since` parameter must be ≥ `1688540400`** (2023-07-05 00:00:00 UTC) and
cannot exceed the current time. `1688540400` lines up with roughly when
Threads itself launched (July 2023), which reads as "you can filter back to
the beginning of Threads," a dramatically deeper reach than Instagram's
24-hour `recent_media` window.
Source: https://developers.facebook.com/docs/threads/keyword-search/
`search_type=RECENT` vs `TOP` controls ranking/recency bias within that
range (exact tie-breaking behaviour between the two modes was not detailed
on the fetched page — **UNVERIFIED**).

## Both platforms — liking/reacting (Q9, consolidated)
**Confirmed impossible on both, with sources, so this does not need
revisiting:**
- **Facebook**: `POST /{post-id}/reactions` and `POST /{page-post-id}/reactions`
  were deprecated for Graph/Marketing API v6.0+ and for **all versions as
  of May 5, 2020**. Reading reaction counts/breakdowns remains supported;
  creating one does not.
  Source: https://developers.facebook.com/docs/graph-api/changelog/2020-02-03-endpoint-deprecations
- **Instagram**: no likes edge exists on the IG Media object today. The
  object's documented edges are `children`, `collaborators`, `comments`,
  `insights` — no `likes`. The object exposes `like_count` /
  `total_like_count` as read-only fields, with no corresponding write
  mechanism anywhere in the reference.
  Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media
- **Threads**: see Threads §6 above — no likes reference page exists
  anywhere in the Threads docs tree.
This closes the question for all three Meta-family surfaces Docket touches.

## ToS / Platform Policy on polling + storing results (Q10)
- The general **Meta Platform Terms** govern retention of any "Platform
  Data" (which includes hashtag-search / keyword-search results, since
  they are data obtained via a Meta API): **delete "all Platform Data as
  soon as reasonably possible" once "a User requests their Platform Data
  be deleted or no longer has an account with you"** (Platform Terms
  §3.d.i.2.d, as summarised by the fetch tool), and more generally
  **delete "when retaining the Platform Data is no longer necessary for a
  legitimate business purpose that is consistent with these Terms"**
  (§3.d.i.2.a).
  Source: https://developers.facebook.com/terms
  No *numeric* retention ceiling (no "24 hours," no "90 days") was found on
  this page for third-party public content specifically — the historical
  "24-hour cache" rule some developers remember from older Instagram API
  generations was **not found restated on any current, live official
  page** reachable by this research; treat the old number as retired
  rather than current, and rely on the **purpose-based** rule above: a
  discovery queue should let a brand owner mark reviewed items and purge
  them promptly, and must honor the "delete on request / account removal"
  clause, rather than building an indefinite archive of other people's
  posts.
- The Instagram Public Content Access feature's "allowed usages" list
  (quoted in Instagram §2 above) functions as an additional, feature-specific
  usage restriction layered on top of the general Platform Terms — storing
  results **for the stated purposes** (brand monitoring / audience
  understanding) is consistent with the feature grant; repurposing stored
  hashtag-search data for something outside that list (e.g. reselling it,
  or building a general social-listening product unrelated to the owning
  brand) would not be.
- Developer Policies page (`developers.facebook.com/devpolicy/`) was
  checked directly and contains **no** caching/retention specifics for
  Instagram or Threads data; this confirms the Platform Terms page above is
  the right (and only) source for this question, not a gap in this
  research.
  Source checked (no relevant content found): https://developers.facebook.com/devpolicy/

## Verdict for Docket

**Instagram — buildable, but narrow and gated.** `ig_hashtag_search` →
`recent_media`/`top_media` works today under Facebook Login for Business
(the login path Docket already uses for publishing). It needs: the
`instagram_basic` permission, the "Instagram Public Content Access"
feature, and critically **Advanced Access via Meta App Review + Business
Verification** — a real approval gate every self-hosted deployer who wants
this would have to clear, unlike today's publishing flow which stays on
Standard Access for role users. Even once approved: results have **no
author field at all** (a human must open the `permalink` to see who
posted), `recent_media` only reaches back **24 hours** (forcing frequent
polling), and the hashtag budget is **30 unique hashtags per rolling 7
days** (a volume-of-distinct-topics cap, not a query-volume cap — polling
the same 30 repeatedly is free). Buildable as a genuinely manual-review
queue; not a foundation for any further automation keyed on "who posted
this."

**Facebook — not buildable, full stop.** `/search?type=post` is gone (the
reference page itself 404s), CrowdTangle is shut down (August 14, 2024,
confirmed on Meta's own Transparency Center), and the Meta Content Library
explicitly and categorically excludes commercial brands (academic/research
not-for-profits only, via ICPSR/CASD approval). The only "other people's
content" surface left is `/{page-id}/tagged` (requires the other party to
tag the brand's Page first) and comments on the brand's own posts — neither
is a keyword/hashtag discovery mechanism. Do not spend engineering time on
Facebook discovery; there is nothing to build.

**Threads — the best-supported of the three, and worth prioritizing if
this ships at all.** `GET /keyword_search` is current (added December
2024), explicitly designed to surface *other users'* public posts once
`threads_keyword_search` is granted, and — unlike Instagram — **returns a
`username` per result**, giving the human reviewer a real identity to act
on without following a permalink. Its date range reaches back to
Threads' 2023 launch (not a rolling 24-hour window), and its rate budget
(2,200 queries/24h, per user, across apps, with no-result queries free) is
far roomier than Instagram's 30-hashtags/7-days cap. The cost is the same
kind of gate as Instagram: Standard Access only searches the authenticated
user's own posts; reaching other users' content requires App Review for
`threads_keyword_search` (Advanced Access), reportedly with business/access
verification attached (exact wording unconfirmed, but the access-level
mechanism itself is certain). Docket already has a Threads provider and
app credentials (`src/providers/threads/`), so the auth plumbing is
closest to already existing here — the net-new work is requesting and
passing App Review for one additional permission, not building a new login
flow.

**Across all three: liking/reacting via API is confirmed dead** (Facebook
since 2020, Instagram and Threads never had it) — this is settled and
should not be revisited. **Storage of discovered posts must be
purpose-bound and deletable on request**, per the general Platform Terms;
there is no official numeric caching ceiling to hard-code, but there is no
license to keep results indefinitely either.

## Code impact
No shipped code is affected by this research — Docket has no discovery
feature today, so there is nothing to fix or migrate. If a discovery queue
is built from this research, the affected/new surfaces would be:
- A new read-only capability in the Meta provider (`src/providers/meta/`)
  for `ig_hashtag_search` + `recent_media`/`top_media`, requiring the
  `instagram_basic` permission and the "Instagram Public Content Access"
  feature to be added to Docket's Meta app's App Review submission.
- A new read-only capability in the Threads provider
  (`src/providers/threads/`) for `GET /keyword_search`, requiring the
  `threads_keyword_search` permission to be added to Docket's Threads app's
  App Review submission (on top of the existing `threads_basic`,
  `threads_content_publish`).
- Both would need a new storage/retention policy (a reviewable, purgeable
  queue, not an archive) to stay inside the Platform Terms language cited
  above — this is a product/data-model decision, not a fix to an existing
  file.
