# Contract: the records this feature must leave behind

FR-027 to FR-030 and the spec's "Facts recorded against the research notes" are requirements, not
housekeeping. Each item below is checked by a test or by a doc test that already exists.

## N1. `docs/research/meta.md` - a Story section (FR-027)

Added, with source URLs and "checked 2026-10-16":

- Container creation: `POST /{ig-id}/media` with `media_type=STORIES` plus `image_url` or `video_url`,
  then `POST /{ig-id}/media_publish` with `creation_id`.
  Source: the ig-user/media reference and the content-publishing page.
- No `caption`, no `alt_text`, and no stickers, links, polls or locations on a Story.
- Image Story: no Story-specific format, size, width or colour value is published, so the general
  Instagram image handling applies (JPEG, 8 MB, 320-1440 px, sRGB). **9:16 is a recommendation**:
  "We recommended 9:16 to avoid cropping or blank space"; no hard aspect range is stated.
- Stories count against `content_publishing_limit` like any other post, and each container counts
  against the 400-per-24-h creation cap.
- The read-back field that identifies a Story is `media_product_type` (a reel reads back as
  `media_product_type=REELS`); **the Story value is `NEEDS RESEARCH` / UNVERIFIED** and nothing reads
  it (K17).

## N2. `docs/research/meta-video.md` - the Story video spec becomes first-class (spec closing section)

The line "Story video (not needed by Docket): MOV/MP4, 3 to 60 s, 100 MB max, ratio 0.1:1 to 10:1"
loses its parenthetical and becomes its own entry under the Instagram section, with its source URL, the
check date, and a note that the remaining values (H264/HEVC, AAC, 23-60 FPS, 9:16 recommended) are the
Reel specs the Story inherits in Docket's declaration.

## N3. `docs/limits.md` - a row per Story limit (FR-028)

Exactly the eight rows in `contracts/capabilities.md` C5, each naming its source, its enforcement point
and the test that breaks it. `tests/integration/docs/limits-inventory.test.ts` fails if a row is
missing, extra, differently valued, unsourced, unenforced or cites a test that does not exist - and its
UNVERIFIED list must name `story min aspect` and `story max aspect`.

The "How to read a row" preamble gains the three per-post-type image categories
(`<type> min aspect`, `<type> max aspect`, `<type> recommended aspect`) alongside the existing
per-post-type video ones.

## N4. `docs/decisions.md` - a `## 078 - Instagram Stories (2026-10-16)` entry (FR-029)

Must record, each with its rationale and what was rejected:

- **D1** the post's text is dropped, not refused (spec D1);
- **D2** the asset's description is dropped, with the same notice treatment (spec D2);
- **D3** a non-9:16 image is passed through to Instagram's own cropping, neither refused nor letterboxed
  (spec D3) - and that it follows the precedent set by Pinterest's "No hard aspect range" (entry 072, K12);
- **K5/K6** per-post-type image limits as a declaration (`media.byPostType`) rather than a flag;
- **K8** the aspect bounds leave `constraintsHash`, so a Story and a feed post share one variant - with
  the one-time lazy rebuild of existing variants stated plainly;
- **K11** a story target drops `missing_alt_text` and `alt_text_too_long`;
- **K16** a `STORIES` container reads `status` so an `ERROR` can say what Instagram said;
- **K1** `PostShape` gains `single_image`, and why that is the plug-in boundary working rather than
  being bypassed;
- the constitution amendment (stories no longer blanket out of scope; Instagram only).

## N5. User documentation (FR-030)

| File | Change |
|---|---|
| `docs/feature-map.md` | an "Instagram Stories (078)" entry: image and video Stories, chosen per post in the composer, no caption, no link, no stickers, no cropping by Docket; verified with mocks only; not yet owned - Facebook Page Stories, stickers and links, reading a Story back, multi-asset Stories |
| `docs/accounts.md` | in the Instagram section: a Story can be scheduled for a single image or video, and what it does not carry |
| `docs/adding-a-provider.md` | the `single_image` shape and `media.byPostType` / `ImageLimitOverrides` (also required by `tests/integration/docs/provider-guide.test.ts`, which demands every `ProviderCapabilities` member name appear in an inline code span), and the Instagram section's post-type paragraph gains the Story |

No new documentation page, so `mkdocs.yml` and the published-docs link checks are untouched (they run
in CI only).

## N6. `.specify/memory/constitution.md`

The Engineering Constraints line "Out of scope until a spec says otherwise: video, stories, reels, ..."
is amended so that stories are out of scope **except Instagram Stories (078)**; Facebook Page Stories
stay out of scope. Governance requires a `docs(constitution):` commit and a version bump: 1.4.0 ->
1.5.0, with "Last Amended" set to 2026-10-16.
