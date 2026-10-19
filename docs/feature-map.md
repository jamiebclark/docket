# Feature map

Features that have been asked for but are not built, with what the platforms allow today and roughly what each would
take. Every platform fact here must be checked against the official docs (and recorded under `docs/research/`) before a
spec is written.

## Already built

- **Image carousels** (2 or more images in one post) on Instagram, Facebook Pages, Threads and Bluesky. The composer
  sets the post type from the image count. Instagram crops every carousel image to the first image's shape, and the
  composer warns about it (`carousel_crop`). On Facebook this is a multi-photo post, not Facebook's link-ad "carousel".
- **Per-platform image fitting.** The media planner (`src/server/media/variants.ts`) converts, resizes and compresses
  each image for each target before publishing.
- **Per-target video formatter (024).** The worker adapts a video to each target's declared limits (cut, crop or pad, resize, frame rate,
  re-encode, or a rewrap) and builds previews. The composer has a video edit dialog (trim, fit, focal point, fill colour). A provider that
  declares video limits gets it. Not yet owned by any spec: burned-in captions, smart crop that follows subjects, a cover frame chosen per
  platform, per-target edits, video upload or edit fields in the public API, generator video input, HDR tone mapping, enlarging small
  videos, joining or splitting clips, speed or filter effects, audio replacement and adding a silent track. Bluesky video (025) and TikTok
  get the formatter by declaring their limits.
- **TikTok (026).** Connect an account with TikTok's web login, then post a video (one MP4 or MOV, uploaded in chunks) or a photo post (1–35 images
  TikTok pulls from a verified media domain). The composer shows TikTok's own fields (who can view, comments, duet, stitch, commercial-content
  disclosure, title) and its consent declaration, driven by three generic hooks (posting fields, account details, consent). Until the operator sets
  `TIKTOK_APP_AUDITED=true`, every post is private. Verified with mocks only until the live checks in `docs/tiktok-setup.md` are done.
  **Risk:** whether TikTok's audit accepts consent given when a post is scheduled, for a later automated send, is not known.
  Not yet owned by any spec: inbox (draft) upload, webhooks, revoking the grant on disconnect, a route that serves media from Docket's own domain,
  video pulled from a URL, AI-generated-content labels, a cover frame choice, music options, TikTok fields in the public API, generator or bulk
  create, a link built from a username, counting TikTok accounts against the 5-user cap, Terms of Service and Privacy Policy pages served by Docket,
  and a confirm-at-send flow (the fallback if the audit refuses consent at scheduling).
- **Pinterest (072).** Connect a Pinterest business account with Pinterest's web login, then post one image pin per scheduled post, with a board
  chosen per post (read live from Pinterest), an optional title and link. Driven by two generic hooks (posting fields, account details); no
  consent and no state machine beyond a single create step. While the deployer's app has Trial access, pins are visible only to the connected
  account's owner and the server shares a 300-pin-a-day cap across every connected account (not enforced by Docket; a 429 defers the post).
  Verified with mocks only until the live checks in `docs/pinterest-setup.md` are done.
  Not yet owned by any spec: video pins, carousel pins, board management (creating or editing boards), secret or protected boards, analytics,
  product/rich pins, catalogs, ads, Pinterest Business Access, AI-disclosure labels, the `api-sandbox` host, automatic detection of Trial vs.
  Standard access, and modelling the shared Trial daily cap as an enforced limit.
- **Bluesky video (025).** One video per post (MP4, up to 300 MB), uploaded to Bluesky's video service in parts, then checked until
  Bluesky has processed it, with plain error explanations, an upload-limit check and a daily allowance of about 25. Verified with mocks
  only until the live checks in `docs/accounts.md` are done. Not yet owned by any spec: WebVTT captions, a GIF hint, a gallery embed,
  quote posts with video, more than one video or video with images, another video service, API video upload and generator video.
- **Video groundwork (018).** MP4 and MOV upload to the media library (and the picker) by resumable multipart upload
  straight to the bucket, ffprobe facts, metadata stripping and a poster frame in the worker, per-provider `video`
  capabilities with composer warnings, and ffmpeg in the image. Instagram publishes video as of 019, Facebook as of 021 and Threads as of 023; no other provider does yet, and generation ignores videos.
  Not yet owned by any spec: API video upload, a generator that uses posters, and resuming an upload after a page reload.
