# Contract: capabilities, validation and publishing a pin

Covers FR-009–FR-027 and FR-030. Every request below is mocked in tests; none is ever made live.

## 1. Declared capabilities

```ts
pinterestCapabilities: ProviderCapabilities = {
  text: { maxLength: 800, countingRule: "code_points" },
  media: {
    maxImages: 1,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    outputMimeType: "image/jpeg",
    maxBytesPerFile: 20_000_000,
    maxAltTextLength: 500,
    required: true,
  },
  video: { maxVideos: 0 },
  textOnlyAllowed: false,
  postTypes: ["image"],
};

PINTEREST_DEFAULT_PUBLISH_LIMIT: PublishLimit = { count: 100, windowSeconds: 60 };
```

No `minWidth`/`maxWidth`/`minHeight`/`maxHeight` and no `minAspectRatio`/`maxAspectRatio`: declaring them
would make the media planner **refuse** a pin Pinterest would have accepted (FR-014, U3). The image
planner therefore only ever converts (a type Pinterest does not take cannot reach the library at all) or
compresses (over 20 MB), and never refuses a Pinterest image on shape.

## 2. `validatePinterest(content, caps)`

`validateAgainstCapabilities(content, caps)` first, with five messages re-worded (K11):

| Code | Pinterest's wording |
|---|---|
| `text_too_long` | "The post's text becomes the pin's description: {count} characters; Pinterest allows 800." |
| `text_only_not_allowed` | "Pinterest needs one image: there is no text-only pin." |
| `media_required` | same sentence |
| `too_many_images` | "This post has {count} images; a Pinterest pin takes exactly one." |
| `unsupported_post_type` | "Pinterest takes one image per pin; carousels are not supported yet." |
| `video_not_accepted` | "Pinterest video pins are not supported yet." |

Then Pinterest's own issues, in this order:

| # | Condition | severity | code | field |
|---|---|---|---|---|
| 1 | `posting.values` is null or unparseable | error | `posting_required` | `posting` |
| 2 | details present and `details.boards` is empty | error | `no_boards` | `posting.boardId` |
| 3 | else `values.boardId === null` | error | `board_required` | `posting.boardId` |
| 4 | else details present and `boardId` is not among `details.boards` | error | `board_not_found` | `posting.boardId` |
| 5 | `values.title` over 100 code points | error | `title_too_long` (with `count`, `limit`) | `posting.title` |
| 6 | `values.link` over 2048 code points | error | `link_too_long` (with `count`, `limit`) | `posting.link` |
| 7 | `values.link` non-empty and not an absolute `http(s)` URL | error | `link_invalid` | `posting.link` |
| 8 | the one image's width ÷ height is outside `[0.5, 1.0]` | **warning** | `aspect_far_from_recommended` | `media.0` |
| 9 | the one image's URL is not `https:` | error | `image_url_not_https` | `media` |

Messages:

- `posting_required` — "Open this post in the composer and choose a Pinterest board before scheduling."
- `no_boards` — "This Pinterest account has no public boards. Create one on Pinterest, then choose it here."
- `board_required` — "Choose the board this pin goes on."
- `board_not_found` — "The board \"{name}\" is no longer on Pinterest. Choose another."
- `title_too_long` — "The pin title is {count} characters; Pinterest allows 100."
- `link_too_long` — "The pin link is {count} characters; Pinterest allows 2048."
- `link_invalid` — "The pin link must be a full web address starting with https://."
- `aspect_far_from_recommended` — "Image 1 is {ratio} wide by tall; Pinterest recommends 2:3 and may crop
  it in the feed. It will still be published."
- `image_url_not_https` — "Pinterest fetches the image over HTTPS only."

Rules this encodes:

- **Only `error` blocks** (F4), so #8 publishes — that is FR-014.
- **Details are null outside the composer** (F11), so #2 and #4 are composer-only checks; a board deleted
  after scheduling is caught by Pinterest's 404 (§4, FR-021).
- `validate` is **pure and never throws**; an unparseable `posting.values` produces #1 rather than an
  exception.
- The engine re-runs all of this on a target's first step (G15), which is FR-016's second refusal.

## 3. The step machine

`pinterestStepFor(state, settings, content) → { name: "create_pin", mayPublish: true }` for every input,
including `state === null`. Pure, total, no state (K3). No `afterPublish` step, no `allowance`.

## 4. `advancePinterest(ctx)` — the one step

**Guards, before any network call** (each is also covered by the engine's own re-validation, and each is a
plain failure, never `ambiguous`, because nothing has been sent — see "What the engine checks for you"):

| Guard | Result |
|---|---|
| credentials unreadable | `fatal_error`, `credentialsInvalid: true`, "The stored Pinterest sign-in is unreadable. Reconnect the account." |
| posting values unparseable, or `boardId` null | `fatal_error`, "Choose the board this pin goes on, then schedule again." |
| not exactly one image (none, more than one, or a video) | `fatal_error`, "A Pinterest pin needs exactly one image." |

**The request** — exactly one, per data-model.md §7:

```
POST https://api.pinterest.com/v5/pins
Authorization: Bearer <accessToken>
Content-Type: application/json

{ "board_id": "<boardId>",
  "media_source": { "source_type": "image_url", "url": "<media[0].url>" },
  "description": "<text>",            // omitted when blank
  "alt_text": "<media[0].altText>",   // omitted when blank
  "title": "<title>",                 // omitted when empty
  "link": "<link>" }                  // omitted when empty
```

