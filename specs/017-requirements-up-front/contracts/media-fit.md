# Contract: per-platform fit badges

## Service: `listMedia(scope, filter)` (`src/server/services/media.ts`)

Input (`filter`, Zod) adds:

```ts
fit?: { accountIds: string[] /* uuid, ≤ 50 */ } | { active: true }
```

Result adds:

```ts
{
  items: (MediaView & { fit: PlatformFit[] })[];   // fit[i] corresponds to platforms[i]
  platforms: { key: string; name: string }[];      // deduplicated per provider (D8), sorted by name
  // total, page, pageCount, tags: unchanged
}
```

- **Authorisation.** It still requires `media: view`, and no account data beyond the provider key and name leaves the server.
- **`accountIds`.** Ids that are unknown, in another project, or on an unregistered provider are ignored silently (research P7). Accounts with `needs_reauth` are included, because the composer still targets them.
- **`active: true`.** Only `status = "active"` accounts with a registered provider qualify (D9).
- **No platforms.** With no `fit` or no qualifying account, `platforms` is `[]` and every `item.fit` is `[]`.
- **Cost.** It is computed from the stored `mimeType`, `width`, `height` and `byteSize`. It does no storage read, no decode and no variant lookup.

## Function: `fitOf(asset, provider): PlatformFit` (`src/server/services/media-fit.ts`)

It is pure. The derivation table is in [data-model.md §5](../data-model.md#5-platformfit-new). The invariant tested for SC-003: for an asset with dimensions, `fitOf(asset, p).state` equals `{ original: "fits", derive: "converted", refuse: "refused" }[planFor(asset, mediaConstraintsOf(p.capabilities), …).kind]`, and `steps` equals the plan's steps. The test runs this for every registered provider over the fixed image set: in range, WebP, too wide, too narrow, oversize, extreme aspect, plus a row without dimensions.

## Server action: `listMediaAction(slug, input)` (`src/app/p/[projectSlug]/media/actions.ts`)

`input` gains `fit?: { accountIds: string[] }`, which is forwarded unchanged. The picker never sends `{ active: true }`.

## UI

### `FitBadges` (`src/components/media/FitBadges.tsx`)

Props: `{ fit: PlatformFit[] }`. It renders nothing for an empty array.

- **Badges.** One `Badge` per entry, in order, with text from a pure helper in `src/components/media/fit-ui.ts`:

  | `state` | Badge text | Tone |
  |---|---|---|
  | `fits` | "{providerName}: fits" | `success` |
  | `converted` | "{providerName}: will be converted" | `info` |
  | `refused` | "{providerName}: will be refused" | `danger` |

- **Details.** Below the badges, a `<ul>` with an accessible label "Platform notes" lists each non-fitting entry as "{providerName}: {details joined by a space}". The text is visible, so there is no tooltip and nothing hover-only (FR-007 and the `docket-ui` skill).
- **Literals.** No limit, MIME or rule literal appears (SC-004).

### Media library page (`src/app/p/[projectSlug]/media/page.tsx` + `MediaCard`)

- The page calls `listMedia(scope, { …filter, fit: { active: true } })`.
- `MediaCard` gains an optional `fit` prop and renders `<FitBadges fit={item.fit} />` after its existing badges.
- With no active accounts, nothing new renders and the page behaves exactly as before (US2 AS6).

### Image picker (`src/components/media/MediaPicker.tsx`)

- `MediaPicker` gains an `accountIds: string[]` prop, which `Composer` passes as `selected`. `PickerDialog` passes `fit: { accountIds }` to `listMediaAction` and includes `accountIds` in the effect dependencies, so badges follow the selection.
- Each grid item renders `<FitBadges fit={m.fit} />` under the file name, inside the toggle button's accessible description (`aria-describedby` pointing at the badge list), so the badge text is read with the image.
- With no account selected, no badges are shown (edge case "No accounts selected").
- Images already attached are unchanged. Their per-platform outcome is in the preview's issues, as today.
- The `accept` attribute uses `UPLOAD_MIME_TYPES.join(",")` from `src/lib/media/types.ts`. The value is the same (FR-023).
