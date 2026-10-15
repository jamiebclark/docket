# Engagement inbox — verified facts

Checked 2026-10-15. Bluesky section confirmed from the installed
`@atproto/api` generated types and `docs/research/bluesky.md`. Meta and
direct-message sections are unverified pending a live session (§2, §3).

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

## 2. Meta (Facebook Page comments, Instagram comments, Threads replies) — unverified

`docs/research/meta.md` (checked 2026-10-07) documents publishing only; it
names no comment-read endpoint, no comment-permission scope and no commenter
identity shape for any of the three surfaces. Nothing below was tried live —
this needs a Standard Access app, a real Page, a real Instagram Business
account, a real Threads account, a second person to comment, and a browser
(the human task, scheduled last in `tasks.md` so an unrunnable task placed
early does not starve the implement loop).

| Question (FR-001) | Facebook Page comments | Instagram comments | Threads replies |
|---|---|---|---|
| How are inbound items read (endpoint)? | **unverified** — tried: searched `docs/research/meta.md` and the Graph API changelog page list; neither names a comment-read endpoint for this entry | **unverified** — same | **unverified** — same |
| Which permission does the read require, and is it inside Standard Access? | **unverified** — tried: `docs/research/meta.md`'s permission lists (`pages_manage_posts`, `pages_read_engagement`, etc.) cover publishing, not reading comments; no Standard Access boundary stated for a comment-read scope | **unverified** — same | **unverified** — same |
| What identity fields does a commenter carry (display name, handle, identifier, profile link)? | **unverified** — tried: no Graph API comment object shape recorded anywhere in the repo | **unverified** — same | **unverified** — same |
| Is that identifier stable across two comments by the same person? | **unverified** — tried: cannot be answered without first observing the identifier shape above | **unverified** — same | **unverified** — same |
| Can a reply be sent at the access level the read required? | **unverified** — tried: no reply-to-comment endpoint or permission recorded | **unverified** — same | **unverified** — same |
| How are results paginated? | **unverified** — tried: no comment-listing endpoint recorded, so no pagination shape to check | **unverified** — same | **unverified** — same |
| What are the read rate limits? | **unverified** — tried: `docs/research/meta.md`'s rate-limit section covers publish calls only | **unverified** — same | **unverified** — same |

**Consequence for the design:** no Meta engagement surface is built in this
entry (US4 is blocked on the human task above); nothing in the scheduler,
providers or UI reads or displays a Meta commenter identity. Recorded in
`docs/decisions.md`.

**Blocked, not skipped.** Building real Instagram comments, Threads replies
and Facebook Page comments is blocked on `tasks.md`'s Phase 9 human task
(T083, T084) — a live Meta app, a real Page, a real Instagram Business
account, a real Threads account, a second person to comment, and a browser,
none of which a pipeline phase has. Only after that task resolves may Phase
6's blocked Meta-reading/sending work be turned into new tasks; every
identity field any future Meta surface displays (display name, handle,
identifier, profile link, and whether the identifier is stable across two
comments) must trace to a confirmed verdict recorded there, not to this
section's unverified rows (FR-005, FR-055).

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
