# Contract: compose check with requirements summary

Route: `POST /p/{projectSlug}/compose/check` (`src/app/p/[projectSlug]/compose/check/route.ts`). The route itself is unchanged. Only the `data` body that `posts.checkComposition` returns gains a field.

## Request (unchanged)

```json
{ "baseText": "", "mediaIds": [], "targets": [{ "accountId": "<uuid>" }], "postId": "<uuid, optional>" }
```

An empty `baseText` with no media is valid and is what the composer sends as soon as an account is selected (research F1).

## Response `200`: `data.targets[]` gains `requirements`

```json
{
  "ok": true,
  "data": {
    "editable": true,
    "reviewBlocked": false,
    "targets": [
      {
        "accountId": "…",
        "displayName": "Main grid",
        "providerName": "Instagram",
        "effectiveText": "",
        "count": 0,
        "limit": 2200,
        "countingRule": "code_points",
        "postType": "text",
        "issues": [{ "severity": "error", "code": "media_required", "message": "Instagram posts need at least one image.", "field": "postType" }],
        "canSchedule": false,
        "requirements": {
          "text": { "maxLength": 2200, "countingRule": "code_points", "unit": "characters", "maxHashtags": 30, "maxMentions": 20 },
          "image": {
            "maxImages": 10,
            "formats": [{ "value": "image/jpeg", "label": "JPEG" }],
            "convertedTo": { "value": "image/jpeg", "label": "JPEG" },
            "convertedFrom": [{ "value": "image/png", "label": "PNG" }, { "value": "image/webp", "label": "WebP" }],
            "maxBytesPerFile": { "value": 8000000, "label": "8 MB" },
            "width": { "min": { "value": 320, "label": "320 px" }, "max": { "value": 1440, "label": "1440 px" } },
            "height": { "min": null, "max": null },
            "aspectRatio": { "min": { "value": 0.8, "label": "4:5" }, "max": { "value": 1.91, "label": "1.91:1" } },
            "maxAltTextLength": 1000
          },
          "post": { "mediaRequired": true, "textOnlyAllowed": false, "postTypes": ["image", "carousel"] }
        }
      }
    ]
  }
}
```

Guarantees:

- `requirements` is `null` exactly when the account's provider is not registered (`limit` is then `null` too). Otherwise it is always present, whatever the text and media.
- `requirements.text.maxLength === limit` and `requirements.text.countingRule === countingRule` (FR-004).
- `null` inside the summary means there is no limit Docket checks for that field (D11). The UI must say so and must never substitute a number.
- No `video` key exists (FR-005). Entry 2 adds one as a sibling of `image`, and clients must ignore unknown keys.
- Errors (`400`, `404`, `413`, `415`) are unchanged.

## New issue codes that the check (and scheduling, and the engine) can return

| `code` | `severity` | `field` | Example `message` |
|---|---|---|---|
| `too_many_hashtags` | `error` | `text` | "The caption has 31 hashtags; the limit is 30." |
| `too_many_mentions` | `error` | `text` | "The caption has 21 @mentions; the limit is 20." |

Both carry `count` and `limit`.

## Composer UI contract (`Composer.tsx` + `src/components/compose/RequirementsSummary.tsx`)

- **Placement.** For each selected account with a check result, the preview card shows a `RequirementsSummary` for `target.requirements`, below the counter and above the effective text. The existing counter, text, image list and issues do not change (spec "Out of scope", last bullet).
- **No result yet.** While the card shows "Checking…", no summary is shown. A `null` summary renders nothing.
- **Visible line.** It always shows text, images and formats, for example "2,200 characters · up to 10 images · JPEG". For a provider with `maxImages` 0 it reads "no images".
- **Details.** A `<details>` with `<summary>` "What {providerName} accepts" holds a `<dl>` of every field:
  - text limit and unit, plus hashtags and mentions when not null;
  - images (count);
  - formats, and "{convertedFrom} uploads are converted to {convertedTo}" when `convertedFrom` is non-empty;
  - maximum file size;
  - width and height ranges, and the aspect range, or "No limit checked";
  - alt text limit, or "No limit documented";
  - "Image required: yes/no" and "Text-only posts: allowed/not allowed".
- **Open state.** The details start open when exactly one account is selected at the moment the summary first renders, and closed otherwise. After that the person controls it.
- **Live region.** The summary is outside the preview's `aria-live` region, so it is not re-announced on every check.
- **Literals.** Every number, unit and label comes from `requirements`; the wording is built by a pure helper in `src/components/compose/requirements-ui.ts`. No limit value, MIME string or counting rule name appears as a literal (SC-004, enforced by `tests/lint/ui-limit-literals.test.ts`).
