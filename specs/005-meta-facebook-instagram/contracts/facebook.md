# Contract: `facebook` provider (`src/providers/facebook/`)

The provider is one folder and one registry line. Files: `index.ts`, `capabilities.ts`, `settings.ts`, `steps.ts`, `publish.ts`, `validate.ts`, `links.ts`, plus `*.test.ts` alongside.

```ts
export const facebookProvider: SocialProvider<FacebookSettings, FacebookState> = {
  key: "facebook",
  displayName: "Facebook",
  capabilities: {
    text: { maxLength: 10_000, countingRule: "code_points" },         // R1 interim
    media: {
      maxImages: 10,                                                  // R2 interim
      allowedMimeTypes: ["image/jpeg", "image/png"],
      outputMimeType: "image/jpeg",
      maxBytesPerFile: 8_000_000,                                     // R2 interim
      required: false,
    },
    textOnlyAllowed: true,
    postTypes: ["text", "image", "carousel"],
  },
  connect: { strategy: "oauth", group: metaConnectGroup },
  settingsSchema: z.object({}).strip(),
  validate: validateFacebook,          // validateAgainstCapabilities; no extra codes
  stepFor: (state, _s, content) => facebookStepFor(state, content),
  advance: advanceFacebook,
};
```

There is no `defaultPublishLimit`: the research gives no Page publishing limit. There is no `refreshCredentials` or `needsRefresh`, because Page tokens do not expire.

## Steps

The step table is in [data-model §4](../data-model.md). Requests, using `{page}` = `ctx.account.externalId`:

| Step | Request | Params |
|---|---|---|
| `publish_feed` (text) | `POST /{page}/feed` | `message` = text; `link` = first URL ([links.ts](#links)), when present |
| `publish_photo` | `POST /{page}/photos` | `url` = image URL; `caption` = text (omitted when empty) |
| `upload_photo_<i>` | `POST /{page}/photos` | `url` = image i URL; `published` = `"false"` |
| `publish_feed` (multi) | `POST /{page}/feed` | `message` = text (omitted when empty); `attached_media` = `JSON.stringify(photoIds.map(id => ({ media_fbid: id })))` **(U1)** |

**Never sent**: `scheduled_publish_time`, and `published=false` on a publishing request. A test asserts this.

`advance` refuses a mismatch before sending. If `ctx.step.name` differs from `stepFor(ctx.state, …)`, or the content no longer matches (for example image *i* is missing), it returns `fatal_error` "The post changed while publishing."

## Results

| Step | 2xx body | Result |
|---|---|---|
| `publish_feed` | `{ id: string }` | `done`, `externalId = id` |
| `publish_photo` | `{ id, post_id? }` | `done`, `externalId = post_id ?? id` |
| `upload_photo_<i>` | `{ id }` | `continue` `{ v: 1, photoIds: [...photoIds, id] }`, no `notBefore` |
| any `mayPublish` step | 2xx without a string id | `ambiguous` "Facebook accepted the request but its reply could not be read." |
| `upload_photo_<i>` | 2xx without an id | `retryable_error` |

Errors follow [meta.md](./meta.md) `graphStepError` with `platform: "Facebook"`. An image Meta cannot fetch comes back as a Graph rejection, i.e. `fatal_error` with Meta's message. The message gets the suffix " Images must be at a public URL (see docs/storage.md)." when the step is a photo step.

## links

```ts
/** First http(s) URL in text, trailing punctuation trimmed, or null. Pure. */
export function firstUrl(text: string): string | null;
```

Cases tested: no URL, one URL, several URLs (the first wins), a URL followed by `.`, `)` or `,`, `www.` without a scheme (not a link), and a URL inside angle brackets.
