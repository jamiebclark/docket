# Contract: `src/providers/bluesky/`

The Bluesky provider (`key: "bluesky"`, `displayName: "Bluesky"`). The state, credential and settings shapes are in [data-model.md](../data-model.md) §2–§4. Library facts are in [research.md](../research.md) R2/R3, and design decisions in D1–D23.

## 1. Files

| File | Exports | Notes |
|---|---|---|
| `index.ts` | `blueskyProvider: SocialProvider<BlueskySettings, BlueskyState>` | Wiring only |
| `settings.ts` | `blueskySettingsSchema`, `blueskyCredentialsSchema`, `blueskyStateSchema`, `normaliseHandle`, `normalisePdsUrl`, `DEFAULT_PDS_URL` | Pure |
| `client.ts` | `agentFor(pdsUrl, accessJwt?)` | `new Agent({ service, headers: accessJwt ? { authorization: \`Bearer ${accessJwt}\` } : {}, fetch: (i, o) => globalThis.fetch(i, o) })`. No `CredentialSession` / `AtpAgent` |
| `session.ts` | `connectAccount`, `refreshCredentials`, `needsRefresh`, `jwtExp` | `createSession` / `refreshSession` |
| `steps.ts` | `stepForContent(state, content)`, `mentionHandles(text)` | Pure, total |
| `facets.ts` | `buildFacets(text, mentions)` | Pure. `RichText.detectFacetsWithoutResolution` plus DID substitution and dropping |
| `publish.ts` | `advance(ctx)` → `resolveMentions` / `uploadImage` / `createPost` | One request type per step |
| `errors.ts` | `classify(err, kind)`, `rateLimitNotBefore(headers, now)`, `isPreSend(err)`, `safeReason(err)` | Pure |
| `validate.ts` | `validateBluesky(content, caps)` | Shared checks plus `text_too_many_bytes` |
| `*.test.ts` | — | Unit tests with stubbed `fetch` (§8) |

## 2. Declarations

```ts
capabilities: {
  text: { maxLength: 300, countingRule: "graphemes" },
  media: {
    maxImages: 4,
    allowedMimeTypes: ["image/jpeg", "image/png"],
    outputMimeType: "image/jpeg",
    maxBytesPerFile: 2_000_000,
    required: false,
    // no maxAltTextLength: the research gives none
  },
  textOnlyAllowed: true,
  postTypes: ["text", "image", "carousel"],
},
// no defaultPublishLimit (D20)
connect: { strategy: "credentials", fields: [
  { name: "handle", label: "Handle", secret: false, placeholder: "you.bsky.social",
    help: "Your Bluesky handle, without the @." },
  { name: "appPassword", label: "App password", secret: true,
    help: "Create an app password in your Bluesky account settings. Do not use your main password." },
  { name: "pdsUrl", label: "Server (PDS) address", secret: false, optional: true, defaultValue: "https://bsky.social",
    help: "Leave as https://bsky.social unless you host your own server." },
]},
settingsSchema: blueskySettingsSchema,
```

## 3. `validate(content, caps)`