- **Instagram video (019).** Reels, Feed video (a Reel shared to the feed, chosen per post in the composer) and
  carousels that mix images and videos, with per-type limits, video status polling and a daily container allowance.
  Verified with mocks only until the live checks in `docs/meta-setup.md` are done. Not yet owned by any spec: resumable
  Instagram upload for very large files, cover frames and the optional Reel fields (caption tags, audio name), API video
  upload, and a public post update API.
- **Facebook video (021).** Page video posts and Reels, chosen per post in the composer, with per-type limits, Reel
  upload and status checks that resume across ticks, and a 30-posts-per-24-hours Reel allowance. Verified with mocks
  only until the live checks in `docs/meta-setup.md` are done. Not yet owned by any spec: multiple videos or video
  with images in one Facebook post, cover frames and the optional Reel fields, and resumable upload for very large files.
- **Threads video (023).** A single video post and carousels that mix images and videos (up to 20 items at the provider; Docket's
  10-item post cap still applies), with video status checks before the carousel, a 60-minute ceiling and plain error
  explanations. Verified with mocks only until the live checks in `docs/meta-setup.md` are done. Not yet owned by any spec:
  resumable or byte upload for Threads, a cover or thumbnail for Threads video, posts of more than 10 items, API video upload
  and generator video.
- **A time booked across the whole week.** An "Add a time to every day" form above each account's slot grid books one
  posting time on all seven weekdays in one action, skipping days that already have it (paused ones included, which stay
  paused) and reporting which days it added. Idempotent, and safe when two people do it at once — the insert is
  `ON CONFLICT DO NOTHING`, so each caller gets the days it won and neither sees a conflict error. Not yet owned by any
  spec: clearing a time from the whole week, copying one day's slots to the others, a gutter of clickable half-hour rows
  down the left of the grid, and the same bulk add through the public API.
- **Instagram Stories (078).** A single image or video, chosen per post in the composer or through the public API, posted as
  a Story instead of a feed post, feed video or Reel: no caption, no link and no stickers, and no cropping by Docket.
  Verified with mocks only until the live checks in `docs/meta-setup.md` are done. Not yet owned by any spec: Facebook Page
  Stories, stickers and links, reading a Story back, and multi-asset Stories.

- **Engagement inbox (077).** A project-scoped **Inbox** screen shows replies and mentions from connected accounts
  (Bluesky only — see `docs/engagement.md`), each with its parent shown alongside it. A member can request a
  drafted reply (spent under `engagement.reply`, the same credit hold and voice profile as post generation), write
  one by hand, or dismiss the item. Approving a reply happens on the Review page's "Replies" section (no bulk
  approve, a bulk dismiss) through the same extracted decision core posts use, and the reply is sent by the next
  scheduler tick once publishing for that tick has resolved, never on a timer and never under `auto_approve`. An
  ambiguous send surfaces on Failures' "Replies needing a decision" section. Items are kept 90 days by default,
  then pruned with their drafts unless one is still awaiting a decision. Facebook Page comments, Instagram
  comments and Threads replies are specified but not built, blocked on a human research spike into Meta's comment
  identity model; direct messages are modelled (and marked Private wherever they appear) but not read, drafted or
  sent on any real platform yet.
- **Post and account insights (080).** A performance panel on the post detail page shows, per target, the latest
  reading of whatever numbers that platform reports (Bluesky only — see `docs/insights.md`): likes, reposts,
  replies and quotes, each with Bluesky's own label and no views/reach key (Bluesky confirmed to report neither).
  The scheduler reads on a decaying schedule (hourly for a day, daily to a week, weekly to four weeks, then
  frozen), bounded and reserved so it never competes with a scheduled publish for an account's allowance.
  Verified with mocks only until the live check in `docs/research/bluesky.md` is done. Not yet owned by any spec:
  account-level numbers (followers and the like, captured and stored every tick but shown on no screen yet), a
  manual refresh, a per-project on/off switch, any chart/trend/delta/comparison, and `bookmarkCount` (seen in the
  installed package's generated types but not confirmed from Bluesky's own documentation, so left undeclared).
