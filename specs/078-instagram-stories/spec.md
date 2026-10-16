# Feature Specification: Instagram Stories as a post type

**Feature Branch**: `078-instagram-stories`

**Created**: 2026-10-16

**Status**: Draft

**Input**: User description: "Instagram Stories as a post type in Docket. Add `story` to the Instagram provider's supported post types so a post can be published as an Instagram Story through the container-then-publish pipeline the provider already runs, exactly the way `reel` already is."

## Overview

Docket can already publish an Instagram image, carousel, feed video and Reel. It cannot publish a
Story, even though `story` is already a value of the post-type vocabulary — no provider offers it, so
nothing can select it. This adds Story to the Instagram provider as a third thing a single asset can
be published as, reusing the account connection, the publishing accounting and the resumable
container-then-publish sequence that Reels already use.

A Story is not a feed post with a different label. It carries **no caption, no link and no stickers**,
it drops the image description Docket attaches to every asset, and it wants a 9:16 asset while every
image in this project is 1:1. This spec settles each of those, so that what a Story drops is stated to
the person scheduling it rather than discovered after it published.

Facebook Page Stories are **out of scope** (see Out of Scope).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Publish an image as an Instagram Story (Priority: P1)

A content manager has a single image on a post and wants it to go out as an Instagram Story rather
than as a feed post. In the composer, under the Instagram account, they pick "Story" instead of
"Feed post", read the one-line description telling them a Story carries no caption and no link, see a
notice that the image is square and Instagram will crop it or show blank space, and schedule it. At
the scheduled time it publishes as a Story on that account.

**Why this priority**: It is the whole point of the feature and the only shape this project actually
has media for. Every image Docket holds for this project is 1:1, so an image Story is the first thing
anyone will try.

**Independent Test**: Compose a post with one image and one Instagram target, select Story, schedule
it, and run the publish sequence against a mocked Instagram. The container is created as a story, the
request carries no caption and no description, and the publish returns a story id. Delivers the whole
user-visible capability on its own.

**Acceptance Scenarios**:

1. **Given** a post with exactly one image and one Instagram target, **When** the composer renders
   that target, **Then** a "Post as" choice offers a feed post and a Story, the feed post is
   pre-selected, and the Story option's description says it carries no caption, no link and no
   stickers.
2. **Given** that target set to Story, **When** the post is validated before scheduling, **Then** a
   non-blocking notice says the post text will not appear on the Story and another says the image
   description will not appear.
3. **Given** a 9:16 image on a Story target, **When** the post is validated, **Then** no aspect-ratio
   error is raised, even though 9:16 is outside the range Instagram allows for a feed image.
4. **Given** a 1:1 image on a Story target, **When** the post is validated, **Then** a non-blocking
   notice names the image's shape and says Instagram will crop it or show blank space, and the image
   is neither refused nor altered by Docket.
5. **Given** a scheduled Story target, **When** the publish sequence runs, **Then** the media
   container is created as a story from the image, its processing status is polled, the account's
   publishing allowance is checked, the Story is published, and the returned id is recorded against
   the target.
6. **Given** a Story target whose post also has text and whose post also targets a Facebook Page,
   **When** the post is scheduled, **Then** scheduling is not blocked: the Facebook target publishes
   with the text and the Instagram Story publishes without it.

---

### User Story 2 - Publish a video as an Instagram Story (Priority: P2)

The same content manager has a single video on a post. Instagram already lets them choose between a
Feed video and a Reel; now Story joins that choice. They pick Story, see the Story's own limits — up
to 60 seconds, up to 100 MB — in the requirements summary rather than the Reel's 15 minutes and
300 MB, and schedule it.

**Why this priority**: Stories are as much a video surface as an image one, and the Story limits are
materially tighter than the Reel limits the provider already encodes. Shipping only the image half
would leave a 10-minute video silently refused with a Reel's numbers in the message. It is second
only because no video media exists for this project yet.

**Independent Test**: Compose a post with one video and one Instagram target, select Story, and run
validation and publish against a mocked Instagram. The choice is offered, the Story's limits are the
ones enforced and reported, and the container is created as a story from the video.

**Acceptance Scenarios**:

1. **Given** a post with exactly one video and one Instagram target, **When** the composer renders
   that target, **Then** the "Post as" choice offers Feed video, Reel and Story, with Feed video
   still pre-selected.
2. **Given** a Story target with a 90-second video, **When** the post is validated, **Then** the
   person is told the video will be cut to 60 seconds — not to the Reel ceiling.
3. **Given** a Story target with a 2-second video, **When** the post is validated, **Then** it is
   refused with a message quoting the Story's 3-second minimum.
4. **Given** a Story target with a video the platform cannot be made to accept at 100 MB, **When** the
   post is validated, **Then** it is refused with the Story's 100 MB figure, not the Reel's 300 MB.
5. **Given** a Story target with a video whose shape is outside 0.1:1 to 10:1, **When** the post is
   validated, **Then** it is handled exactly as an out-of-range Reel is — adapted to an accepted shape
   if that is possible, refused with the Story's range if it is not.
6. **Given** a video Story container that Instagram is still processing, **When** the publish sequence
   runs again on a later tick, **Then** it resumes polling without recreating the container, and
   publishes once processing has finished.

---

### User Story 3 - Know what a Story drops before scheduling it (Priority: P3)

Anyone scheduling a Story — through the composer or through the API — learns what it will and will
not carry before it goes out, not from a surprise afterwards. The capability description says plainly
that a Story carries no caption, no link and no stickers; the per-target notices name the text and the
image description that will be dropped and the cropping that may happen; the API returns the same
notices in its validation issues for the target.

**Why this priority**: It is the difference between the feature being usable and being a trap. Someone
who schedules a Story expecting their call to action to appear has wasted the post. It is third only
because stories 1 and 2 each carry the parts of it that belong to their own shape; this story is the
guarantee that the full set is surfaced consistently in both the composer and the API.

**Independent Test**: Read an Instagram account's advertised capabilities and the validation issues
for a Story target through the API, with no UI involved, and check that each dropped element is named.

**Acceptance Scenarios**:

1. **Given** an Instagram account, **When** its capabilities are read through the API, **Then**
   `story` appears among its post types and the Story option's description names what a Story cannot
   carry.
2. **Given** a post with a Story target created through the API, **When** the caller reads the post's
   per-target validation issues, **Then** the same notices the composer shows are present, each with
   its severity, so a non-blocking notice is distinguishable from a refusal.
3. **Given** a Story target, **When** the requirements summary for that target is read, **Then** it
   reports the Story's own media limits, not the feed's and not the Reel's.
4. **Given** a post with a Story target set for a non-Instagram account, **When** it is submitted
   through the API, **Then** it is refused with a message naming the types that account does offer.

---

### Edge Cases

- **A Story target's media stops being a single asset.** A second image is added to a post whose
  Instagram target was set to Story. The target publishes as the type its media shape resolves to — a
  carousel — the composer shows the type it will publish as, and the Story choice is remembered for if
  the post returns to a single asset. This matches how the existing Reel choice already behaves.
- **A 9:16 image on a target that is no longer a Story.** The same image that a Story accepts is
  outside the feed's aspect range, so as soon as the target is not a Story it is refused with the feed
  range in the message. The person is not left guessing why the same image became invalid.
- **The account's publishing allowance is exhausted.** A Story counts towards it like any other
  Instagram post. The attempt is deferred and retried later, not failed, and the Story is not published
  twice as a result.
- **Instagram reports the Story's container as already published.** The outcome is unknown, so the
  attempt ends ambiguous and is never retried automatically — a missed Story beats a duplicate Story.
- **The container expires before it can be published.** It is recreated and republished within the
  existing recreation cap; past that cap the attempt fails with nothing published.
- **Instagram cannot process the Story's media.** The attempt fails with what Instagram said about it,
  nothing is published, and the message says to check the asset rather than blaming Docket.
- **A post with no text at all on a Story target.** Nothing is dropped, so the text notice is not
  shown — the notice appears only when there is text (or an image description) that will be lost.
- **An asset with no stored dimensions on a Story target.** The cropping notice cannot be computed, so
  it is omitted rather than guessed; the Story still publishes and Instagram does its own fitting.

## Requirements *(mandatory)*

### Functional Requirements

#### Offering the post type

- **FR-001**: Instagram MUST offer `story` as a post type, and MUST offer it as a selectable
  alternative for a post whose Instagram-bound media is exactly one image or exactly one video.
