# Bluesky / AT Protocol — topic discovery queue (search + like)

Checked 2026-10-16. Sources: lexicons in `bluesky-social/bsky` and
`bluesky-social/atproto` on GitHub, `atproto.com` specs, `bsky.network`
(Bluesky PBC's current developer-docs site; `docs.bsky.app` 308-redirects
there as of this check), the official AT Protocol bot tutorial, and the
Bluesky Developer Guidelines. Third-party posts are named only where the
official sources don't say enough, and are marked UNVERIFIED.

**Note for whoever reads `bluesky.md` next to this file:** the lexicons
directory of `bluesky-social/atproto` no longer contains `app/bsky` —
`lexicons/README.md` in that repo now says the canonical source for
`app.bsky.*` and `chat.bsky.*` moved to the `bluesky-social/bsky` repo (`com.atproto.*`
and `tools.ozone.*` stayed in `atproto`). `bluesky.md`'s citations to
`.../atproto/blob/main/lexicons/app/bsky/...` (post.json, embed/images.json)
predated this split and 404'd. **Re-pointed to `bluesky-social/bsky` on
2026-10-16**, across `bluesky.md`, `bluesky-video.md` and this file; the
`com.atproto.*` citations were left on `atproto`, where they still resolve.
The two facts `bluesky.md` draws from `app.bsky.feed.post` were re-checked
against the new location at the same time and have not drifted
(`maxGraphemes` 300, `maxLength` 3000).
https://github.com/bluesky-social/atproto/blob/main/lexicons/README.md (fetched via GitHub Contents API after direct `blob`/`raw` URLs 404'd)

## 1–4. Search: endpoint, auth, syntax, pagination

- **Endpoint**: `GET /xrpc/app.bsky.feed.searchPosts`, lexicon id
  `app.bsky.feed.searchPosts`, now canonical in `bluesky-social/bsky`.
  https://github.com/bluesky-social/bsky/blob/main/lexicons/app/bsky/feed/searchPosts.json
  (fetched via the GitHub Contents API, which base64-decodes identically to `blob`)
- **Parameters** (all query string; only `q` required):
  | Param | Type | Notes |
  |---|---|---|
  | `q` | string, required | "Search query string; syntax, phrase, boolean, and faceting is unspecified, but Lucene query syntax is recommended." |
  | `sort` | string enum | `knownValues: ["top", "latest"]`, default `"latest"` |
  | `since` | string | inclusive; "Expected to use 'sortAt' timestamp, which may not match 'createdAt'." Accepts a full datetime or a bare `YYYY-MM-DD` |
  | `until` | string | exclusive; same format rules as `since` |
  | `mentions` | string, format `at-identifier` | handle or DID; "resolved to DID before query-time. Only matches rich-text facet mentions" |
  | `author` | string, format `at-identifier` | handle or DID; resolved to DID before query |
  | `lang` | string, format `language` | post-language filter; "server may override language detection" |
  | `domain` | string | filters by linked-URL hostname (facet links or embeds) |
  | `url` | string, format `uri` | filters by exact/fuzzy-matched linked URL |
  | `tag` | array of string, each `maxLength 640` / `maxGraphemes 64` | hashtag filter, **no leading `#`**; multiple tags are **AND**ed; matches rich-text facet tags or the post's `tags` field |
  | `limit` | integer | `minimum 1`, `maximum 100`, default `25` |
  | `cursor` | string | opaque; "may not necessarily allow scrolling through entire result set" |
  https://github.com/bluesky-social/bsky/blob/main/lexicons/app/bsky/feed/searchPosts.json
