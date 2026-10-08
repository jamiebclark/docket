# Research: Facebook Page video

Phase 0 for `specs/021-facebook-video/spec.md`. External facts come only from `docs/research/meta-video.md` (Facebook Pages section) and `docs/research/meta.md`; this phase cannot fetch the web. Code facts (F*) were read from the repository on branch `021-facebook-video` (base `0839858`, entries 018 and 019 merged). Plan decisions (P*) settle every open point in the spec.

No item in Technical Context is left as NEEDS CLARIFICATION. Three external facts stay UNVERIFIED by design: the status reply's nesting (P9), the upload reply's body (P7) and the values of the per-phase `status` fields (P9). Each is read conservatively, kept in one named function, covered by mocked tests, and listed as an owed live check (FR-031).

## Code facts

- **F1 — Facebook's step machine today.** `src/providers/facebook/steps.ts` `facebookStepFor(state, content)` reads only `content.mediaCount`: 0 → `publish_feed`, 1 → `publish_photo`, N → `upload_photo_1..N` then `publish_feed`. State is `{ v: 1, photoIds: string[] }` (`settings.ts`), and anything that fails to parse gives `invalid`. `index.ts` passes the engine's `StepContent` through unchanged, so `kinds` and `postType` (019) already reach it.
- **F2 — `advanceFacebook` re-derives the step.** It recomputes `facebookStepFor(ctx.state, { text, mediaCount })` and fails "The post changed while publishing." on a mismatch. Whatever `stepFor` reads must also be readable from `PublishContext` (`content.media[].kind`, `ctx.postType`).
- **F3 — Facebook declares no video.** `capabilities.ts` has `video: { maxVideos: 0 }` and `postTypes: ["text", "image", "carousel"]`, with no `postTypeChoices` and no `creationAllowance`. `docs/limits.md` has a `facebook: videos` row with value 0.
- **F4 — Graph client.** `src/providers/meta/graph.ts` `graphRequest(app, req)` builds `graphBase[/version]/path` and refuses a path that is not `/` plus numeric ids or lowercase words. POST sends a form body with `access_token`. It returns a `GraphOutcome` (`ok`, `graph_error`, `http_error`, `unparseable`, `network` with `before_send | after_send`). The private `send(url, init)` does the fetch and parse. There is no way to call a host other than `graphBase`, or to send custom headers.
- **F5 — Error mapping.** `graphStepError(outcome, { mayPublish, platform, secrets })` (`meta/errors.ts`):
  - code 190 → fatal with `credentialsInvalid`;
  - rate-limit codes → retryable, whatever `mayPublish`;
  - temporary codes and 5xx → ambiguous if `mayPublish`, else retryable;
  - anything else → fatal, with Meta's message scrubbed.
  - A network failure after sending, or an unreadable 2xx, is ambiguous when `mayPublish`, else retryable.
- **F6 — Engine retry bookkeeping.** `applyStepResult` (`src/server/scheduler/record.ts`):
  - `continue` resets `attemptCount` to 0, clears `lastError` and sets `nextAttemptAt = max(now, notBefore)`;
  - `retryable_error` increments `attemptCount`, and at `maxAttempts` (default 8) the target becomes **failed**;
  - `ambiguous` and `fatal_error` settle the target.
- **F7 — Engine-side outcomes.** In `execute` (`src/server/scheduler/publishing.ts`) the engine itself settles a target in several cases:
  - **fatal**, before the provider is called: missing media (`MediaUnavailable`), a vanished post, the G15 re-check (first step only), unreadable credentials, invalid settings;
  - **retryable**: media not ready, or "Publishing could not start";
  - a call lost to its own timeout race (`withTimeout`): **ambiguous** if the lease `mayPublish`, else **retryable**.
  - Stale-lease recovery (`recovery.ts`) settles **ambiguous** when `inFlightMayPublish`, else it retries and **fails** at `maxAttempts` ("Publishing was interrupted too many times.").
  - Nothing in the engine knows that a step *after* a publishing step must never end failed.
