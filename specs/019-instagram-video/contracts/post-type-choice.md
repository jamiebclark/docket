# Contract: per-target post type choice (G19)

Covers FR-006–FR-010, US2, D1–D3. Decisions: research P1–P7. Types: [data-model.md](../data-model.md) §2, §3 and §6.

## 1. Provider declaration

```ts
// src/providers/instagram/capabilities.ts
postTypeChoices: [
  {
    shape: "single_video",
    options: [
      { type: "video", label: "Feed video", description: "Shown in your feed and the Reels tab." },
      { type: "reel", label: "Reel", description: "Shown in the Reels tab only." },
    ],
    default: "video",
  },
],
postTypes: ["image", "carousel", "video", "reel"],
```

**Registry checks** (`assertVideoCapabilities`, run at registry load; throws on violation):

- a choice has at least 2 options;
- option types are unique and all in `postTypes`;
- `default` is one of the options;
- at most one choice per shape.

No other provider declares a choice in this entry, the mock included.

## 2. Resolution (`src/providers/post-type.ts`)

```ts
resolvePostType(caps: ProviderCapabilities | null, items: readonly { kind?: "image" | "video" }[], chosen: PostType | null): PostType
```

| Items | Result |
|---|---|
| none | `text` |
| one image | `image` |
| one video, choice declared, `chosen` among its options | `chosen` |
| one video, choice declared, otherwise | the choice's `default` |
| one video, no choice declared | `video` |
| two or more (any mix) | `carousel` |

The callers below resolve with the same function and the same inputs, so they always agree:

| Caller | Items from | `chosen` from |
|---|---|---|
| `checkComposition` | the composer's media ids | the input target's `postType` (absent → the stored value when `postId` is given, else null) |
| `validateTargetContent` (gate, queue, schedule, update) | `TargetContent.assets` | `TargetContent.chosenPostType` |
| engine `decide` → `stepFor` | `contentShape.kinds` | `contentShape.chosenPostType` |
| engine `execute` → G15 re-check and `PublishContext.postType` | resolved media | `target.chosenPostType` |
| API `TargetSchema.postType` view | the post's media | `target.chosenPostType` |
| fit badges and generator checks | one item | null (so the default) |

## 3. Storage and services

- **Column.** `post_targets.chosen_post_type` ([data-model.md](../data-model.md) §1.1).
- **Create.** `createDraft` writes `chosenPostType` from each input target's `postType` (null when absent).
- **Update.** In `updatePost`, `postType: undefined` leaves the column alone, `null` clears it, and a value sets it. `updatePostVariants` and every other caller that sends no `postType` keep the stored choice.
- **Validation of values.** Before writing, `assertPostTypeOffered(provider, value)` runs for every non-null value. On refusal it throws `ZodError([{ path: ["targets", i, "postType"], message }])`:
  - `"story" is not offered for Instagram; allowed: video, reel`;
  - `Facebook offers no post type choice`.

  `checkComposition` applies the same check, so the composer sees the same message.
- **Editing locks.** Editing rules are unchanged: once a target has started publishing, `updatePost` refuses the edit as today. D13 covers a choice or media change that still reaches the engine, through `validState` (instagram-publishing.md §4).

## 4. Composition check

`TargetCheck` gains:

```ts
postTypeChoice: {
  options: { type: PostType; label: string; description: string }[];
  selected: PostType;   // the resolved type
  default: PostType;
} | null;
```

- **Presence.** It is present exactly when `choiceFor(caps, media)` is not null. For Instagram that means one video and nothing else (US2-1, US2-4). Accounts on other providers get `null` (US2-5).
- **Related fields.** `postType` is the resolved type, and `requirements` is built for it (video-capabilities.md §4).

## 5. Composer UI (`Composer.tsx`, follows the `docket-ui` skill)