- **Insights reconnect and Meta/Threads readers (081).** Instagram, Facebook Pages and (where its metric enum
  could be confirmed) Threads join Bluesky as readable platforms — see `docs/insights.md`. Reading any of them
  needs a permission Docket does not request by default; the deployer opts in with one environment flag per
  connect group, and an account connected before the flag was on shows "Insights need a reconnect" on the
  Accounts page until it reconnects, with its publish state, slots and history otherwise untouched. An Instagram
  Story's target freezes with reason `expired` at its 24-hour lifetime rather than being polled forever. Meta's
  own `X-Business-Use-Case-Usage` header backs off a read before it risks a publish's budget, with a conservative
  declared floor (**interim, UNVERIFIED**, `docs/limits.md`) underneath it. Verified with mocks only until the
  parked live checks in `docs/meta-setup.md` are done. Not yet owned by any spec: **Facebook video-id targets**
  (a Reel is stored under its video id, not its post id, so Docket cannot yet ask for a Reel's numbers; such a
  target freezes `unqueryable` instead), the whole **Facebook views/impressions family** (Meta deprecated the
  roadmap's named metrics; which replacement answers on Docket's running Graph API version is unconfirmed, R2),
  **Threads account metrics** (declared `unavailable`; the official metric enum could not be confirmed, R3/R4),
  and the account-metric screen, manual refresh, per-project toggle and chart/trend/comparison gaps 080 already
  named, which this entry does not change.