- **F8 — Credentials flagging.** The engine flags an account (`markInvalidEmitting`) and prefixes "Reconnect … to publish:" only for `fatal_error` with `credentialsInvalid`. The `ambiguous` variant of `StepResult` has no such member.
- **F9 — G19 to G22 are generic and in place (019).** These are already built:
  - `resolvePostType` and `choiceFor` (`src/providers/post-type.ts`);
  - `post_targets.chosen_post_type`;
  - `videoLimitsFor` and the `byPostType` merge (`validation.ts`);
  - `minFrameRate`;
  - the registry consistency checks (`media.ts`, which needs `byPostType` keys in `postTypes`, choice options in `postTypes`, and the default among the options);
  - the claim-transaction allowance (`publishing.ts` lines 159–180: `units` on a first run, `retryUnits` when `attemptCount > 0`) and the `allowance_uses` table.
  - The composer's "Post as" fieldset and the API's `postTypes` derive from the declaration only.
- **F10 — Requirements notes are carousel-only.** `requirementsOf` (`src/providers/requirements.ts`) sets `video.notes` to the carousel notes when the shown type is `carousel`, and to `[]` otherwise. A `byPostType.reel.notes` or `byPostType.video.notes` would not be shown.
- **F11 — Validation of a Facebook video post.** With `maxVideos > 0` declared:
  - a single video resolves to `video` or `reel`;
  - two items resolve to `carousel`, with the base limits (`videoLimitsFor(caps, "carousel")`), which give `too_many_videos` or `video_with_images` with generic wording;
  - `validateFacebook` is the bare shared validator.
- **F12 — Edits while publishing.** `updatePost` and the composer refuse edits when any target is `publishing`, `published` or `ambiguous` (`STARTED` in `services/posts/index.ts` and `compose.ts`). So the media and the choice cannot normally change mid-flight. D14's restart is defensive, as in 019.
- **F13 — Test harness.** `tests/helpers/fake-graph.ts` stubs `fetch` globally. It records `method`, `path`, `host`, the params (with `access_token` redacted) and `hadToken` (an `authorization` header counts), and routes on `METHOD path` regardless of host. It does not record headers or body size. `tests/helpers/facebook-publish.ts` `metaSetup` builds a Page account with token `PAGE_TOKEN`. `instagramVideoSetup` (`instagram-publish.ts`) shows how to attach ready videos (`createVideoAsset`) and set `chosenPostType`.
- **F14 — Provider guide test.** `tests/integration/docs/provider-guide.test.ts` parses `src/providers/types.ts` and fails if a contract member is not in `docs/adding-a-provider.md`. It also checks the listed G numbers, so a new member must be documented in the same change.
- **F15 — Publish duration.** `PUBLISH_MAX_DURATION_HOURS` defaults to 24 h. The longest Reel path is about 90 min (30 min upload ceiling plus 60 min publish ceiling).

## Plan decisions

### Capabilities (spec D1–D4, D15; FR-001, FR-002, FR-016, FR-017)

- **P1 — Declaration shape.**
  - The **base `video` block holds the Page video limits** (D4): `maxVideos: 1`, `withImages: false`, `containers: ["mp4", "mov"]`, and nothing else.
  - **`byPostType.reel`** holds the Reel limits (D3):
    - `videoCodecs: ["h264", "hevc", "vp9", "av1"]`, `audioCodecs: ["aac"]`, `silentAllowed: true`;
    - `minDurationSeconds: 3`, `maxDurationSeconds: 90`;
    - `minWidth: 540`, `minHeight: 960`;
    - `minAspectRatio: 0.556`, `maxAspectRatio: 0.569`;
    - `minFrameRate: 24`, `maxFrameRate: 60`;
    - its notes.
  - **`byPostType.video`** carries only notes.
  - `postTypes` becomes `["text", "image", "carousel", "video", "reel"]`, and one `postTypeChoices` entry is added for `single_video` with default `video`.
  - *Why the base is the Page video:* the fit badge, a carousel-shaped post and an unchosen video then use the permissive limits without special cases (FR-022, D2).
  - *Rejected:* putting the Reel limits in the base, as Instagram does. Every badge and every two-item check would then be judged by Reel rules.