- **State.** `postTypes: Record<accountId, PostType | null>`, initialised from `initial.targets[].postType` (the stored choice) and sent in `targets` for the check and on save: `{ accountId, overrideText, postType }`. Hiding the fieldset does not clear it (FR-008).
- **Placement.** The "Post as" control is in the target's preview card, above `RequirementsSummary`, rendered only when `t.postTypeChoice` is not null:

  ```tsx
  <fieldset>
    <legend>Post as</legend>
    {options.map(o => (
      <label>
        <input type="radio" name={`post-type-${accountId}`} value={o.type}
               checked={selected === o.type} aria-describedby={`${id}-${o.type}-desc`} />
        {o.label}
        <span id={`${id}-${o.type}-desc`}>{o.description}</span>
      </label>
    ))}
  </fieldset>
  ```

- **Keyboard and focus.** Native radios give Tab into the group and arrow keys between options, with the design-system focus ring (US2-6). The card's `aria-live` region does not repeat the radios.
- **Events.** Changing the choice sets `postTypes[accountId]`, which re-runs the debounced check through the existing effect, so the summary updates without a reload (SC-007).
- **Announcement.** `RequirementsSummary` gets a visually hidden `<p aria-live="polite">`. It reads "Showing requirements for Reel" whenever `requirements.video.postType?.label` changes after mount, and is empty at first render.
- **Preview list.** It labels items "Image n" or "Video n" by kind, and leaves alt-text text off videos (FR-026).
- **No literals.** No literals in UI code: labels and descriptions come from `TargetCheck`, and the existing `tests/lint/ui-limit-literals.test.ts` keeps covering `src/components/compose` and the composer.

## 6. Public API

- **`createPost` body.** It gains `postTypes?: { [accountId: uuid]: PostType }`, described in OpenAPI: "Optional post type per account, for accounts whose provider offers a choice (Instagram: `video` = Feed video, `reel` = Reel). Absent = the provider's default." A key that is not in `accountIds` is a 400. A refused value is a 400 with `details[].path` = `postTypes.<accountId>`.
- **`TargetSchema`.** It gains `postType: string | null`, the effective post type. It appears in `getPost`, `getPostTarget` and `createPost`'s `post.targets`.
- **No update operation.** The API has no post update operation (research F11), so no route is added; it is recorded as unowned in `docs/feature-map.md`.
- **Generated and job-created posts** create targets without a choice and get the default (D2).

## 7. Tests

| File | Proves |
|---|---|
| `src/providers/post-type.test.ts` (new) | The §2 table; a choice value not offered → default; a stored `reel` on a two-item post → `carousel`; the mock's 2-video and video+image posts keep their 018 refusal codes. |
| `src/providers/registry.test.ts` | §1 registry checks throw for a bad default, an option outside `postTypes`, or a duplicate shape. |
| `tests/integration/compose/post-type-choice.test.ts` (new) | `checkComposition` with one video and an Instagram account: the choice is present with default `video`; `reel` gives `selected: "reel"` and the Reel summary; images, two videos or video+image give no choice and the carousel summary; a mock account has no choice; an unoffered value is refused. Save → reopen keeps `reel`; switching to a carousel and back keeps it (FR-008). |
| `src/app/p/[projectSlug]/compose/Composer.test.ts` | Markup (`renderToStaticMarkup`): fieldset, legend "Post as", radios named per account, `aria-describedby`, the polite live line; no fieldset without `postTypeChoice`; "Video 1" in the preview list. |
| `tests/integration/api/post-type.test.ts` (new) | `createPost` without `postTypes` → `postType: "video"` for an Instagram single-video target; with `reel` → `"reel"`; `story` → 400 naming `video, reel`; a value for a Facebook account → 400; a key not in `accountIds` → 400; the OpenAPI document lists `postTypes` and `Target.postType`. |
| `tests/integration/posts/post-type-update.test.ts` (new) | `updatePost` with `postType` absent keeps the value, `null` clears it; `updatePostVariants` keeps it. |