- **FR-002**: For a single image, the per-account "Post as" choice MUST offer a feed post and a Story,
  defaulting to the feed post so that no existing post changes behaviour.
- **FR-003**: For a single video, the per-account "Post as" choice MUST offer Feed video, Reel and
  Story, keeping Feed video as the default.
- **FR-004**: The Story option's description MUST state plainly that a Story carries no caption, no
  link and no stickers, and MUST be shown wherever the choice is shown and wherever the chosen type is
  summarised.
- **FR-005**: The API MUST accept `story` in the per-account post-type map for an Instagram account,
  and MUST refuse it for an account whose provider does not offer it, with a message naming the types
  that provider does offer.
- **FR-006**: Instagram MUST NOT offer `story` for a post with no media or with more than one asset,
  and Facebook MUST NOT offer it at all.

#### Publishing

- **FR-007**: A Story target MUST publish its single asset as an Instagram Story through the same
  sequence the provider already runs for its other post types: create the media container, poll its
  processing status without blocking a tick, check the account's publishing allowance, then publish.
- **FR-008**: The sequence MUST be resumable across scheduler ticks and safe to kill mid-run, with the
  same container-expiry recreation, processing-time ceiling and retry behaviour the other Instagram
  post types have.
- **FR-009**: A Story publish whose outcome cannot be determined MUST end ambiguous and MUST NOT be
  retried automatically.
- **FR-010**: On success, the published Story's id MUST be recorded against the target in the same way
  every other Instagram post type records it.

#### Text and image description

- **FR-011**: A Story MUST be published without a caption. The post's text MUST never be sent on a
  Story request.
- **FR-012**: A Story MUST be published without an image description. The asset's alt text MUST never
  be sent on a Story request.
- **FR-013**: When a Story target's post has text, validation MUST raise a non-blocking notice, before
  scheduling, saying the text will not appear on the Story. It MUST NOT block scheduling, so that one
  post can target a Story and a captioned feed account at the same time.
- **FR-014**: When a Story target's asset has an image description, validation MUST raise a
  non-blocking notice, before scheduling, saying the description will not appear on the Story.
- **FR-015**: Both notices MUST be visible in the composer for that target and MUST be returned among
  that target's validation issues through the API, carrying a severity that marks them as non-blocking.

#### Asset shape

- **FR-016**: A Story image MUST NOT be held to the aspect-ratio range Instagram enforces for a feed
  image. A 9:16 image MUST be accepted for a Story.
- **FR-017**: A Story image whose shape is not 9:16 MUST be passed to Instagram unchanged. Docket MUST
  NOT crop it, pad it or letterbox it, and MUST NOT refuse it for its shape.
- **FR-018**: When a Story image's shape is not 9:16, validation MUST raise a non-blocking notice,
  before scheduling, that names the image's shape and says Instagram will crop it or show blank space.
- **FR-019**: A Story image MUST still be subject to the format, file-size, minimum-width and colour
  handling that every Instagram image is subject to, including the existing conversion, compression
  and downscaling notices.

#### Story video limits

- **FR-020**: A Story video MUST be held to the Story's own limits: 3 seconds minimum, 60 seconds
  maximum, 100 MB maximum, MP4 or MOV container, H264 or HEVC video, AAC audio, 23 to 60 frames per
  second, displayed shape between 0.1:1 and 10:1, with 9:16 as the recommended shape.
- **FR-021**: Every message about a Story video MUST quote the Story's limits, never the Reel's. A
  video longer than 60 seconds MUST be reported as being cut to 60 seconds.
- **FR-022**: A Story video MUST be adapted or refused by exactly the same rules the provider already
  applies to a Reel video, differing only in the limit values.

#### Surfacing the limits

- **FR-023**: The requirements summary shown for a Story target MUST report the Story's own media
  limits — including its aspect-ratio handling and video limits — rather than the feed's or the Reel's.
- **FR-024**: When a Story target's media is no longer exactly one asset, the target MUST publish as
  the type its media shape resolves to, the composer MUST show the type it will publish as, and the
  Story choice MUST be remembered in case the post returns to a single asset.

#### Accounting