- **P2 — Wording** (`validateFacebook`).
  - **Video refusals.** Every `video_*` refusal except `video_not_accepted` is rewritten to "<generic message, without its full stop> for a Facebook <label>. Docket does not crop, trim or convert video yet." The label comes from `postTypeLabel`: "Reel" or "Page video".
  - **Aspect, for a Reel.** A Reel aspect refusal says "Video 1 is <ratio>; Facebook Reels must be 9:16 (vertical). Docket does not crop video yet."
  - **Suggesting a Page video.** When the type is `reel` and the same post re-validated as `video` has no `video_*` error for that item, the refusal ends "Post it as a Page video instead." (FR-018, US5-1).
  - **Mixed or multiple media.** `too_many_videos` and `video_with_images` become "A Facebook post can carry one video and no images." (FR-002, D15), with code and field kept.
  - **Untouched.** Image and text issues are not changed (FR-019).
- **P3 — Notes in the summary** (a generic fix to G20). `requirementsOf` shows `byPostType[shown].notes` for whichever type is shown, not only `carousel`. Instagram declares notes only on `carousel`, so its summaries are unchanged; a test pins this. The notes are:
  - **Reel:**
    - "9:16 (vertical) only."
    - "Facebook publishes no size limit for Reels; Docket's upload limit applies."
    - "Facebook allows 30 Reels per Page a day."
  - **Page video:** "Facebook publishes no length or size limits for Page videos; Docket's upload limits apply."
- **P4 — Creation allowance** (G22, D10). `facebookProvider.creationAllowance = { count: 30, windowSeconds: 86_400, name: "Facebook's daily Reels allowance" }`. Only `start_reel` returns `allowance: { units: 1, retryUnits: 1 }`. The engine's existing message reads: "Waiting for Facebook's daily Reels allowance (30 of 30 used in the last 24 hours); nothing was created." That covers FR-014's "how many are used" with no engine change.

### Publishing (spec D5–D9, D11–D14; FR-003–FR-013, FR-015)

- **P5 — Step names and flags.**
  - **Page video:** `publish_video` (`mayPublish: true`, no state).
  - **Reel:**
    - `start_reel` (`mayPublish: false`, allowance 1/1);
    - `upload_reel` (`mayPublish: false`);
    - `check_upload` (`mayPublish: false`);
    - `finish_reel` (`mayPublish: true`);
    - `check_publish` (`mayPublish: false`, **`afterPublish: true`**, P12).
  - **Image steps:** `publish_feed`, `publish_photo` and `upload_photo_<n>` stay byte-for-byte as they are (FR-019).
- **P6 — State.**
  - **A union, still `v: 1`.** The existing photo shape `{ v: 1, photoIds }` stays, so in-flight multi-photo targets resume (FR-019). A Reel shape is added: `{ v: 1, kind: "reel", videoId, uploadUrl, startedAt, uploadedAt, uploadComplete, uploadChecks, finishedAt, publishChecks }` (data-model §3).
  - **Page video:** it is one request, so it saves no state. Its "kind" is the leased step itself (FR-013).
  - **Re-deriving the step.** `facebookStepFor` reads `kinds` and `postType` from `StepContent`, and `advanceFacebook` reads them from `ctx.content.media[].kind` and `ctx.postType` (F2).
- **P7 — Upload request** (D5, D13; FR-007).
  - **New function.** `ruploadRequest` in `src/providers/meta/graph.ts` reuses `send`. It sends `POST <checked uploadUrl>` with headers `Authorization: OAuth <token>` and `file_url: <public url>`, and no body. It returns a `GraphOutcome`.
  - **The address check** (`checkUploadUrl` in `facebook/requests.ts`, pure) runs before any request. It needs:
    - an absolute URL with protocol `https:`;
    - hostname equal to the upload host (default `rupload.facebook.com`), no port, no user info, no query, no fragment;
    - a path of `/video-upload/<videoId>` or `/video-upload/v<n>.<n>/<videoId>`, with `<videoId>` equal to the saved id.
  - **Replies.** The reply body is UNVERIFIED in the research, so it is not relied on:
    - any 2xx, readable or not, → `continue` to `check_upload`, which is authoritative;
    - a network failure, 5xx or 429 → retryable;
    - code 190 → fatal with `credentialsInvalid`;
    - any other refusal → fatal, with Facebook's message plus the storage reminder.
  - *Rejected:* retrying an unreadable 2xx. Whether re-sending `file_url` for the same video id is safe is unknown.
