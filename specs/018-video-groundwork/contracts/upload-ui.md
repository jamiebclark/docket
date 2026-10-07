# Contract: shared upload UI and client engine

Decisions P12–P15 and P29 in [../research.md](../research.md). Follow the `docket-ui` skill: keyboard first, visible focus, labelled controls, text before colour, and no tooltips.

## Modules

| File | Kind | Role |
|---|---|---|
| `src/lib/media/sniff.ts` | pure, client-safe | `sniffMedia(bytes)`, shared with the worker (P12) |
| `src/lib/upload/precheck.ts` | pure | `precheck(file facts, limits)` → `{ ok } \| { ok: false, code, values }` (P13) |
| `src/lib/upload/milestones.ts` | pure | `milestonesCrossed(prevPct, pct)` → `(0 \| 25 \| 50 \| 75 \| 100)[]` |
| `src/lib/upload/engine.ts` | pure | `createUploadEngine(deps)`: the queue and state machine (P14) |
| `src/lib/upload/xhr-transport.ts` | browser | `xhrTransport.sendPart(url, blob, { onProgress, signal })` |
| `src/components/media/upload/read-video.ts` | browser | off-DOM `<video>` metadata reader with a 10 s timeout |
| `src/components/media/upload/upload-ui.ts` | pure | wording: refusal messages, row status text, announcements, help text, byte labels |
| `src/components/media/upload/UploadPanel.tsx` | client | drop area, button, help text, live region, rows; `beforeunload`; status polling |
| `src/components/media/upload/UploadRow.tsx` | client | one file's row |
| `src/app/p/[projectSlug]/media/UploadDropzone.tsx` | client | thin wrapper: `<UploadPanel slug limits transport />` |
| `src/components/media/MediaPicker.tsx` | client | `<UploadPanel … onUploaded={attach} />` replaces its own loop |

`engine.ts` has these dependencies, all injected:

- `actions`: `createUpload`, `signUploadParts`, `listUploadedParts`, `completeUpload`, `cancelUpload` and `status`, bound to `slug`;
- `transport`;
- `readVideo(file)`;
- `readHead(file)` (the first 64 bytes);
- `limits`, the served `LibraryLimits`;
- `clock`, with `setTimeout`.

It exposes `add(files)`, `retry(id)`, `cancel(id)`, `subscribe(fn)`, `snapshot()` and `active()`, where `active()` is true while any row is checking, waiting or uploading.

## Row states (FR-002)

| State | Text shown on the row | Controls |
|---|---|---|
| `checking` | "Checking…" | Cancel |
| `refused` | "Not uploaded: {reason}" | Dismiss |
| `waiting` | "Waiting" | Cancel |
| `uploading` | progress bar + "{sent} of {total} ({pct} %)" | Cancel |
| `interrupted` | "Upload interrupted: {reason}" | **Retry**, Cancel |
| `cancelled` | "Cancelled" | Dismiss |
| `processing` | "Processing: reading the video" / "Processing: making the poster frame" / "Processing" (queued, or an image) / "Processing is waiting for the worker" (`waitingForWorker`) | none |
| `ready` | "Ready" (the picker adds "added to the post") | none |
| `failed` | "Failed: {reason}" | Dismiss |

When the browser could not read a video's metadata, an `uploading` or `processing` row also says "Checks happen after upload" (FR-005).

**Interrupted reasons** (FR-007), each set on that row only:

- "the connection was lost" (network);
- "Docket refused it: {message}" (a 4xx from an action, e.g. `upload_finished`);
- "You no longer have access to this project" (`not_found` from an action);
- "Storage refused the upload" (403 after one re-sign, or 5xx);
- "Some parts did not arrive. Retry to send them." (`parts_missing`).

Every button names its file. Retry, for example, has `aria-label="Retry {filename}"`, and Cancel and Dismiss follow the same pattern (SC-010). Buttons are real `<button type="button">` elements in DOM order after the row's text, reachable by Tab, with a visible focus ring.

## Progress and announcements (FR-003, SC-010)

The progress bar is:

```html
<div role="progressbar" aria-label="Uploading {filename}" aria-valuemin="0" aria-valuemax="{totalBytes}"
     aria-valuenow="{sentBytes}" aria-valuetext="{sent} of {total}, {pct} percent">
```

It has a visible inner bar, and the text "12.5 MB of 400 MB (3 %)" sits beside it, not only inside it. Byte labels are decimal MB with one decimal place, matching `bytesLabel`. Percent is `floor(sent / total × 100)`.

One polite `LiveRegion` (the existing component) per panel announces, per file:

- "{filename}: upload started";
- "{filename}: 25 percent uploaded", then 50 and 75;
- "{filename}: uploaded" (the 100 milestone);
- any error: "{filename}: upload interrupted, {reason}" or "{filename}: not uploaded, {reason}";
- "{filename}: ready" or "{filename}: failed, {reason}".

