# Bluesky — verified facts

Checked 2026-10-02. Sources: lexicons on GitHub, `@atproto/api` source, docs.bsky.app.

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
(docs page did not load; numbers from search results quoting it — treat as
approximate) https://docs.bsky.app/docs/advanced-guides/rate-limits
- `createSession`: **30 / 5 min** and **300 / day** per account → persist and
  refresh sessions, never log in per post.
- Writes: 5,000 points/hour, 35,000/day; create = 3 points.

## Posting
- Upload each image with `com.atproto.repo.uploadBlob` (≤2,000,000 bytes;
  compress with sharp to fit), then `com.atproto.repo.createRecord` with
  collection `app.bsky.feed.post`, `createdAt` ISO timestamp, `text`,
  `facets`, `embed` (`app.bsky.embed.images`). The response `uri`
  (`at://did/app.bsky.feed.post/<rkey>`) is the external id; web URL is
  `https://bsky.app/profile/<handle>/post/<rkey>`.
- A createRecord that times out is **ambiguous** (may have posted).