- **FR-025**: Publishing a Story MUST count against the account's publishing accounting exactly as
  every other Instagram post does — both Docket's own per-account allowance and the limit read from
  Instagram at publish time. A Story MUST NOT bypass either.
- **FR-026**: When the allowance is reached, a Story attempt MUST be deferred and retried later rather
  than failed, and MUST NOT result in a duplicate Story.

#### Record keeping

- **FR-027**: The verified Story facts — container creation, the image specs, the video specs, the
  absence of caption, description and stickers, the read-back field that identifies a Story, and the
  publishing-limit accounting — MUST be recorded in the project's platform research notes with their
  official source URLs and the date they were checked.
- **FR-028**: The platform-limits ledger MUST gain a row for every Story limit this feature
  introduces, each naming its source and the place that enforces it.
- **FR-029**: The three judgement calls this spec settles — dropping the text, dropping the image
  description, and passing a non-9:16 image through — MUST be recorded in the project's decisions log.
- **FR-030**: User-facing documentation MUST say that Instagram Stories can be scheduled and what a
  Story does not carry.

### Key Entities

- **Post target**: an account a post goes to, carrying the chosen post type. `story` becomes a value it
  can hold for an Instagram account.
- **Media asset**: one image or video on a post, with its shape, size, format and image description.
  A Story uses exactly one, and ignores its description.
- **Publish state**: what a target has done so far in its publish sequence, including which kind of
  media it is publishing. It gains a story kind, and a state saved for one kind is never reused for
  another.
- **Capability declaration**: what a provider says it accepts — post types, text limits, media limits
  and per-post-type overrides. Instagram's gains the Story post type, the Story option descriptions,
  and the Story's image and video limits.
- **Publishing allowance**: the count of posts Docket has published to an account in a rolling window,
  plus the limit read from Instagram. Stories are counted in it like everything else.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A person can take an image already in the project, choose Story for an Instagram account
  and schedule it, in under a minute, without uploading anything new.
- **SC-002**: Every Story target with text or an image description shows, before scheduling, that the
  text and the description will not appear — 100% of them, in both the composer and the API.
- **SC-003**: A 1:1 image scheduled as a Story publishes successfully, and the person was told
  beforehand that Instagram would crop it or show blank space.
- **SC-004**: No Story Docket publishes carries a caption or an image description.
- **SC-005**: Every refusal or adaptation message for a Story video quotes the Story's limits
  (60 seconds, 100 MB); none quotes the Reel's.
- **SC-006**: A Story attempted when the account's publishing allowance is exhausted is deferred and
  later published once, never failed outright and never published twice.
- **SC-007**: A 9:16 image is accepted for a Story and refused for a feed post, each with an
  explanation naming the limit that applies.
- **SC-008**: No Facebook account offers a Story option anywhere in the product or the API.
- **SC-009**: Adding the Story post type changes no behaviour of an existing Instagram image,
  carousel, feed video or Reel post: all of their existing checks still pass unchanged.
- **SC-010**: Every Story limit and behaviour claimed here is demonstrated against a mocked Instagram,
  including the processing-still-running, processing-failed, container-expired and unknown-outcome
  paths. No live Instagram call is made by any check.

## Decisions settled by this spec

The feature description asked for three questions to be answered here rather than left implicit.

### D1 — A Story target ignores the post's text; it does not require the post to be text-free

**Decision**: the text is simply not sent on a Story, and the person is told so before scheduling by a
non-blocking notice on that target. A post with a Story target is **not** required to be text-free.

**Why**: a Docket post is one piece of content fanned out to several accounts from one base text.
Requiring a Story target's post to be text-free would make it impossible to schedule the same image as
a captioned Facebook post and an Instagram Story together, which is the normal case. Blocking would
also be a refusal for something the platform is perfectly happy to publish. The risk the description
names — someone scheduling a Story expecting a call to action — is answered by stating the rule up
front rather than by refusing the post.

**How it is surfaced**: the Story option's own description says a Story carries no caption, no link and
no stickers (FR-004); a per-target notice names the text that will be dropped (FR-013); the notice is
in the composer and in the API's per-target issues (FR-015).

### D2 — A Story target ignores the asset's image description, with the same notice treatment

**Decision**: alt text is not sent on a Story, and a non-blocking notice says so before scheduling.