Each milestone is announced at most once per file, even after a Retry: `milestonesCrossed` remembers the highest milestone already announced. Several messages within 500 ms are joined with ". ", so one announcement does not overwrite another.

## Browser checks (FR-004, FR-005, P13)

1. Every file chosen or dropped becomes a row at once in `checking`, in the order chosen.
2. `precheck` runs the sniff, the size check and, for video, `readVideo`.
3. A refusal sets `refused` with the reason, makes **no** action call and sends no bytes.
4. A pass sets `waiting`.

Messages come from `upload-ui.ts` using `limits` values and labels only. Test fixtures are the only place numbers appear. `tests/lint/ui-limit-literals.test.ts` adds the new files (FR-036, contracts/operations.md).

## Queue (FR-006, D12)

- At most 3 rows are `uploading` at once.
- A `waiting` row starts when a slot frees, in the order chosen.
- Retry puts an `interrupted` row back to `waiting`, at the end of the queue, and it then resumes (P14).
- `cancelled`, `refused`, `failed` and `ready` rows never block or reset another row.

## After upload (FR-013, FR-014)

`completeUpload` returns the asset:

- **Image:** it arrives `ready`. The row shows "Processing" only while the call is in flight.
- **Video:** it arrives `processing`. The panel polls `mediaProcessingStatusAction` every 2 s for its `processing` rows, and stops when none remain. A missing id becomes `failed` with "This item was deleted."

In the library, `router.refresh()` runs once per batch, when the last row is terminal, so new items appear in the grid.

In the picker, `onUploaded(asset)` runs when `completeUpload` succeeds, whatever the processing state (D8). The composer then:

- shows the item with its poster or the placeholder;
- adds the id to its own status poll while it is not `ready`;
- re-runs `fetchCheck` when a polled status changes, so `media_processing` clears, or becomes `media_failed`, by itself (US3 AS5).

## Leaving the page (FR-012, D7)

While `engine.active()` is true, `UploadPanel` registers `beforeunload` with `event.preventDefault()`. It unregisters when `active()` becomes false and on unmount. Unmounting cancels nothing: open sessions expire on the server (P2).

## Help text and `accept` (FR-023)

- **Help text:** "Drop files here or choose them. Images: {imageTypeLabels} up to {image MB} MB. Videos: {videoTypeLabels} up to {video MB} MB and {duration label}."
- **Input:** `accept={[...limits.image.types, ...limits.video.types].join(",")}` and `aria-label="Image or video files"`.
- **Storage not set up:** "Uploads are unavailable: media storage is not set up," as today, for images and video alike.

## Library and picker display (P26)

- **Library card:**
  - a ready video shows the poster, a "Video · {duration}" badge, and the platform fit badges;
  - a processing video shows the placeholder and "Processing: {step}";
  - a failed video shows "Failed: {reason}", with Delete as its only action.
- **Detail dialog:** for a ready video, `<video controls preload="none" poster={thumbnailUrl} src={publicUrl}>` with a `<track>`-free caption "Video preview", and a `<dl>` with Duration, Size (W × H), Video codec, Audio (codec, or "no audio"), Frame rate, File size and Container (US2 AS2).
- **Picker:** lists `processing` and `ready` items, never `failed` ones. A non-ready video has the placeholder thumbnail and the text "Processing", and gets no fit badges ("Badges appear when processing finishes").

## Tests

Engine tests use a fake transport and fake actions. They run in Node (F11):

| Test file | Covers |
|---|---|
| `src/lib/upload/engine.test.ts` | progress values and milestones (US1 AS2); the cap of 3 with six files, one failing mid-way while the other five finish (SC-004); a drop at part 3 of 5 → interrupted → Retry re-sends parts 3 to 5 only, and the bar resumes at 2 parts (SC-003, US1 AS6); a 403 → re-sign once → success; a second 403 → storage error; Cancel calls `cancelUpload` and leaves the others running (US1 AS7); refusal before any action call, with limits from a served object (SC-002); processing → ready and processing → failed through the fake status (US2 AS1); a missing id → failed; `active()` drives `beforeunload` (FR-012) |
| `src/lib/upload/precheck.test.ts` | each refusal code with values built from a limits object; a video `readVideo` that is unreadable → pass with `checksAfterUpload: true` |
| `src/lib/media/sniff.test.ts` | JPEG, PNG and WebP from sharp; MP4 and MOV from ffmpeg fixtures (skipped without ffmpeg, never in CI); PDF bytes, M4A brand, random bytes |
| `src/lib/upload/milestones.test.ts` | at most five announcements; none repeated after a retry |
| `src/components/media/upload/upload-ui.test.ts` | every row state's text; every refusal and interrupted message; help text from limits |
| `src/components/media/upload/UploadPanel.test.ts` | `renderToStaticMarkup` of each row state: progressbar attributes, button labels naming the file, a single live region |
