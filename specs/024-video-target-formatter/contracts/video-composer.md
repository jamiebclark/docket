# Contract: composer edits, previews, badges and summary

Covers FR-001–FR-004, FR-028–FR-031 and FR-042 (UI parts), and SC-006 and SC-008. Decisions: [research.md](../research.md) P16, P18, P20, P21. All UI work follows the `docket-ui` skill: server components by default, client components only for interactivity, labelled controls, visible focus, sensible empty and error states. No limit literal may appear in UI code.

## Server inputs

- **`postInputSchema`** (`src/lib/validation/scheduling.ts`) gains `videoEdits: z.record(z.uuid(), videoEditSchema).default({})`. This applies to `createDraft` and `checkComposition`.
- **`patchSchema`** in `posts/index.ts` gains `videoEdits` as optional. Absent keeps the stored edits; a key whose value equals the default deletes its row.
- **Checks** (P21):
  - keys must be attached media ids of kind video (else a field error `videoEdits.<id>`: "This video is not on the post.");
  - `assertEditFits` runs against each video's duration;
  - errors come back as `ZodError` field errors, so the composer shows them on the field and keeps the previous edit (FR-003, US3 #4).
- **Who.** `need(scope, { post: ["edit"] })` already guards both writes. The started-publishing lock already refuses `updatePost` (FR-004, D16).
- **The public API's body schemas are unchanged.** API-created posts use the default edit (FR-046).

## Check response (read-only)

`TargetCheck` gains:

```ts
videos: VideoTargetView[];   // one per video on the post, in post order; [] when none

interface VideoTargetView {
  mediaId: string;
  index: number;                         // position in the post
  plan: "as_is" | "adapted" | "rewrap" | "refused" | "checking";
  steps: string[];                       // badge words (P18), [] unless adapted/rewrap
  notes: string[];                       // the planner's sentences
  reasons: string[];                     // refusal sentences
  output: { durationLabel: string; sizeLabel: string } | null;    // planned, e.g. "1:30", "1080×1920"
  preview:
    | { kind: "original"; url: string; posterUrl: string | null }  // as_is and rewrap
    | { kind: "render"; key: string; state: "none" | "queued" | "building" | "ready" | "failed"; url: string | null; error: string | null }
    | null;                                                       // refused, checking
}
```

`checkComposition` still writes nothing. It reads preview rows by key only.

## Actions (`src/app/p/[projectSlug]/compose/actions.ts`)

```ts
requestVideoPreviewsAction(slug, input: { postId?: string; baseText: string; mediaIds: string[]; targets: …; videoEdits: Record<string, VideoEdit>; retry?: boolean })
  : Promise<ActionResult<{ previews: { key: string; state: …; url: string | null; error: string | null }[] }>>;
videoPreviewStatusAction(slug, input: { keys: string[] })        // ≤ 50 keys
  : Promise<ActionResult<{ previews: { key: string; state: …; url: string | null; error: string | null }[] }>>;
```

- **Service.** Both call `src/server/services/video-previews.ts`. `request` needs `post: ["edit"]`; `status` needs `post: ["view"]`.
- **What `request` does.** It plans every `(video, target)` from the input (an unsaved edit included). For every `encode` plan it upserts a `kind: "preview"` row with `due_at = now`. `retry: true` resets `failed` rows.
- **Not a gate.** Neither action is ever awaited by scheduling, and scheduling never reads preview rows (US4 #3).

## Components

| Component | Kind | Role |
|---|---|---|
| `src/components/compose/VideoEditButton.tsx` | client | "Edit video" button under each attached video in the composer's media list; opens the dialog |
| `src/components/compose/VideoEditDialog.tsx` | client | `Dialog` with trim, fit, colour, focal point and recommended shape; Save applies to composer state (saved with the draft), Cancel discards |
| `src/components/compose/FocalPointPicker.tsx` | client | poster image plus marker; pointer and keyboard |
| `src/components/compose/VideoTargetPreview.tsx` | client | per target card: "Preview" disclosure, state, `<video>` and facts |
| `src/components/compose/video-edit-ui.ts` | pure | trim parse/format (`m:ss.s`), focal key steps, state words; unit-tested in Node |

**Dialog fields** (all labelled, in this order):

1. **Start** and **End**: text inputs with the hint "m:ss.s", the video's length beside them, and "Whole video" to reset.
   - Errors: "The end must be after the start.", "The start must be inside the video (length 3:12.4).", "Keep at least 1 second."
   - An error keeps the previous value and does not apply (US3 #4).
2. **Fit when the shape must change**: a `SegmentedControl` with "Pad with a blurred copy" (default), "Pad with a colour" and "Crop".
3. **Pad colour**: shown for "Pad with a colour"; an `input type="color"` plus a text field (`#rrggbb`), default black.
4. **Focal point**: shown for "Crop"; the note reads "Used when Docket crops this video. Click or use the arrow keys."
5. **Use each platform's recommended shape**: a checkbox with the hint "Reframes to 9:16 for platforms that recommend it."

**`FocalPointPicker`** (FR-002, US2 #5–#6, SC-006):

- **The image** is the poster (`thumbnailUrl`, already rotation-applied, F19), with alt text "Poster frame of <filename or Video n>".
- **The marker** is a focusable element: `role="slider"`, `aria-label="Focal point"`, `aria-valuetext="20% across, 50% down"`, `aria-valuemin=0`, `aria-valuemax=100`, and `aria-valuenow` set to the across value.
  - The arrow keys move it 5% (Shift: 1%), clamped to 0–100%, and Home centres it.
  - Each change is announced through the existing `LiveRegion` (polite).
- **The pointer**: clicking or dragging on the image sets the point from the displayed image's size.
- **Focus** is visible on the marker. The picker never traps focus, and the dialog keeps its own focus management.

**`VideoTargetPreview`** (FR-028, US4):

- It sits in each target's card under the account name, when the post has a video.
- **Collapsed:** a summary line, one of:
  - "Fits as is";
  - "Will be adapted: cut to 1:30, padded to 9:16 with a blurred copy";
  - "Will be refused: <reason>";
  - "Checking the video's details…".
- **Expanded**, by a "Preview" button with `aria-expanded`:
  - `as_is`: the original in `<video controls preload="metadata">`, with "Fits as is";
  - `rewrap`: the original, with "Rewrapped as MP4 (no visible change)";
  - `adapted`: "Preparing preview…" (`role="status"`) while queued or building; then `<video controls>` of the render, with its duration, size and steps; on failure, the error and a "Retry" button (`retry: true`);
  - `refused`: the reasons;
  - `checking`: "Docket is still reading this video's details.".
- **Opening** triggers `requestVideoPreviewsAction`. Changing an edit while it is open triggers it again, debounced 800 ms. Old previews are replaced, because a new key gives a new view (US4 #2).
- **Polling.** While any open preview is `queued` or `building`, `videoPreviewStatusAction` polls every 2 s, and stops when none is (US4 #1, "without reloading").
- **Several videos** in a carousel each get their own row inside the target card.

**Badges and summary:**

- **`FitBadges`/`MediaCard`** (library and picker): the new `adapted` and `checking` states, from `fitOf` (contracts/video-planner.md, "Fit badges").
- **`RequirementsSummary`**: "Docket adapts:" and "Docket cannot fix:" lists from `video.adapts` and `video.cannot`.
- **Post page and target status:**
  - "Preparing video for <platform>" when `preparingVideo` is set;
  - failed targets show their `lastError` (as today);
  - Retry is unchanged.

## Tests

- **`src/components/compose/video-edit-ui.test.ts`** (Node):
  - parse and format of `m:ss.s` (`2:15.0` → 135 000; `0:00.05` refused, since only tenths are allowed; `75` → 75 000);
  - the trim error messages;
  - focal key steps and clamping;
  - `aria-valuetext` wording;
  - the summary-line wording for each plan kind.
- **`src/lib/video/edit.test.ts`**: `videoEditSchema` and `assertEditFits` (an end before the start, outside the video, under 1 s, and an end equal to the duration normalised to null).
- **`tests/integration/compose/video-edits.test.ts`**:
  - saving and reloading edits;
  - removing a video removes its edit;
  - a non-editor is refused;
  - an edit after publishing has started is refused (FR-004);
  - an edit for an unattached media id gives a field error;
  - a check with an unsaved edit plans with it;
  - the API create ignores the field.
- **`tests/integration/compose/video-previews.test.ts`** (US4 independent test): a draft with three targets (mock as is, mock with recommended shape on → adapted, Facebook Reel with a 2 s clip → refused).
  - `request` creates exactly one preview row.
  - `status` reports `queued`, then `ready` after the test marks it.
  - Two targets with identical limits share one key (US4 #4).
  - A changed edit gives a new key (US4 #2).
  - With ffmpeg (`requireFfmpeg()`), `buildNext` renders it: the long side is ≤ 640, and the duration and shape are as planned.
- **`tests/integration/media/fit.test.ts`** (extended): video badges for `adapted`, `refused` and `checking`, and US6 #1–#3.
- **`Composer.test.ts`** (extended, logic only): `videoEdits` travel in the check and save payloads.