- **P8 — The upload host is replaceable.** `MetaApp` gains an optional `uploadHost` (default `rupload.facebook.com`), used only by the address check. The fake Graph stubs `fetch` globally, so tests use the default host and assert on `host` (FR-015, SC-007).
- **P9 — Reading the status** (UNVERIFIED nesting; spec Assumptions).
  - **One pure function.** `readReelStatus(body)` in `facebook/requests.ts` returns `{ videoStatus, uploading, processing, publishing, publishStatus, detail }`, each a lower-cased string or null.
  - **Shapes accepted.** It reads `body.status.video_status`, and the phase objects `body.status.uploading_phase.status`, `processing_phase.status`, `publishing_phase.status` and `publishing_phase.publish_status`. A body without a `status` object reads as all null.
  - **The detail** is the first `message` of an `errors` array in any phase, with control characters removed and capped at 300 characters, then `scrub`bed with the token.
  - **Classification.** The `classify*` helpers below are written so that an unknown value is never "complete", "published" or "failed":
    - *upload complete:* `uploading === "complete"`, or `videoStatus` ∈ {`upload_complete`, `processing`, `ready`};
    - *upload failed:* `videoStatus` ∈ {`error`, `upload_failed`, `expired`}, or `uploading === "error"`;
    - *published:* `videoStatus === "ready"`, and `publishing === "complete"` or `publishStatus === "published"`;
    - *processing failed:* `videoStatus` ∈ {`error`, `expired`, `upload_failed`}, or `processing === "error"`, or `publishing === "error"`;
    - *anything else:* not yet.
  - *Why a `ready` alone is not "published":* a Reel that is ready but not confirmed published must not be reported live. If the live check shows `ready` alone means published, the change is one line, and until then such a Reel ends ambiguous at 60 min, which is safe.
- **P10 — Pace and ceilings** (D8; FR-011; SC-004, SC-005).
  - **Constants** in `facebook/state.ts`: `CHECK_FIRST_MS = 60_000`, `CHECK_SLOW_AFTER_MS = 300_000`, `CHECK_SLOW_MS = 300_000`, `UPLOAD_CEILING_MS = 30 * 60_000`, `PUBLISH_CEILING_MS = 60 * 60_000`.
  - **The interval** is `checkDelayMs(ageMs) = ageMs < CHECK_SLOW_AFTER_MS ? CHECK_FIRST_MS : CHECK_SLOW_MS`. The age is measured from `uploadedAt` or `finishedAt` on `ctx.now` (the DB clock).
  - **Check counts.** Upload checks fall at 1, 2, 3, 4, 5, 10, 15, 20, 25 and 30 min, which is 10. Publish checks fall at 1–5 and then 10–60 min, which is 16.
  - **The ceiling is tested after the read,** so a final read that shows completion still wins.
  - *Not shared with Instagram:* Facebook has its own constants, so the two can be tuned apart. Instagram's files are not touched.
- **P11 — "Check again" is a `continue`, never a `retryable_error`.** Every not-yet result, and every transient or unreadable read, returns `continue` with the same plan, `checks + 1` and a `notBefore` at the pace. That keeps checks out of `attemptCount` (F6), so only the ceiling ends a check. The cases are:
  - for `check_upload`: uploading, an unreadable reply, a network failure, 5xx, 429 and rate-limit codes;
  - for `check_publish`: all of those, plus any Graph refusal other than code 190.
  - **Rejected token.** At `check_upload`, code 190 is fatal with `credentialsInvalid` (nothing published). At `check_publish` it is `ambiguous` with `credentialsInvalid` (P13).
  - **Any other refusal.** At `check_upload` it is fatal with Facebook's message (nothing published).
