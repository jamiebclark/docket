# Bluesky — verified facts

Checked 2026-10-07 (limits re-verified; other sections checked 2026-10-02). Sources: lexicons on GitHub, `@atproto/api` source, docs.bsky.app.

## Lexicon limits
- `app.bsky.feed.post` `text`: **maxGraphemes 300**, **maxLength 3000** (bytes).
  `langs` ≤ 3 entries.
  https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/post.json
- `app.bsky.embed.images`: **max 4 images**; image blob accept `image/*`,
  **maxSize 2,000,000 bytes** (not 2 MiB). `alt` is a **required** string
  (may be empty). Optional `aspectRatio {width,height}`.
  https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/embed/images.json
  (docs.bsky.app still says 1,000,000 — the lexicon wins.)

## Auth and client
- App password + `com.atproto.server.createSession` is still supported; OAuth
  is aimed at end-user login apps, password auth is fine for bots/tools.
  https://docs.bsky.app/docs/get-started
- `@atproto/api` latest **0.23.0**. README recommends `new Agent(session)`;
  for password auth: `new Agent(new CredentialSession(new URL(pdsUrl)))`
  (exact constructor shape: check the package's types in node_modules).
  `AtpAgent` (`login`/`resumeSession`) is legacy but supported.
  https://github.com/bluesky-social/atproto/blob/main/packages/api/README.md
- PDS token lifetimes: access JWT **120 min**, refresh JWT **90 days**; refresh
  tokens rotate (grace period); concurrent refreshes can throw
  `ConcurrentRefreshError` → serialise refreshes per account and persist the
  new `refreshJwt` every time.
  https://github.com/bluesky-social/atproto/blob/main/packages/pds/src/account-manager/helpers/auth.ts
- Custom PDS URL supported; default `https://bsky.social`.

## Rich text / facets
- `RichText#detectFacets(agent)` detects links, mentions, hashtags (and
  cashtags), matches on UTF-16 and converts to **UTF-8 byte offsets**
  correctly. Mentions are resolved via `com.atproto.identity.resolveHandle`.
  A failed resolution leaves `did: ''` — **filter those facets out** before
  posting. `detectFacetsWithoutResolution()` skips resolution.
  https://github.com/bluesky-social/atproto/blob/main/packages/api/src/rich-text/rich-text.ts

## Rate limits
Source: https://github.com/bluesky-social/bsky-docs/blob/main/docs/advanced-guides/rate-limits.md
(the official docs repo; confirmed 2026-10-07 from the raw file. The rendered
page https://docs.bsky.app/docs/advanced-guides/rate-limits answers 308 to
bsky.network and did not load through the fetch tool.)
- `createSession`: **30 / 5 min** and **300 / day** per account → persist and
  refresh sessions, never log in per post.
- Writes: **5,000 points/hour, 35,000 points/day**; **CREATE = 3, UPDATE = 2,
  DELETE = 1** point. So a post (one createRecord) costs 3 points:
  floor(5000/3) = 1666 per hour, floor(35000/3) = 11666 per day. Points are per
  account and shared with every other app writing to it. Image uploads
  (`uploadBlob`) cost: **UNVERIFIED** (not on the summarised text).
  Changed 2026-10-07: was "approximate, from search results"; now confirmed from the docs repo.

## Limits verification, 2026-10-07
Checked 2026-10-07 against the raw lexicon files on GitHub (fetch tool
summarises, so values are as reported).
| Limit | Verified value | Source |
|---|---|---|
| Text | `maxGraphemes` **300**, `maxLength` **3000** (UTF-8 bytes). Both apply. | https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/post.json |
| Images per post | `images` array `maxLength` **4** | https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/embed/images.json |
| Image bytes | blob `maxSize` **2,000,000**, `accept` `image/*` | same |
| Alt text | `alt` is a required string described only as "Alt text description of the image, for accessibility."; **no maximum length in the lexicon** (no `maxLength` or `maxGraphemes`). The client may impose its own; none found officially. | same |
| Tags | `tags` array max 8, each max 640 bytes / 64 graphemes (not used by Docket) | post.json |
| Posts per hour/day | 5,000 / 35,000 points, create = 3: 1666 / hour and 11666 / day, shared with other apps on the account (see Rate limits above) | https://github.com/bluesky-social/bsky-docs/blob/main/docs/advanced-guides/rate-limits.md |
Image dimension limits: none in the lexicon. Not specified: **UNVERIFIED**
whether the PDS or AppView refuses extreme sizes.

## Posting
- Upload each image with `com.atproto.repo.uploadBlob` (≤2,000,000 bytes;
  compress with sharp to fit), then `com.atproto.repo.createRecord` with
  collection `app.bsky.feed.post`, `createdAt` ISO timestamp, `text`,
  `facets`, `embed` (`app.bsky.embed.images`). The response `uri`
  (`at://did/app.bsky.feed.post/<rkey>`) is the external id; web URL is
  `https://bsky.app/profile/<handle>/post/<rkey>`.
- A createRecord that times out is **ambiguous** (may have posted).