No upload step, no polling, no domain or URL-prefix verification (FR-022).

**Outcomes** (FR-024–FR-027):

| Reply | Result | Message |
|---|---|---|
| 2xx, JSON, `id` is a non-empty string | `done`, `externalId = id`, `url = pinUrl(id)` | — |
| 2xx with no readable `id`, or a 2xx that is not JSON | `ambiguous` | "Pinterest answered without a usable pin id. Check the board on Pinterest before retrying." |
| `network`, `phase: "not_sent"` | `retryable_error` | "Could not reach Pinterest; nothing was sent. Will retry." |
| `network`, `phase: "lost"` | `ambiguous` | "The connection to Pinterest was lost after the pin was sent. Check the board on Pinterest before retrying." |
| 401 | `retryable_error`, `credentialsExpired: true` | "Pinterest rejected the sign-in; will renew it and retry." |
| 429 | `retryable_error`, `notBefore` per §5 | "Pinterest's rate limit was reached; will retry after it resets." |
| 404 | `fatal_error` | "Pinterest could not find the board \"{boardName}\". Choose another board for this post." + `(Pinterest: …)` when a message came back |
| 403 | `fatal_error` | "Pinterest refused permission for this pin." + `(Pinterest: …)` |
| 400 | `fatal_error` | "Pinterest refused the pin." + `(Pinterest: …)` |
| any other 4xx | `fatal_error` | "Pinterest refused the pin (HTTP {status})." + `(Pinterest: …)` |
| 5xx, or any other non-2xx | `ambiguous` | "Pinterest answered with an error (HTTP {status}) after the pin was sent. Check the board on Pinterest before retrying." |

- **A 5xx is ambiguous, not retryable** (K29): with one step there is no "before the create call", and a
  gateway error can follow a request Pinterest already processed. Pinterest offers no idempotency key, so
  a missed post beats a duplicate (constitution V, FR-026).
- **Nothing is ever retried automatically after an `ambiguous`**; the engine parks it for a person, and
  every ambiguous message tells them to look at the board first (FR-026).
- `pinUrl(id) = "https://www.pinterest.com/pin/" + encodeURIComponent(id) + "/"` — one function, flagged
  best-effort in the docs (U5, FR-027). The reply's `link` field is never used for it.

## 5. Rate limits (FR-030)

- `defaultPublishLimit` is `{ count: 100, windowSeconds: 60 }`; a target over it is **deferred** by the
  engine, not failed. The provider counts nothing.
- A 429's `notBefore` is `now + clamp(resetSeconds, 1, 3600) × 1000`; with no readable
  `x-ratelimit-reset`, no `notBefore` is set and the engine's own backoff applies (FR-025).
- The Trial 300-per-day-per-app cap is **not** modelled: it is shared across accounts and Docket's limits
  are per account (FR-031). A Trial deployer therefore sees it as a 429 the provider cannot distinguish
  from a per-account limit, which is retried at the reset — the honest behaviour, explained in the account
  note and the setup guide.

## 6. Errors module

`explainPinterest(status, message, boardName, secrets)` builds the sentences above. It matches on
**status only**; any human text is appended as `(Pinterest: <scrubbed ≤200>)` and nothing is appended when
no readable message came back. A numeric `code` in the body is never consulted (FR-024, U2).

## 7. Secrets (constitution VII, FR-008)

Tokens, the client id and the client secret appear only in the request headers. They never reach `state`
(there is none), `error`, `summary`, `lastError`, activity, logs, the browser or a snapshot.
`tests/integration/pinterest/no-secrets.test.ts` makes the fake Pinterest echo every secret it is given
and asserts none appears anywhere Docket records.

## 8. Tests (mocked HTTP only, FR-037)

`src/providers/pinterest/{capabilities,validate,errors,steps,publish}.test.ts` and
`tests/integration/pinterest/{publish-e2e,failures,no-secrets}.test.ts`:

- every row of §2, each asserting the field, the count and the limit where the message names them;
- text at exactly 800 publishes; 801 is refused;
- a title at 100 and a link at 2048 publish; 101 and 2049 are refused;
- alt text at 500 publishes; 501 is refused;
- an image at exactly 20,000,000 bytes publishes; over it is refused naming the limit;
- a 2:3 image produces no issue; a 1000×3000 image produces the warning **and still publishes**;
- `stepFor` returns `create_pin` with `mayPublish: true` for null state and for junk state;
- the happy path: exactly **one** outbound request, with the board, the image URL, the description, the
  alt text, the title and the link; the recorded external id and the constructed pin URL;
- blank text, blank alt text, empty title and empty link each omit their key entirely;
- every row of §4's outcome table, including both `network` phases, an unparseable 2xx, a 2xx without an
  id, and a 429 with and without a readable reset (the second falling back to the engine's backoff);
- a 404 whose message names the stored board name and is not retried;
- an ambiguous target is not retried by a later tick and its `lastError` tells the person to check the
  board;
- a 401 drives one refresh and one retry, and shows the user nothing unless the refresh also fails;
- error bodies in both the `{code,message}` and `{error:{message}}` shapes produce the same mapping (U2).