- **P12 — Steps after publishing** (generic change G23; D9; FR-010; SC-003).
  - **The member.** `StepInfo.afterPublish?: true` marks a step that runs after a step that may publish was sent. It needs `mayPublish: false`.
  - **What the engine does for such a lease.** Every outcome the engine itself would record as **failed** becomes **ambiguous**, with " The post may already be live; check before retrying." appended:
    1. engine-side fatal results before the call (missing media, unreadable credentials, invalid settings);
    2. a `retryable_error` that reaches `maxAttempts` (in `applyStepResult`, through a new `afterPublish` input);
    3. stale-lease recovery at `maxAttempts`. The claim re-derives the step with `provider.stepFor` only in that rare branch, then settles **ambiguous**.
  - **Unchanged:** a provider's own `fatal_error` (Facebook reporting an error) still fails, and a lost call still returns `retryable_error`, which is checked again.
  - *Why generic:* the engine, not the provider, makes these decisions (F7). Without it, eight consecutive engine timeouts or interruptions on `check_publish` would fail a Reel that may be live, breaking D9.
  - *Rejected:* marking `check_publish` as `mayPublish: true`. A killed worker would then settle it ambiguous instead of resuming (US3-8), and FR-005 says only finish may publish.
  - *Rejected:* a lease column. The flag is only needed in the rare recovery branch, so re-deriving it costs nothing on the hot path, and no migration is needed.
- **P13 — An ambiguous result may flag the account** (G23, second part; FR-010, Edge Cases). The `ambiguous` variant of `StepResult` gains `credentialsInvalid?: true`. The engine then flags the account exactly as for a fatal result (`markInvalidEmitting`, with the same expected ciphertext), sets the target **ambiguous**, and appends " Reconnect <account> to publish again." to `lastError`. Fatal handling is unchanged.
- **P14 — Unreadable or out-of-date state** (D14; FR-013).
  - **Before finish.** When the state is a valid Reel state with `finishedAt === null`, but the content is no longer exactly one video or the resolved type is no longer `reel`, `facebookStepFor` restarts:
    - to `start_reel` when the type is still `reel` but the state no longer fits;
    - else to the content's own first step (`publish_video`, `publish_photo`, …) with state ignored.
    - The abandoned start stays counted (D10).
  - **After finish.** Once `finishedAt` is set, the step is **always** `check_publish`, whatever the content, so a second finish is impossible.
  - **Unparseable state on a video post.** Non-null state on a video post that matches neither shape returns `{ name: "invalid", mayPublish: false, afterPublish: true }`. `advanceFacebook` then answers **ambiguous**: "Docket could not read this Reel's saved progress; check the Page before retrying." Never failed, never a second finish.
  - **Unchanged.** Unparseable state on an image post keeps today's `invalid` → fatal.
- **P15 — Page video request** (D6, D11, D12; FR-003, FR-004).
  - **The request:** `POST /{page}/videos` with `file_url=<public url>`, plus `description=<text>` when the text is not empty. Nothing else is sent: not `published` (Facebook's default is true, and today's tests assert `published` is never sent on a publishing request), not `title`, not `thumb`, not `scheduled_publish_time`.
  - **Replies:**
    - an `id` → `done` with the video id, and no URL;
    - a 2xx without an id → ambiguous;
    - code 389 → fatal with " Facebook could not fetch the video. Media storage must be publicly readable (see <storage doc>)." appended;
    - everything else through `graphStepError` with `mayPublish: true`.