1. `validateAgainstCapabilities(content, caps)`. This gives the grapheme count (Intl.Segmenter, the same mechanism as the platform's `graphemeLen`), the image count, size and type, alt warnings and the adaptation `info` notes (003).
2. Then, if `Buffer.byteLength(text, "utf8") > 3000`, add:

```ts
{ severity: "error", code: "text_too_many_bytes", field: "text", count: <bytes>, limit: 3000,
  message: "Text is <bytes> bytes; Bluesky allows at most 3000 bytes." }
```

Exactly 300 graphemes and exactly 3,000 bytes are both allowed.

## 4. Connect and refresh (`session.ts`)

### `connectAccount({ fields, now, signal })`

1. Normalise the handle (D15). If it is empty after normalisation, or contains whitespace → `{ ok:false, field:"handle" }`.
2. `normalisePdsUrl(fields.pdsUrl)` → on failure `{ ok:false, field:"pdsUrl" }` (data-model §2).
3. Make **one** call: `agentFor(pdsUrl).com.atproto.server.createSession({ identifier: handle, password: fields.appPassword }, { signal })`.
4. Map the outcome:

| Outcome | Result |
|---|---|
| 2xx, valid output | `ok:true`: `externalId = did`, `displayName = handle (returned)`, `settings = { pdsUrl }`, `credentials = { accessJwt, refreshJwt, did, handle }`, `expiresAt = jwtExp(refreshJwt) ?? now + 60 d` |
| 401 / 400 (other) | `field: "appPassword"`, "Bluesky did not accept that handle or app password." |
| error `AuthFactorTokenRequired` | `field: "appPassword"`, "This account needs a sign-in code. Use an app password instead of your main password." |
| error `AccountTakedown` | "This Bluesky account is suspended." |
| 429 | "Too many sign-in attempts. Try again later." with `retryAt = rateLimitNotBefore(headers, now)` |
| status `Unknown` / `InvalidResponse` / 5xx / abort | `field: "pdsUrl"`, "Could not reach a Bluesky server at <pdsUrl>. Check the address and try again." |

The app password is used only in that request body. It is never logged, returned, put in a message or kept in a variable after the call.

### `refreshCredentials({ account, credentials, now, signal })`

1. Parse the credentials (data-model §3). On failure → `{ ok:false, reason:"Stored credentials are unreadable." }` (definitive).
2. Call `agentFor(account.settings.pdsUrl).com.atproto.server.refreshSession(undefined, { headers: { authorization: \`Bearer ${refreshJwt}\` }, signal })`.
3. On 2xx:
   - If `data.did !== credentials.did` → definitive `{ ok:false, reason:"The server returned a different account." }`.
   - Otherwise → `{ ok:true, credentials: { accessJwt, refreshJwt, did, handle: data.handle ?? old }, expiresAt: jwtExp(newRefresh) ?? now + 60 d, displayName: data.handle }`.
4. Definitive refusal (R2: 401, `ExpiredToken`, `InvalidToken`, `AccountTakedown`) → `{ ok:false, reason: "Bluesky refused to renew the session (<error name>). Reconnect the account with an app password." }`.
5. Anything else → `{ ok:false, transient:true, reason: "Could not renew the Bluesky session (<status or 'no response'>).", retryAt: rateLimitNotBefore(...) }`.
6. Never throws.

### `needsRefresh(credentials, now)`

Returns `jwtExp(accessJwt)` is not null **and** `exp − now < 5 min`. A parse failure returns `false`.

## 5. `advance(ctx)` and outcome mapping

Common to every step:

- Parse `ctx.state` (null → `{ v:1, blobs:[] }`).
- Recompute `stepForContent(state, { text, mediaCount })`.
  - A mismatch with `ctx.step.name` → `retryable_error` "The post changed while publishing; will retry."
  - `invalid_state` → `fatal_error` "Publishing state is unreadable. Use Retry to start again."
- Parse the credentials. Failure → `fatal_error` "Stored credentials are unreadable; reconnect the account."
- Every request passes `signal: ctx.signal`.
- `advance` catches everything and never throws. A throw would be mapped by the engine using `mayPublish`, which is correct but less precise.

### Step behaviour

| Step | Request(s) | Success |
|---|---|---|
| `resolve_mentions` | for each distinct handle from `mentionHandles(text)`: `com.atproto.identity.resolveHandle({ handle })` **without** `authorization`, all in parallel | `continue` with `mentions[handle] = did` (2xx with a valid did) or `null` (4xx). `blobs` unchanged |
| `upload_image_<n>` | `fetch(media[n-1].url)` → checks (D11) → `uploadBlob(bytes, { encoding: mimeType })` | `continue` with `blobs[n-1] = blob.ipld()` |
| `create_post` | `createRecord({ repo: did, collection: "app.bsky.feed.post", record })` (§6) | `done` (D17) |

### Outcome table (`classify(err, kind)`)

`kind` is `read` (resolve), `upload` (image fetch and uploadBlob) or `publish` (createRecord).

| Condition | `read` / `upload` | `publish` (`mayPublish`) |
|---|---|---|
| HTTP 401, or 400 + `ExpiredToken` | `upload`: `retryable_error` + `credentialsExpired`. `read` is sent unauthenticated, so it treats these as "other 4xx" | `retryable_error` + `credentialsExpired` (no write happened) |
| HTTP 429 | `retryable_error`, `notBefore = rateLimitNotBefore(headers)` | same |
| Pre-send failure (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN` in the cause chain) | `retryable_error` | `retryable_error` |
| Abort or timeout (`ctx.signal`) | `retryable_error` | **`ambiguous`** |
| Reset mid-response / unreadable body (status `Unknown`, not pre-send) | `retryable_error` | **`ambiguous`** |
| 2xx failing lexicon output (`XRPCInvalidResponseError`) or failing D17 | `retryable_error` (upload) | **`ambiguous`** |
| 5xx | `retryable_error` | **`ambiguous`** |
| Other 4xx | `read`: the handle → `null`. `upload`: `fatal_error` "Bluesky refused image <n> (<error name>)." | `fatal_error` "Bluesky rejected the post (<error name>: <message ≤ 200 chars>). If it mentions an image, use Retry to upload the images again." |
| Image fetch: non-2xx or network | `retryable_error` "Image <n> could not be read from storage; will retry." | — |
| Image check fails (size > 2,000,000, type mismatch, type not allowed) | `fatal_error` "Image <n> no longer matches what was prepared for Bluesky. Edit the post or re-upload the image." | — |
| Anything else | `retryable_error` | **`ambiguous`** |

Error strings:

- They include only the platform error *name* and, for a 4xx on `create_post`, the platform `message`, truncated to 200 characters.
- They never include tokens, headers, request bodies or URLs.
- The engine also redacts them against every credential string leaf.

## 6. The `create_post` record

```ts
const rt = buildFacets(content.text, state.mentions ?? {});   // { text, facets, counts }
const record = {
  $type: "app.bsky.feed.post",
  text: content.text,
  createdAt: ctx.now.toISOString(),
  ...(rt.facets.length ? { facets: rt.facets } : {}),
  ...(state.blobs.length ? { embed: {
    $type: "app.bsky.embed.images",
    images: state.blobs.map((b, i) => ({
      image: BlobRef.fromJsonRef(b),
      alt: content.media[i]?.altText ?? "",
      ...(w && h ? { aspectRatio: { width: w, height: h } } : {}),   // w/h = content.media[i].width/height when both known
    })),
  }} : {}),
};
```

`buildFacets(text, mentions)` works as follows:

- `new RichText({ text })`, then `detectFacetsWithoutResolution()`.
- For each `app.bsky.richtext.facet#mention` feature, set `did = mentions[normaliseHandle(feature.did)]`. Drop the feature when that is `null` or `undefined`.
- Drop facets left with no features.
- Return the counts `{ links, mentions, tags, droppedMentions }` for the summary.

## 7. Summaries (D19)

```ts
request:  { step, imageIndex?, bytes?, mimeType?, graphemes?, textBytes?, images?, facets?: { links, mentions, tags, droppedMentions }, mentionsResolved?, mentionsUnresolved? }
response: { status?: number, error?: string /* platform error name */, retryAfterSeconds?: number }
```

## 8. Unit tests (`src/providers/bluesky/*.test.ts`, stubbed `fetch`, no DB)

- **`validate.test.ts`**:
  - 300 vs 301 graphemes built from family ZWJ sequences, skin-tone modifiers, flags and combining marks;
  - ≤ 300 graphemes but 3,001 bytes → `text_too_many_bytes`, while exactly 3,000 bytes is allowed;
  - 4 vs 5 images;
  - 2,000,000 vs 2,000,001 bytes;
  - a text-only post is valid;
  - an empty post is `empty_post`;
  - an unfixable image gives a blocking media error.
- **`facets.test.ts`**:
  - byte ranges for a link, a mention and a hashtag placed after emoji, accented letters and CJK, asserted as `Buffer.from(text).subarray(start, end).toString() === token`;
  - an unresolved mention is dropped, and its text is unchanged;
  - a mixed resolved and unresolved pair.
- **`steps.test.ts`**: the table in data-model §4, including invalid state and totality on random junk.
- **`session.test.ts`**:
  - connect success (stored shape, no password anywhere in the result), plus each failure row in §4;
  - PDS URL rules;
  - handle normalisation;
  - refresh success with rotation, a DID mismatch, every definitive row and the transient rows;
  - `jwtExp` / `needsRefresh` edges.
- **`publish.test.ts`**: every row of §5's outcome table for each step kind, plus:
  - text-only and 4-image success;
  - the record shape (alt `""` when none, `aspectRatio` only when dimensions are known, `createdAt` = `ctx.now`);
  - the `at://` URL parsing edges;
  - a step mismatch.
- **`errors.test.ts`**:
  - `rateLimitNotBefore`: delta-seconds, HTTP-date, junk, past values, and the 24 h cap;
  - `isPreSend` on nested causes.
- **Secrets**: every test above asserts that `JSON.stringify(result)` contains no `accessJwt`, `refreshJwt` or app password value.