**Why**: the platform accepts no description on a Story, and Docket attaches one to every asset, so
something is always being dropped. Refusing a Story because its asset is described would be perverse —
the description is correct and useful everywhere else the asset is used. Silence is the only
unacceptable option, and the notice removes it.

### D3 — A non-9:16 image is passed through to Instagram's own cropping, not rejected and not letterboxed

**Decision**: pass the image through unchanged, and raise a non-blocking notice naming its shape and
saying Instagram will crop it or show blank space.

**Why**, against the two alternatives:

- *Rejected at validation* would be wrong on the facts. The platform documents 9:16 only as a
  recommendation — "We recommended 9:16 to avoid cropping or blank space" — and states no hard
  aspect-ratio limit for an image Story. Refusing an image the platform accepts would also make the
  feature useless for this project, where every image is 1:1.
- *Letterboxed by Docket* would mean inventing a crop or a pad. Docket's image handling converts,
  downscales and compresses but has never cropped or padded an image, and choosing a background colour
  or a crop box on the person's behalf is a content decision Docket is not entitled to make silently.

Passing through is also the one option that keeps the two consequences visible: Instagram either crops
or pads, and the notice says exactly that, so the person can supply a 9:16 asset if they care.

**Note**: this applies to the image aspect ratio only. A Story **video** has a documented hard range
(0.1:1 to 10:1) and is adapted or refused by the rules already in place for Reels (FR-020, FR-022).

## Out of Scope

- **Facebook Page Stories.** Nothing in the project's platform research covers them and their API has
  not been verified, so their behaviour must not be inferred from Instagram's. Facebook offers no Story
  option as part of this feature (FR-006).
- **Stickers, links, polls and location on a Story.** The platform states publishing them is not
  supported. Docket offers none of them, and says so.
- **Reading a Story back after publishing** — views, replies, expiry after 24 hours, or anything that
  needs the field that identifies a published Story as a Story. The field is recorded in the research
  notes (FR-027) so a later feature can use it; nothing in this feature reads it.
- **Carousel or multi-asset Stories.** A Story takes one asset.
- **Changing how an existing Instagram image, carousel, feed video or Reel behaves.**
- **New media tooling.** No cropping, padding or 9:16 generation is added; see D3.

## Assumptions

- **The platform facts are those verified on 2026-10-16** and listed in the feature description:
  container creation with a story media type and an image or video URL followed by the existing
  publish call; image Stories JPEG only, 8 MB maximum, sRGB, 9:16 recommended; video Stories MOV or
  MP4, 3 to 60 seconds, 100 MB maximum, 23 to 60 FPS, H264 or HEVC, AAC, 0.1:1 to 10:1 with 9:16
  recommended; no caption, no description, no stickers; and Stories counting against the publishing
  limit. These are recorded with their source URLs as FR-027 requires, and anything the official
  reference does not state is treated as unverified rather than guessed.
- **A Story image keeps Instagram's general image handling** for format, file size, minimum width and
  colour space, because the reference states no Story-specific values for those. Only the aspect-ratio
  range is Story-specific. If a later check finds Story-specific width limits, they are a change to
  this one declaration.
- **The existing publishing-limit reading is reused unchanged.** The project's research already records
  the contradiction between the documented 50 and 100 per rolling 24 hours and resolves it by reading
  the account's limit at publish time; Stories inherit that resolution rather than reopening it.
- **The post type is set per account on an existing post**, through the composer's per-account choice
  and through the per-account post-type map the API already accepts. No new way of setting it is
  introduced.
- **This is an added post type on a working integration, not a new integration.** The account
  connection, token handling, scheduling, approval, retry and activity history all apply to a Story
  unchanged.
- **No live platform call is made by any check.** Everything is demonstrated against mocked HTTP, and
  reported as verified with mocks only.

## Facts recorded against the research notes

Two things in the project's existing notes are superseded or completed by this feature and must be
corrected rather than left to contradict it, as the project's rule on verified facts requires:

- The video research notes describe the Story video specification as "not needed by Docket". It is now
  needed; the parenthetical goes, and the specification becomes a first-class entry with its source.
- The project's governing principles list stories among the things that are out of scope "until a spec
  says otherwise". This is that spec, for Instagram Stories only. Facebook Page Stories remain out of
  scope.