- **P16 — Reel requests.**
  - **Start:** `POST /{page}/video_reels` with `upload_phase=start`.
    - A `video_id` and `upload_url`, both strings → `continue` with `startedAt` and no wait.
    - Either one missing → retryable.
    - Errors go through `graphStepError` (`mayPublish: false`): rate limits are retryable, refusals fatal.
  - **Finish:** `POST /{page}/video_reels` with `upload_phase=finish`, `video_id`, `video_state=PUBLISHED`, and `description` when the text is not empty.
    - `success === true` → `continue` with `finishedAt = now` and `notBefore = now + 60 s`.
    - Any other 2xx → ambiguous.
    - Errors go through `graphStepError` (`mayPublish: true`), so 1363040, 1363127, 1363128, 1363129 and 100 are fatal with Facebook's message.
  - **Status reads:** `GET /{videoId}?fields=status` with the token as `access_token`, through `graphRequest`. The path is a numeric id.
  - **Never sent:** no `title`, `place`, `scheduled_publish_time`, thumbnail or `DRAFT`/`SCHEDULED` (D12).
- **P17 — Messages** (spec text kept exactly where it gives one).
  - **Upload refused, or upload check failed:** "Facebook could not receive the video<: detail>. Nothing was published. Media storage must be publicly readable (see <storage doc>)."
  - **Upload ceiling:** "Facebook did not receive the video within 30 minutes; nothing was published."
  - **Publish check failed:** "Facebook could not process the Reel and it was not published<: detail>. Check its shape (9:16), length (3–90 s), frame rate (24–60 fps), resolution (at least 540 × 960) and codec."
  - **Publish ceiling:** "Facebook accepted the Reel but did not confirm it was published within 60 minutes; check the Page before retrying."
  - **Token rejected after finish:** "Facebook rejected the Page token after the Reel was sent; check the Page before retrying."
  - **Bad upload address:** "Facebook returned an unexpected upload address; nothing was sent or published."
- **P18 — Attempt summaries** (FR-012).
  - **Request side:** `{ step, kind: "reel" | "video", videoId? }`. A Reel upload adds `uploadHost` (never the token or the full address).
  - **Response side:** `graphSummary(outcome)`, plus for status reads `{ videoStatus, uploadingStatus, processingStatus, publishingStatus, publishStatus, checks, statusDetail? }`, each scrubbed.
  - **Token.** `no-secrets.test.ts` gains a Reel flow where every reply and error echoes the token.

### Docs, deployment and tests (FR-023–FR-031)

- **P19 — `docs/limits.md`.**
  - **Base rows.** The Facebook `videos` row becomes 1, and `video with images` (no) and `video containers` (mp4, mov) are added.
  - **Reel rows,** prefixed `reel`:
    - `reel video codecs`, `reel audio codecs`, `reel silent video`;
    - `reel min duration`, `reel max duration`;
    - `reel video min width`, `reel video min height`;
    - `reel video min aspect`, `reel video max aspect`;
    - `reel min frame rate`, `reel max frame rate`.
    - The exact category strings follow the inventory test's prefix rule.
  - **Allowance row:** `creation allowance` with `30 / 86400 s`.
  - **Notes:**
    - `note: Facebook Page video limits are not published`;
    - `note: Facebook Reel file size is not stated`;
    - `note: Facebook Reel polling ceilings (30 min upload, 60 min publish)`.
  - Each row has its source, its enforcement point and its generated test. Both inventory tests already handle `byPostType` and `creationAllowance` (F9).
- **P20 — No `docker-compose.yml`, `.env.example` or migration change** (FR-028). G23 is code-only. `chosen_post_type` and `allowance_uses` exist already.
- **P21 — Fake Graph.** `GraphRequest` gains `headers` (lower-cased names, with `authorization` replaced by `[redacted]`) and `bodyBytes` (the body's length, 0 when there is none). This is additive, so existing tests are unchanged. Routes still key on method and path; the rupload path `/video-upload/<id>` cannot collide with a Graph path.
- **P22 — Test helper.** `facebookVideoSetup(storage, text, opts)` goes in `tests/helpers/facebook-publish.ts`. It builds one ready video (default 1,920 × 1,080, 20 s, 30 fps, H.264/AAC; overridable), stores the object, and sets `chosenPostType` (with `setPostType` for later changes), mirroring `instagramVideoSetup`.