- **Query syntax (point 3)**: the lexicon itself says syntax is
  *"unspecified, but Lucene query syntax is recommended."* There is no
  documented formal grammar beyond that one sentence — no confirmed
  `from:`/`since:` inline operators (those are UI affordances in the
  bsky.app search box, not confirmed as part of the `q` string grammar);
  the structured filters above (`author`, `since`, `until`, `tag`, `lang`,
  `domain`, `url`) are the supported way to filter, as separate params, not
  inline query syntax. Quoted phrases and basic boolean (`AND`/`OR`/`-`)
  are commonly reported to work (Lucene-style) but **UNVERIFIED** against
  an official grammar doc — none exists. `tag` is the dedicated
  hashtag/tag search path (point 3's "separate hashtag search").
- **Auth (point 2) — this moved under us while researching**: the lexicon
  historically described this as a public AppView query, but Bluesky has
  since tightened it. A still-open issue in Bluesky's own docs repo
  (opened 2025-02-22, maintainer reply 2025-02-27) states plainly:
  *"AppView is deliberately returning 403 to decrease load"* for
  unauthenticated `searchPosts` calls on `public.api.bsky.app`, and
  reports (unresolved as of the thread's last update) say the same now
  happens intermittently on `api.bsky.app`.
  https://github.com/bluesky-social/bsky-docs/issues/332
  The correct, supported pattern for an authenticated client is **not** to
  hit `public.api.bsky.app` directly, but to send the request to your own
  PDS with the user's access JWT and an `atproto-proxy` header pointing at
  the Bluesky AppView, and let the PDS proxy it:
  - Header: `atproto-proxy: did:web:api.bsky.app#bsky_appview`
  - Spec for the mechanism: *"The HTTP header is `atproto-proxy`, and the
    value is a DID (identifying a service), followed by a service endpoint
    identifier, joined by a `#` character."* The PDS "resolves the service
    DID, extracts a service endpoint URL from the DID document, and
    proxies the request on to the identified server," using an
    inter-service JWT it signs for the authenticated account; PDS rate
    limits still apply to the proxied call.
    https://atproto.com/specs/xrpc#service-proxying
  - `did:web:api.bsky.app#bsky_appview` as the specific AppView DID/service
    id for `app.bsky.*` calls, and general guidance that "most `app.bsky.*`
    GETs are public" and can also be called unauthenticated against
    `https://public.api.bsky.app` (with the 403-under-load caveat above):
    https://bsky.network/docs/bluesky-api/request-proxying/
  - **Auth kind**: whichever session you already have — app password →
    `createSession` access JWT works fine for the proxied call; there is no
    separate "search scope" documented. No app-password privilege tier is
    required (see §8 on scopes).
- **How far back / pagination (point 4)**: `limit` max is **100**, default
  25, confirmed above. No official document states a retention/backfill
  window for the search index. The only official rate-limit statement for
  AppView query endpoints (which include `searchPosts`) is the vague
  *"These API services have generous rate-limits"* with no number — see §8.
  https://github.com/bluesky-social/bsky-docs/blob/main/docs/advanced-guides/rate-limits.md
  (fetched from the raw file; same source `bluesky.md` already cites for write limits)
  A community report (UNVERIFIED, not from an official source) claims
  **logged-out** search is additionally capped at 100 results total with no
  further cursor paging; since Docket would always call this authenticated
  via the proxy path above, that cap should not apply, but it has not been
  confirmed against an official page.
  An open, unresolved GitHub Discussion in the official repo
  (bluesky-social/atproto#2820, opened 2024-09-18) asks the same rate-limit
  question with no maintainer answer — treat any numeric figure beyond the
  "generous"/global-IP-limit language as unconfirmed.
  https://github.com/bluesky-social/atproto/discussions/2820

## 5. Fields returned per post

Each hit is an `app.bsky.feed.defs#postView`:
`uri` (string, format `at-uri`), `cid` (string, format `cid`), `author` (ref
`app.bsky.actor.defs#profileViewBasic`, carries both handle and DID),
`record` (type `unknown` — the raw `app.bsky.feed.post` record: `text`,
`createdAt`, `facets`, `embed`, etc.), `embed` (rendered embed view: images,
video, external, record/quote, or a record-with-media union), `replyCount`,
`repostCount`, `likeCount`, `quoteCount`, `bookmarkCount` (all integer),
`indexedAt` (datetime), `viewer` (ref `#viewerState`), `labels`,
`threadgate`.
https://github.com/bluesky-social/bsky/blob/main/lexicons/app/bsky/feed/defs.json
- **`uri` + `cid` pair — confirmed available** directly on every returned
  post, which is exactly what a like's `subject` needs (§7). No extra fetch
  is required to get the `cid`.
- **Bonus for the like/unlike flow**: `viewerState` (present on a post when
  the call was made as an authenticated viewer, which the proxy path above
  gives you) has a `like` field — `{ type: "string", format: "at-uri" }` —
  described as the viewer's own existing like record on that post, if any.
  That means a search result already tells you, per post, whether *you*
  already liked it and gives you the like record's own `uri` for unliking,
  with no extra `listRecords` call. Same source as above (defs.json).

## 6. Web/app deep link from a post's `uri`

An AT-URI is `at://<authority>/<collection>/<rkey>`
(https://atproto.com/specs/at-uri-scheme). For a post
(`collection = app.bsky.feed.post`), bnewbold (Bluesky protocol engineer)
gives the transform directly in the official repo's discussions:
*"look at the AT URI authority (DID), collection, and rkey segments... for
posts specifically... create URLs like:
`https://bsky.app/profile/<DID>/post/<RKEY>`"*
https://github.com/bluesky-social/atproto/discussions/2523
That reply only confirms the **DID** form. `bluesky.md` (§"Posting" in this
repo's existing research) already documents and Docket's own
`publish.ts`/`video-publish.ts` already produce the **handle** form
(`https://bsky.app/profile/<handle>/post/<rkey>`) for the account's own
posts; bsky.app's profile route accepts either a DID or a handle in that
segment, so both forms resolve. For other people's posts returned by
search, prefer the **DID** form (`postView.author.did`) — it's what's
officially confirmed, and unlike a handle it can't go stale if the author
renames.

## 7. Liking: mechanism and schema; unliking

- **Confirmed**: liking is `com.atproto.repo.createRecord` with
  `collection: "app.bsky.feed.like"`.
- **Record schema** (`app.bsky.feed.like`, `key: "tid"`, so the server
  mints the rkey as a TID when you don't supply one):
  ```json
  {
    "subject": { "type": "ref", "ref": "com.atproto.repo.strongRef" },
    "createdAt": { "type": "string", "format": "datetime" },
    "via": { "type": "ref", "ref": "com.atproto.repo.strongRef" }
  }
  ```
  `subject` and `createdAt` are **required**; `via` is optional (used for
  "like via a repost/quote" attribution, not needed for a plain like).
  `com.atproto.repo.strongRef` is `{ uri: at-uri, cid: cid }` — exactly the
  `uri`/`cid` pair a search hit already carries (§5).
  https://github.com/bluesky-social/bsky/blob/main/lexicons/app/bsky/feed/like.json
- **createRecord input/output** (generic, same call Docket already uses to
  publish posts): input requires `repo` (the liker's own handle/DID),
  `collection`, `record` (must carry `$type`); `rkey` and `validate` are
  optional, `swapCommit` is optional for CAS. Output: `uri`, `cid`
  (required), plus optional `commit`/`validationStatus`.
  https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/repo/createRecord.json
  So a like call looks like:
  ```json
  {
    "repo": "<your-did>",
    "collection": "app.bsky.feed.like",
    "record": {
      "$type": "app.bsky.feed.like",
      "subject": { "uri": "<post uri>", "cid": "<post cid>" },
      "createdAt": "<now, ISO 8601>"
    }
  }
  ```
  The response `uri` is the like record's own at-uri — **save it**; its
  last path segment is the rkey you need to unlike later.
- **Unlike**: `com.atproto.repo.deleteRecord` with `repo` (your DID),
  `collection: "app.bsky.feed.like"`, `rkey` (all three required;
  `swapRecord`/`swapCommit` optional for CAS).
  https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/repo/deleteRecord.json
  **Finding the rkey** if you didn't keep it from the create response: a
  `postView` fetched while authenticated carries `viewer.like` — the at-uri
  of your own like record on that post (§5) — parse its last segment for
  the rkey. Failing that, `com.atproto.repo.listRecords` on your own repo
  (`repo` = your DID, `collection: "app.bsky.feed.like"`, `limit` 1–100
  default 50, `cursor`, `reverse`) returns `{ uri, cid, value }` per record;
  filter `value.subject.uri === targetPostUri` to find the rkey. Note
  `app.bsky.feed.getLikes` (lists which *actors* liked a given post) is the
  wrong tool here — its entries carry the liking actor's profile and
  timestamps only, **not** the like record's own uri/rkey, so it can't be
  used to find what to delete.
  https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/repo/listRecords.json,
  https://github.com/bluesky-social/bsky/blob/main/lexicons/app/bsky/feed/getLikes.json

## 8. Rate limits for writes

Confirmed, same source `bluesky.md` already cites for posts, and the
numbers apply uniformly to **any** collection — nothing like-specific:
*"The limit is 5,000 points per hour and 35,000 points per day."*
`CREATE = 3`, `UPDATE = 2`, `DELETE = 1` point → *"an account may create at
most 1,666 records per hour and 11,666 records per day."* A like
(`createRecord`) costs the same 3 points as a post; an unlike
(`deleteRecord`) costs 1. These are **per account** (not per app password —
the budget is on the DID's repo, shared across every app password and
every client writing to it), and the same budget a scheduled post consumes,
so a discovery queue's likes compete with Docket's own posting for the same
daily allowance.
https://github.com/bluesky-social/bsky-docs/blob/main/docs/advanced-guides/rate-limits.md
- **Read side**: the same document's only statement about the AppView
  (which serves `searchPosts`) is *"These API services have generous
  rate-limits"* — no number given. The hard numeric limit that does apply
  to the proxied call is the PDS's *"Overall API Requests... Rate limited
  by IP... 3000 per 5 minutes"*, since the request still transits your PDS.
- **Error shape on exceeding a limit**: HTTP **429**. The write-points
  document says *"requests usually receive an HTTP 429 ('Too Many
  Requests') response status code"* and doesn't specify a body; Docket's
  existing `rateLimitNotBefore` (src/providers/bluesky/errors.ts) already
  reads a `Retry-After` header (delta-seconds or HTTP-date) off any
  `XRPCError`, which is the generic mechanism and needs no new code for
  search or like calls — it's the same `@atproto/api` `XRPCError` shape
  either way.

## 9. Automation policy — the crux

Two official documents matter here, and they say different things about
different behaviors:

1. **Posting bots are explicitly sanctioned and even has a styling
   convention.** AT Protocol's own bot tutorial walks through building and
   running a bot, and documents a **self-label** convention for marking an
   account as a bot, set on the profile record:
   ```js
   await client.put(app.bsky.actor.profile, {
     ...existingProfile,
     labels: {
       $type: 'com.atproto.label.defs#selfLabels',
       values: [{ val: 'bot' }],
     },
   })
   ```
   This is **advisory, not enforced** — nothing in the lexicons or
   guidelines requires it, and no official page states a legal/ToS
   consequence for omitting it. There is no dedicated enforcement/labeling
   *requirement* section in the Developer Guidelines either — confirmed by
   directly asking that page for one (see below); it simply doesn't exist
   as a mandated rule, only as a documented best practice in the tutorial.
   https://atproto.com/guides/bot-tutorial
2. **Automated interactions — specifically including likes — are called
   out as spam, full stop, in the official Developer Guidelines**, which
   bind *"Developers who federate their apps or services on the AT
   Protocol... in order to communicate with Bluesky services"* (i.e. this
   is not limited to accounts labeled `bot`; it binds anyone calling
   Bluesky's API):
   > "1. Don't spam. We trust that you will create a great app that will
   > grow organically. Our definition of spam includes:
   >     1. Generating automated or bulk interactions, including any that
   >        would cause a notification to a user like a message, follow,
   >        like or reply
   >     2. Any method to automate generating followers or interactions,
   >        including account generation tools
   >     3. Spambots"
   https://bsky.network/docs/developer-guidelines/
   The same bot tutorial is explicit about the line, in its own words:
   > "If your bot interacts with other users, please only interact (like,
   > repost, reply, etc.) if the user has tagged the bot account. It
   > should be an opt-in interaction, or your bot may be flagged for spam."
   https://atproto.com/guides/bot-tutorial
3. **Community Guidelines** (the user-facing policy, separate document)
   echo the same principle at the account-behavior level rather than the
   API level: *"Do not artificially manipulate features or social signals
   to gain unearned reach or mislead users, including engagement metrics,
   follower counts, or other measures of community interest"* and bans
   *"automated harassment systems"* specifically for abuse, without a
   general carve-out for "automated liking is fine if a human approved the
   target first."
   https://bsky.social/about/support/community-guidelines

**Reading the line precisely**: nothing in these documents distinguishes
"a human reviews a shortlist, then the system fires the API call" from
"the system likes unattended." The Developer Guidelines' definition of
spam is written in terms of the *mechanism* (an automated/bulk interaction
via the API causing a notification) not the *provenance* (whether a human
clicked approve first) or the *volume* (the word is "automated **or**
bulk," not "automated **and** bulk"). A Docket discovery-queue like —
even one-at-a-time, even human-approved — is a `createRecord` call made
by code on the brand's behalf, which is exactly the mechanism item 1 of
the spam definition names. No official page carves out an exception for
curated/low-volume/human-gated automation. This is the one place where the
"bots are first-class citizens here" framing in the task prompt doesn't
hold once the verb is *liking* rather than *posting*: Bluesky's own docs
sanction automated **posting** loudly (tutorial, starter templates) and
call out automated **liking without being tagged/opted-in** as spam by
name, in the same breath as follow-bots and account-generation abuse.
- **Disclosure requirement**: none found that is mandatory. The `bot`
  self-label is a documented convention, not a documented requirement, and
  applies to the *account*, not to individual automated actions like a
  like.

## 10. Data retention / caching of search results

No official page (ToS, Developer Guidelines, Community Guidelines, or the
API docs) states a retention or caching restriction specific to search
results or to content fetched via the API. The Terms of Service address
deletion of the *user's own* content on request, with the caveat that
Bluesky can't control other AT Protocol services:
*"If you delete your account, we will use reasonable efforts to remove
your Content from Bluesky... Due to the decentralized nature of the AT
Protocol, we cannot control or force other services and Developer
Applications on the AT Protocol to treat your Content in a particular
way."* and *"Allow trusted partners... to use your Content as necessary to
support Bluesky Social."*
https://bsky.social/about/support/tos
This doesn't specifically authorize or forbid Docket caching matched posts
for a review queue; it only establishes that Bluesky itself makes no
promise that *other* apps (Docket included) will purge deleted content.
**UNVERIFIED**: whether a deleted-upstream post must be purged from
Docket's queue on a timeline — no official page states one. The practical
implication either way is to re-check/refresh queued items against the
live API before surfacing a stale one, and to drop an item if the source
post 404s (deleted) or returns `NotFound`/blocked when liking, rather than
caching a permanent local copy.

## Verdict for Docket

**(a) Scheduled keyword polling is buildable.** `app.bsky.feed.searchPosts`
is a real, documented endpoint with exactly the filters a discovery queue
needs (`q`, `tag`, `author`, `since`/`until`, `lang`, `limit`, `cursor`).
The only wrinkle is that it must be called **authenticated and proxied**
(PDS + `atproto-proxy: did:web:api.bsky.app#bsky_appview` header), not hit
directly against `public.api.bsky.app`, because that public host now 403s
unauthenticated search under load (§2). A poller can page with `cursor`
up to `limit=100` per call, dedupe by `uri`, and use each `postView`'s
`viewer.like` to know immediately if the brand account already engaged.

**(b) Automated liking is technically possible; policy-permitted is the
open question, not technically settled in Docket's favor.** Mechanically:
`createRecord` on `app.bsky.feed.like` with `{ subject: { uri, cid } }`
works exactly as hoped (§7), budgeted under the same 5,000/hr, 35,000/day
points pool as posting (§8), and unliking is a plain `deleteRecord`.
Policy-wise: Bluesky's Developer Guidelines name *"automated or bulk...
like"* as their definition of spam, and the official bot tutorial says to
only auto-like when the target user tagged/opted in (§9) — there is no
documented exception for a human-curated, low-volume, "approve from a
queue" flow. Shipping automated liking as designed (poll → human picks →
Docket's API likes it) is the kind of interaction these documents describe,
not an edge case they've carved out of it. That's a product-policy call,
not a technical blocker — flagging it precisely rather than making it, per
the brief.

**(c) Auth/credential work needed.** Docket's existing Bluesky credentials
(`src/providers/bluesky/settings.ts` → `blueskyCredentialsSchema`:
`accessJwt`, `refreshJwt`, `did`, `handle`, obtained via
`com.atproto.server.createSession` with the brand's app password,
`src/providers/bluesky/session.ts`) already carry **full read/write scope**
for this — the same session Docket uses today to `createRecord` a post can
`createRecord` a like and `deleteRecord` to unlike; `createAppPassword`'s
only scope split is a `privileged` flag (for sensitive account state like
DM access), and nothing in the `createRecord`/`deleteRecord`/`like`
lexicons requires it. **What would need to change** is the *client*, not
the *credentials*: `src/providers/bluesky/client.ts`'s `agentFor` builds a
plain `Agent` with only an `authorization` header — no `atproto-proxy`, and
`@atproto/api`'s `Agent` does **not** default one in for `app.bsky.*`
calls (confirmed by reading `packages/api/src/agent.ts`: the proxy header
is only set `if (this.proxy && !headers.has('atproto-proxy'))`, and
`this.proxy` is only populated by an explicit `withProxy()`/
`configureProxy()` call — there's no hardcoded AppView DID default).
Calling `agentFor(pdsUrl, accessJwt).app.bsky.feed.searchPosts(...)` as
written today would hit the brand's own PDS's `/xrpc/app.bsky.feed.
searchPosts`, which a PDS does not implement (that's an AppView-only
lexicon) — it would need either a second agent built with
`.withProxy("bsky_appview", "did:web:api.bsky.app")` before the search
call, or an equivalent explicit `atproto-proxy` header, to actually reach
the AppView through the user's own PDS as the proxying docs describe (§2).
That's the one concrete code gap; everything else (rate-limit/429 handling,
XRPCError classification) already exists generically in
`src/providers/bluesky/errors.ts` and needs no change to also cover reads
and likes.