- **TikTok and Pinterest numbers, and a priced opt-in for X (082).** TikTok, Pinterest and X join Bluesky,
  Instagram, Facebook and Threads as readable platforms, each under its own words with nothing summed,
  averaged or compared across platforms — see `docs/insights.md`. A repair ships alongside TikTok's reader:
  the publish step had been storing a `publish_id` as the target's identifier, not the video id TikTok's
  numbers API needs, so a new `post_targets.public_post_id` column now carries the real id, written forward
  from every future publish and backfilled from surviving attempt records for existing targets; a target
  whose id could not be recovered shows insights as unavailable rather than guessing. A run-time
  `unavailable` a reader returns (the X opt-in off, a Pinterest `PINNER_DATA_ACCESS_DENIED`) now persists on
  the poll-state row and survives a page reload, instead of being recomputed from scratch each time (the
  FR-050 honesty fix). Pinterest's account numbers (followers, monthly views) begin accruing for every
  connected account with no reconnect and no flag — the one feature in this entry no operator has to opt
  into. X ships **behind a priced opt-in, off by default** (`X_INSIGHTS_ENABLED`): X charges $0.001 per
  post read, so Docket makes no X insights call at all until an operator turns it on and accepts the
  worked estimate in `docs/x-setup.md`. Verified with mocks only until the parked live checks
  (`docs/research/tiktok.md`, `docs/research/pinterest.md`, `docs/research/x.md`) are done. Not yet owned by
  any spec: whether `public_metrics` on an X post the app itself published actually bills at the owned
  $0.001 rate rather than a standard read (the cost estimate's load-bearing assumption), TikTok's and
  Pinterest's account-metric numbers on any screen (captured every tick, same gap 080 left for Bluesky),
  and the account-metric screen, manual refresh, per-project toggle and chart/trend/comparison gaps every
  prior insights entry has already named, which this entry does not change.
- **The comparisons only Docket can make (083).** A new Insights page (`/p/<project>/insights`) turns the
  snapshot and rollup history 080-082 have been accumulating into account trends, per-post numbers on the
  project overview and posts list, five comparisons (by slot, day of week, series kind, voice profile and
  origin), and time to first engagement — see `docs/insights.md`. No new platform call of any kind: this is
  arithmetic and layout over rows that already exist. Every comparison states its own sample size and a
  per-group verdict (`ranked` at 8+, `provisional` at 4-7, `suppressed` below 4); nothing sums or averages
  across platforms. Retention's two prune passes are fused with a fold into one transaction per batch, so a
  trend survives the snapshot that produced it being pruned. One operation, `docket_get_insights`
  (`GET /insights`), exposes the same figures over the API and MCP — see `docs/mcp.md`. Not yet owned by any
  spec: **Facebook's account period and Pinterest's `monthly_views` window** stay `unknown`-shaped and so
  never trend (resolving either needs a reader change, out of scope here), no significance test or
  normalization for post age, and no manual refresh or per-project toggle — gaps every prior insights entry
  already named, which this entry does not change.

## Scheduling and composing (not built)

### One idea, one image, several projects

Generation is scoped to a single project and a single voice profile. `generateSingle`
(`src/server/services/generation/single.ts`) takes one `voiceProfileId` and a list of `targetAccountIds`; the system
prompt opens "You write social media posts for one brand" (`src/server/services/generation/prompt.ts`); accounts,
media, posts and API keys all carry a `projectId` that the scope harness enforces
(`src/server/db/project-owned.ts`). Within one project this already does the full job: a brief plus images plus a set
of accounts produces one variant per platform, split further per group of accounts that share posting instructions,
in that project's voice, and `auto_approve` + `add_to_queue` sends it without a review stop.

What is missing is the step above: writing one idea once and having every project say it in its own voice. It would
need a composer outside `/p/[projectSlug]`, a picker over the accounts of every project the user is a member of, the
image uploaded into each project's media library (or media made shareable across projects), one generation call per
project (each with that project's default voice profile), and a result screen that reports per-project outcomes
independently — one project's model failure or unconnected account must not sink the others. Per-project policy still
decides whether each result queues or waits for review.

Until then the same effect is available from outside: `POST /v1/media/from-url` then `POST /v1/generate` per project,
with one API key per project, which is what an n8n or script fan-out would do (`docs/n8n.md`).

## Video (other platforms not built)

The build prompt left video out of scope but kept room for it. `PostType` already includes `video`, `story` and
`reel`. The publish step machine supports the multi-minute container polling that video needs. Each provider's
`state.ts` has a place for new media kinds.

### Groundwork every video feature needs (built in 018, kept for reference)

1. **Video in the media library.** Uploads accept images only, and every file goes through `sharp`. Video needs
   accepted MIME types (MP4/MOV), larger size limits, chunked or resumable uploads, and duration, resolution and codec
   read with `ffprobe`. It also needs a poster frame for thumbnails.
2. **Transcoding in the worker, not the web process.** Add `ffmpeg` to the image, run jobs in the worker, and
   store the output in the same public bucket the platforms fetch from.
3. **Capabilities and validation**: duration, aspect ratio, file size and codec limits per post type, in each
   provider's `capabilities.ts`, with composer warnings like the ones images get.
4. **Compose impact**: the worker image gets larger, and transcoding needs CPU and temporary disk. Flag the
   `docker-compose.yml` change when this lands.

### Per platform

| Feature | Platform support | Work in Docket |
|---|---|---|
| **Facebook Page Reels** (Built, 021) | Yes, through the Reels Publishing API: `POST /{page-id}/video_reels` with `upload_phase=start`, upload to `rupload.facebook.com`, then `finish` with `video_state=PUBLISHED` | Three-step upload, then polling. Separate from the image flow |
| **Facebook Page video** (Built, 021) | Yes (Page `/videos`) | Built: one `videos` request with `file_url`, chosen per target as Page video or Reel. Not yet owned: byte or chunked upload, Page video status checks, optional fields (title, place, thumbnail, collaborators, draft), Facebook-side scheduling, API video upload, generator video |
| **Threads video** (Built, 023) | Yes (`media_type=VIDEO`, also in carousels) | Same container-and-poll pattern as Instagram |
| **Bluesky video** (Built, 025) | Yes (`app.bsky.embed.video`: MP4 up to 300 MB, about 25 videos a day; the maximum duration is not documented officially) | Upload to the video service, then poll the job |
| **TikTok** (Built, 026) | Yes, through the Content Posting API (video and photo posts). Until the app passes TikTok's audit (its length is not published), every post is forced private (`SELF_ONLY`) whatever privacy you ask for. Photo posts can only be pulled from a URL on a domain the deployer has verified with TikTok. Videos can be uploaded directly | A new provider and OAuth app, plus the audit. TikTok also requires its own posting UI elements (privacy picker, interaction toggles), so the composer needs TikTok-specific fields |

### Video formatter (crop and fit for each account)

You could build a video version of the image planner: upload one master video, and Docket produces a version for each
target.

- **Aspect ratio**: 9:16 for Reels and TikTok, 4:5 or 1:1 for feed posts, 16:9 for Facebook video. Two ways to fit:
  *crop* (center crop, or a focal point the person drags on the poster frame) or *pad* (letterbox with a blurred
  copy of the video or a solid color).
- **Length**: trim to each platform's maximum, with the start and end set in the composer.
- **Encoding**: H.264/AAC MP4, frame rate and bitrate inside each platform's limits, size under its maximum.
- **Preview**: a short low-resolution render or poster frame for each variant before anything is published.
- **Later**: burned-in captions from a transcript, and choosing a cover frame for each platform.

All of it is `ffmpeg` filter chains (`crop`, `scale`, `pad`, `boxblur`, `trim`) in the worker. A smart-crop that
follows subjects would be a later, optional step.

### Suggested order

1. Groundwork (video in the media library, `ffprobe`, worker transcoding).
2. Instagram Reels and feed video, which reuse the existing container flow (built in 019).
3. Facebook Reels and Page video (built in 021) and Threads video (built in 023).
4. Video formatter (crop and fit for each target).
5. Bluesky video.
6. TikTok (built in 026, verified with mocks only): start the developer app and audit early, because the audit takes weeks.

## Calendar density (not built)

### Status badges overflow the calendar cell

**The requirement:** a calendar cell should show a post's status without the label dictating the cell's width. At
narrower viewports the text badge is wider than the cell it sits in.

Today `CalendarBoard.tsx:182` renders `<StatusBadge status={item.status} />` in each cell, and `StatusBadge`
(`src/components/ui/StatusBadge.tsx`) renders the full human label. "Scheduled" and "Published" are the common
cases; the vocabulary also holds "Needs your decision", "Completed with failures" and "Needs reconnecting".

**Suggested mechanism:** an icon-only variant of `StatusBadge`, used by the calendar alone, keeping the tone colour
and adding a per-status icon.

**The constraint that decides the shape.** `StatusBadge`'s own contract is "text plus colour (never colour alone)",
and that rule carries the whole meaning for anyone who cannot separate the tones. A literal "icon with hover text"
would break it: `title` is not announced by screen readers and does not exist on touch. So the variant needs an
`aria-hidden` icon, a visually-hidden label still carrying `statusLabel(status)` so the accessible name is
unchanged, and `title` only as a convenience for sighted mouse users on top of that.

Every other surface — Posts, Failures, Review, Accounts — keeps the text badge. This is a calendar-density problem,
not a vocabulary one, so the shared component gains a variant rather than changing its default.

Worth checking in the same pass whether the account name in the cell needs truncating; it is under the same width
pressure.

## Public API hardening (not built)

Three gaps the setup write API's second review (`specs/073-setup-write-api/review.md`, round 2) left
open deliberately. None blocks anything; all are small and belong together in one entry.

### One of FR-048's forty cases has no assertion

`PATCH /voice-profiles/{profileId}` has no validation-failure test — nothing sends `baseVersion` as
`0`, as a string, or omits it. Both the request schema (`z.number().int().min(1)`) and the service's
`saveSchema` would reject a bad value, so the behaviour is almost certainly right; it is simply
unproven. Round 1 of the same review closed the mirror-image gap (a missing idempotent replay on
`PATCH /slots/{slotId}`) without noticing this one.

### The cross-project isolation test can lose coverage silently

`tests/integration/api/scope-enforcement.test.ts:151` — `foreign[name]!` yields `undefined` for a
resource parameter missing from the map, and `{ [name]: undefined }` then *overwrites* the fixture's
own value, so the test compares unknown-against-unknown, both 404, both identical, and passes. The
`checked.length >= 6` floor cannot catch it either: the real count is 22 `(operation, parameter)`
pairs. Every parameter is in the map today, so isolation genuinely holds — the defect is that the
test cannot detect its own future loss of coverage. It is the one table-driven test in that area
without such a guard; `setup-permission.test.ts:86` and `:94` both fail loudly on a missing fixture.
Fix: assert `foreign[name]` is defined, or raise the floor to the real pair count.

### `OPTIONS` over-advertises on two literal `/slots/*` paths

`allowedMethods` (`src/server/api/router.ts:37`) unions every operation whose path *template*
matches the segments, and `/slots/{slotId}` matches `["slots","upcoming"]` with
`slotId = "upcoming"`. So `Allow` on `/slots/upcoming` lists `DELETE` and `PATCH`, both of which
answer 404 via the UUID check in `handle.ts`. A client that reads `Allow` and believes it gets a 404
where the header implied a 405 or a 200. Pre-existing shape — `allowedMethods(["media","from-url"])`
contains `GET` for the same reason — that 073 made reachable on two more paths. Fix: prefer an exact
literal match over a parameter match at the same depth, in both `allowedMethods` and
`matchOperation`, or accept it and document it.

### Also owed: a constitution amendment

The Development Workflow section (`.specify/memory/constitution.md:92`) pins the `Co-Authored-By`
trailer to a literal `Claude Opus 5.5`, and no model running this pipeline is that one — implement
commits say `Claude Sonnet 5`, review commits say `Claude Opus 5`. Each names its real author, which
is the right behaviour; the template is what is wrong. A trailer that misattributes work to a model
that did not do it is worse than one that does not match a fixed string, so the amendment should
make the trailer name the acting model rather than a fixed version.

## Verification owed (content-engine roadmap, entries 069–074)

Four checks across the six merged entries were never performed. Each needs something a
headless pipeline phase cannot have — a signed-in browser, a funded provider key, real time
passing, or a real MCP client — so each was written as a human-owned task and left for an
operator.

**Read the task lists with care: three of the four are ticked `[X]` and were still never
run.** They were checked off to release the implement loop, which otherwise stalls on a task
it cannot do, not because anyone did them. Only `074`'s is honestly unchecked. That
inconsistency is recorded here rather than fixed in the task lists, because a task list is a
record of what the pipeline did and rewriting it afterwards would be its own kind of lie.

| Entry | Task | Marked | What it checks | Needs |
|---|---|---|---|---|
| `070-image-generation` | T045 | `[X]` — **not performed** | Generate an image for real: live-region announcements, the new tile with badge and prompt, the cost row | A **funded OpenAI key**, browser, `pnpm dev` |
| `071-evergreen-series` | T075 | `[X]` — **not performed** | A daily series crossing a real local midnight: the post appears in Review, last/next run update, pause/resume | Browser, `pnpm dev`, **real time passing** (or the system clock moved) |
| `072-dated-series` | T071 | `[X]` — **not performed** | Every screen state of the CSV import walkthrough | Browser, `pnpm dev`, a **real CSV file** |
| `074-mcp-server` | T056 | `[ ]` — not performed | A real MCP client end to end: list tools, ask what's scheduled, generate, queue with the confirmation refused once and accepted once, then a second client on another project's key to prove isolation | Browser, **a real MCP client** |

Each entry's `quickstart.md` has the steps. None of these is a known defect — every one of
them is a path with automated coverage against mocks, and the live check exists to catch what
a mock cannot: a provider's real response shape, a real clock, a real client's idea of the
protocol. Two are worth prioritising:

- **`070` T045** is the only one that spends real money, and it is the only exercise of the
  OpenAI image path against a live API rather than a fixture. Note
  `docs/decisions.md`'s OpenAI free-tier finding: the model is free only with a positive
  organisation balance, so an unfunded key fails in a way the mocks do not model.
- **`074` T056** is the only verification of the MCP server against a real client, and
  Docket deliberately targets protocol revision `2025-11-25` (the newest the installed SDK
  implements) while the published current revision is `2026-07-28` — see
  `docs/research/mcp.md` §1 and §6. A client that speaks only the newer revision is exactly
  what this check would discover, and nothing in the suite can.
