# Research: Bluesky provider

**Feature**: `004-bluesky-provider` | **Date**: 2026-10-03 | **Plan**: [plan.md](./plan.md)

Sources used in planning:

- `docs/research/bluesky.md` (checked 2026-10-02). These are the platform facts.
- The **installed** `@atproto/api` **0.22.0** and its dependencies under `node_modules/.pnpm/`: `@atproto/xrpc` 0.8.14, `@atproto/lexicon` 0.7.15 and `@atproto/lex-data` 0.1.7. These are the library facts, read from `dist/*.d.ts` and `dist/*.js`.
- The current Docket framework source: `src/providers/types.ts`, `src/server/scheduler/{publishing,token-refresh,record,redact}.ts`, `src/server/dal/{scheduler,accounts}.ts`, `src/server/services/accounts.ts` and the accounts screen.

Labels used below: **[src]** = read in an installed package's source or types; **[docs]** = from `docs/research/`; **[code]** = read in Docket's own code. Nothing here comes from memory. Where a fact could not be verified, it says so.

---

## Part 1 — NEEDS RESEARCH items from the spec

### R1 — Rate-limit headers (when a limit resets, and in what units)

**Finding: not settleable from installed sources.**

- **[src]** `@atproto/xrpc` maps HTTP 429 to `ResponseType.RateLimitExceeded`, and `XRPCError` carries the response headers as `err.headers`. The keys are lower-cased, because they come from `Object.fromEntries(response.headers.entries())`.
- **[src]** Neither `@atproto/api` 0.22.0 nor `@atproto/xrpc` 0.8.14 reads any rate-limit header. No installed atproto package names one.
- **[docs]** `docs/research/bluesky.md` says the rate-limit docs page did not load. Its numbers are approximate, and it gives no header names.

**Decision (D3)**:

- Docket honours only the generic HTTP `Retry-After` header. Its two forms are delta-seconds and an HTTP-date.
- The Bluesky-specific reset header (its name and units) stays **NEEDS RESEARCH**. It is recorded in `docs/decisions.md` as a follow-up for the `platform-researcher` agent.
- Without a usable header, the engine's normal backoff applies. Spec US6-AS3 already allows this.
- Header reading lives in one pure function, `rateLimitNotBefore(headers, now)` in `src/providers/bluesky/errors.ts`. Adding the Bluesky header later is a one-line change plus a test, with no change to the framework.
- Guards:
  - an unparseable value is ignored;
  - a time in the past is ignored;
  - a value beyond 24 h is capped at 24 h.

**Alternatives rejected**:

- Guessing the Bluesky header names: this breaks constitution I.
- Treating every 429 as "wait a fixed hour": this is slower than the engine's backoff for short limits.

### R2 — "Access session expired" vs "credentials invalid"

**[src]** The legacy `CredentialSession.fetchHandler` in `@atproto/api/dist/atp-agent.js` treats a request as having an expired access token when:

```
initialRes.status === 401 || (status === 400 && body.error === 'ExpiredToken')
```

**[src]** `CredentialSession._refreshSessionInner` treats a refresh failure as a **bad refresh token** (the session is dropped) when the error is an `XRPCError` with:

```
status === 401 || error === 'InvalidDID' || error in ['ExpiredToken', 'InvalidToken']
```

It treats every other failure as transient ("Assume the problem is transient and the session can be reused later"). The `refreshSession` lexicon client declares `AccountTakedownError`, `InvalidTokenError` and `ExpiredTokenError`. The `createSession` client declares `AccountTakedownError` and `AuthFactorTokenRequiredError`.

**Decision (D2)**: Docket uses the library's own rules.

- **Publish call (upload, create, resolve) → `credentialsExpired`**: HTTP 401, or 400 with error `ExpiredToken`. The PDS checks auth before it writes, so this response proves nothing was posted. The library itself replays the request in exactly this case.
- **Refresh, definitive refusal (→ `needs_reauth`)**:
  - HTTP 401;
  - error `ExpiredToken`, `InvalidToken` or `AccountTakedown`;
  - a returned DID different from the stored DID (Docket's check, which mirrors the library's `InvalidDID`).
- **Refresh, transient (G3)**: everything else. That is: no response (network error, abort or timeout), 5xx, 429, any other 4xx, or an unparseable 2xx.
- **Sign-in (`createSession`)**:
  - 401 → "handle or app password not accepted";
  - error `AuthFactorTokenRequired` → "use an app password";
  - error `AccountTakedown` → "this account is suspended";
  - 429 → "try again later", with the time from `Retry-After` when present;
  - no response, or an invalid response → "the server could not be reached or is not a Bluesky server";
  - any other 4xx → "not accepted", with the platform's error name only (no body).

### R3 — How the installed client exposes sessions and rich text, and whether tests can stub HTTP

All points below are **[src]**.

- **Version gap.** The installed version is 0.22.0; the research describes 0.23.0. The 0.22.0 constructor is **`new CredentialSession(serviceUrl: URL, fetch?, persistSession?)`**, with positional arguments. The class's doc comment shows an options object, which is wrong for this version.
- **`Agent`.** `new Agent(options: SessionManager | FetchHandler | FetchHandlerOptions)`. Here `FetchHandlerOptions = { service: string | URL | () => …, headers?: { [k]: Gettable<string|null> }, fetch?: typeof fetch }`. Generated namespaces are available as `agent.com.atproto.server.createSession(data, { signal, headers })`, `agent.com.atproto.server.refreshSession(undefined, { headers, signal })`, `agent.com.atproto.repo.uploadBlob(data, { encoding, signal })`, `agent.com.atproto.repo.createRecord(data, { signal })` and `agent.com.atproto.identity.resolveHandle({ handle }, { signal })`.
- **Why Docket must not use `CredentialSession` / `AtpAgent` for publishing.** Its `fetchHandler` refreshes the session on its own when it sees an expired token, and then **replays the request**. That refresh happens inside the provider call:
  - it is not serialised across processes;
  - it rotates the refresh token, and the new token is persisted only if a `persistSession` callback is given;
  - it would count as part of the may-publish step.

  This is exactly gap G2. Docket therefore builds a plain `Agent` from `FetchHandlerOptions` for each call, sets the `authorization` header itself, and never lets the library refresh.
- **Errors.** `XrpcClient.call` wraps everything thrown in `XRPCError.from(err)`:
  - A non-2xx response becomes `XRPCError(status, body.error, body.message, headers)`.
  - A fetch rejection (network, abort or timeout) becomes `XRPCError(ResponseType.Unknown = 1)`, with `cause` set to the original error.
  - A body that cannot be read or parsed also comes out as status `Unknown`, with the parse error as `cause`.
  - A 2xx whose body fails lexicon output validation becomes `XRPCInvalidResponseError` (status `InvalidResponse`).
  - 5xx statuses keep their numeric value (`httpResponseCodeToEnum`).
- **Stubbing HTTP.** `buildFetchHandler` uses `options.fetch ?? globalThis.fetch`, captured when the agent is built. Docket builds an agent per call and passes `fetch: (input, init) => globalThis.fetch(input, init)`. So `vi.stubGlobal("fetch", fakePds)` intercepts every request, and the library itself is never mocked.
- **Rich text.** `new RichText({ text })` provides:
  - `detectFacetsWithoutResolution()`, which finds link, mention and tag facets with **UTF-8 byte** offsets (`UnicodeString` uses `TextEncoder`) and leaves the mention `did` holding the *handle*;
  - `detectFacets(agent)`, which resolves each mention through `com.atproto.identity.resolveHandle`, **swallows every error** and sets `did: ''`;
  - `graphemeLength`, which uses `@atproto/lex-data`'s `graphemeLen`. That is native `Intl.Segmenter` when available, the same mechanism as Docket's `countGraphemes`.
- **Exports.** `@atproto/api` exports `BlobRef` (with `fromJsonRef` / `ipld()` / `toJSON()`), `AtUri`, `RichText` and `XRPCError`. Request bodies go through `stringifyLex`, so a `BlobRef` (or its JSON `{ $type: "blob", ref: { $link }, mimeType, size }` form) serialises correctly.
- **Lexicon client types.** `createSession` output contains `accessJwt`, `refreshJwt`, `handle`, `did` and an optional `didDoc`. `createRecord` output contains `uri`, `cid` and optional `commit` / `validationStatus`.

---

## Part 2 — Framework gaps (fixed generically)

### G1 — Generic credential connect (D4)

**Decision**: add an optional provider hook and one generic path.

- `CredentialField` gains `optional?: boolean`, `defaultValue?: string` and `placeholder?: string`. `help` already exists.
- New optional `SocialProvider.connectAccount({ fields, now, signal }) → ConnectResult`. It exchanges the submitted fields for `{ externalId, displayName, settings, credentials, expiresAt }`, or returns `{ ok: false, message, field?, retryAt? }`.
- New service `accounts.connectWithCredentials(scope, { providerKey, fields, accountId? })`. It does the following, in order:
  1. Checks the `manage` role.
  2. Applies the declared fields: trims non-secret values, applies defaults, enforces required fields and a length cap.
  3. Calls the hook outside any transaction, with a 15 s timeout.
  4. On reconnect, refuses a different `externalId`.
  5. Saves through the existing `saveConnectedAccount` upsert.
- One server action and one generic client form, `ConnectCredentialsForm`, drive both connect and reconnect from the declared fields.
- The **mock provider is unchanged**. It declares `fields: []` and has no `connectAccount`, so it keeps its dev form (which has extra test knobs). The generic form is shown for any provider that implements `connectAccount`.

**Alternatives rejected**:

- A Bluesky-specific form or action: this breaks constitution V and FR-002.
- Doing the exchange in the client: this would expose secrets to the browser.

### G2 — Credential renewal while publishing (D5)

**Decision**: the **engine** owns publish-time refresh. The provider asks for it; it does not do it itself. There are two triggers:

1. **Proactive.** New optional pure hook `needsRefresh(credentials, now): boolean`. Bluesky decodes the access JWT's `exp` without verifying it, and answers true when `exp − now < 5 min`. When the hook says true, `execute()` refreshes **before** `advance`, outside any transaction.
2. **Reactive.** `retryable_error` gains an optional `credentialsExpired: true`. The provider may set it only when the platform definitively rejected the access credential (R2). The engine records the retryable result as usual, then refreshes when tick budget remains, so the retry uses fresh credentials.

Both triggers call one function, `refreshForPublish` in `src/server/scheduler/credentials.ts`:

- It acquires the account's **existing** refresh lease (`refresh_lease_owner` / `refresh_lease_until`) with one conditional `UPDATE`. The condition requires the account to be active and not removed, the lease to be free or expired, **and `credentials_encrypted` to still equal the ciphertext this caller read**.
- If no row is updated, it re-reads the account and classifies the result:
  - `changed`: someone else already refreshed, so the caller uses the persisted credentials;
  - `busy`: another caller holds the lease;
  - `unavailable`: the account was removed or flagged.
- It calls `provider.refreshCredentials` and **persists through `recordRefresh` under the lease token before returning** the new credentials. The rotated token is therefore stored before it is used.
- `busy` and `unavailable` **release the target's lease without counting an attempt**. This reuses the existing `released` attempt outcome; no enum change is needed. The next tick re-reads the persisted credentials, or fails the target through the existing needs-reauth rule.
- The scheduled section (`runTokenRefresh`) already claims through the same lease columns, so all callers in all processes are serialised. No session-level lock is used, which keeps Neon's pooler working.

**Why not a `ctx.refreshCredentials()` callback inside `advance`?** That refresh would run inside the may-publish step's timeout. If the engine's `withTimeout` fired during the refresh, the target would be marked `ambiguous` even though nothing was sent. FR-023 says the refresh must not count as the may-publish request. Keeping refresh outside `advance` also keeps providers away from storage, as `adding-a-provider.md` §4 requires.

**Why not let the library refresh?** See R3: it is unserialised, does not persist, and runs inside the step.

### G3 — Transient vs definitive refresh failures (D6)

**Decision**: `RefreshResult`'s failure case gains `transient?: boolean` and `retryAt?: Date`. The success case gains `displayName?: string`, for FR-025.

| Caller | `ok:false`, not transient | `ok:false, transient:true` | throws |
|---|---|---|---|
| Scheduled section | `needs_reauth` (unchanged, decision 002) | stays `active`; `last_error` set; lease released; retried next tick | `needs_reauth` (unchanged) |
| Publish-time (G2) | `needs_reauth`; target lease released (the next claim fails it with the existing `account_unavailable` rule) | target gets `retryable_error` (`notBefore = retryAt`); account stays `active` | treated as transient |

The mock's `refresh: "fail"` stays definitive, so 002's refresh tests are unchanged. A thrown error in the publish path is transient because the target's attempt cap bounds it. In the scheduled section, a throw still means `needs_reauth`, as decided in 002.

### G4 — `stepFor` cannot see the content (newly found) (D7)

**Problem**:

- **[code]** `stepFor(state, settings)` runs inside the claim transaction, before content is loaded.
- Bluesky's first step depends on the content:
  - with mentions → `resolve_mentions`;
  - with images → `upload_image_1`;
  - otherwise → `create_post`.
- Without the content, every post needs an extra non-publishing first step. That makes a text-only post take two ticks, which breaks SC-003.
- The alternative is to mark the first step `mayPublish` even when it only uploads. Then a crash or timeout race during a lookup or upload would be called `ambiguous`, which breaks US2-AS4 and FR-013.

**Decision**:

- `stepFor(state, settings, content: StepContent)`, where `StepContent = { text: string; mediaCount: number }`.
- The claim's `ClaimContext` gains `contentShape(target)`. This is a read of the target's effective text and its media count, inside the claim transaction. It is a DB-only read with no provider I/O, so the "no provider call in a held transaction" rule holds.
- `PublishContext` gains `step: StepInfo` (the leased step), so `advance` can refuse to run a different step if content changed between claim and call.
- A post that is gone when `execute` loads it now fails as `fatal_error` before any provider call. Before this change it fell into the generic catch, which made it `ambiguous` on a may-publish step.
- Existing `stepFor` implementations ignore the new argument (the mock and the test providers).

**Alternative rejected**: letting `continue` run the next step in the same tick. That would be a larger engine change: it would touch the "each tick advances a target at most once" rule, lease semantics and attempt accounting.

---

## Part 3 — Provider design decisions

| # | Decision | Rationale | Alternatives rejected |
|---|---|---|---|
| D1 | Each call builds an `Agent` from `FetchHandlerOptions`: `service` = `pdsUrl`, an `authorization` header from the stored access token (absent for sign-in and handle resolution), and `fetch` delegating to `globalThis.fetch`. Sign-in and refresh use the generated `com.atproto.server.*` methods with explicit headers. | Typed lexicon calls and the library's error mapping, with no hidden refresh (R3), and tests can stub HTTP. | `CredentialSession` / `AtpAgent` (auto-refresh); hand-rolled `fetch` calls (lose types and the lexicon output validation that FR-018 relies on to spot "unparseable 2xx"). |
| D8 | Step plan, chosen by `stepFor(state, settings, content)`:<br>1. `resolve_mentions` (mention facets present and `state.mentions` unset);<br>2. `upload_image_<n>` while `state.blobs.length < mediaCount`;<br>3. `create_post` (the only `mayPublish: true` step).<br>Invalid stored state gives `invalid_state` (`mayPublish: false`), and `advance` returns `fatal_error`. | FR-013 and SC-003. Totality is required: a bad state must never fall through to `create_post` without its images. | One upload step for all images (a failure re-uploads everything, and four uploads can exceed one provider timeout). |
| D9 | Mention resolution: the distinct handles from `detectFacetsWithoutResolution()` are resolved **unauthenticated** with `com.atproto.identity.resolveHandle` against the PDS, in parallel, under `ctx.signal`.<br>- A 4xx answer for a handle → `null` (it is dropped later).<br>- 429, 5xx, no response or timeout → `retryable_error` (429 with `Retry-After`).<br>The result `{ [handle]: did \| null }` goes into the state. | US2-AS3/AS4. `detectFacets(agent)` swallows transient errors and so silently drops mentions during an outage. It also cannot be split into a separate step. Unauthenticated calls cannot hit an expired token. | Resolving inside `create_post` (a lookup would sit inside the may-publish step). |
| D10 | Facets are built in `create_post`: `new RichText({ text })` → `detectFacetsWithoutResolution()` → each mention feature's `did` is replaced from `state.mentions` → mention features with no DID are removed → facets with no features left are removed. | FR-016: the official helper computes the byte offsets; the research says empty-DID mentions must be filtered. | Computing offsets by hand. |
| D11 | Upload step:<br>1. `fetch(media.url, { signal })` (the variant URL the engine resolved).<br>2. Require 2xx, read the body, and check `bytes ≤ 2,000,000` and `content-type` (without parameters) equal to the declared `mimeType`, and that type in `allowedMimeTypes`.<br>3. `uploadBlob(bytes, { encoding: mimeType, signal })`.<br>4. Store `blob.ipld()` JSON in `state.blobs[n]`.<br>A failed fetch or a 5xx from storage → retryable. A size or type mismatch → `fatal_error` ("image no longer matches; edit or re-upload"). | FR-015 and the spec's edge cases. One image per step keeps every step bounded. | Sending the original (forbidden); trusting the recorded size without checking. |
| D12 | **Accepted types: JPEG and PNG**, with `outputMimeType: image/jpeg`. | The lexicon accepts `image/*`, but conversion to JPEG is the 003 pipeline's tested path. GIF/WebP animation is out of scope. | Declaring `image/*` (animated or exotic formats would go untested). |
| D13 | Credentials JSON is `{ accessJwt, refreshJwt, did, handle }`. **The app password is never stored** (FR-007). `credentialsExpiresAt` = the refresh JWT's `exp`, decoded without verification. If that cannot be read: `now + 60 days`. | Research: the refresh session lasts 90 days and sign-in is rate-limited. The fallback keeps the account inside the scheduled refresh's reach, without refreshing on every tick. | Storing the app password (a leak would expose more, and repeated sign-ins hit the 30 / 5 min limit). |
| D14 | `settings = { pdsUrl }`.<br>- Must be `https:` with no username, password, query or fragment.<br>- The path must be empty or `/`; a trailing slash is stripped.<br>- Stored as the origin, e.g. `https://bsky.social`.<br>- The didDoc PDS endpoint is **not** followed. | **[src]** The library comment says the Bluesky entryway proxies requests to the right PDS. Keeping the user's address makes AS1.2 literally true. | Following didDoc (it would store a second, hidden endpoint). |
| D15 | Handle normalisation: trim, strip one leading `@`, lower-case. The value is sent as `identifier`. The stored handle and display name are the ones the **platform returns**. | Spec edge cases. | — |
| D16 | Errors are classified in one pure function, `classify(err, stepKind)`. See [contracts/bluesky.md](./contracts/bluesky.md) §5. A failure is "pre-send" only when the cause chain carries `ECONNREFUSED`, `ENOTFOUND` or `EAI_AGAIN`. Anything unrecognised on `create_post` is `ambiguous`. | The constitution's "a missed post beats a duplicate". An unknown failure falls the conservative way. | Treating every `TypeError: fetch failed` as pre-send (it can also mean a reset mid-request). |
| D17 | Success needs `uri` to parse with `AtUri`, with `host === did`, `collection === "app.bsky.feed.post"` and a non-empty `rkey`. Anything else is `ambiguous`. The URL is `https://bsky.app/profile/<credentials.handle>/post/<rkey>`. | FR-017 and US6-AS2. | Trusting any 2xx. |
| D18 | `createdAt = ctx.now.toISOString()` (the engine's DB clock). | FR-016. | Host clock. |
| D19 | Summaries hold only these keys:<br>- request: `step`, `imageIndex`, `bytes`, `mimeType`, `graphemes`, `textBytes`, `facets: { links, mentions, tags, droppedMentions }`, `images`;<br>- response: `status`, `error` (the platform error *name*), `retryAfterSeconds`.<br>No URLs, handles, tokens or bodies. | FR-020. `redact()` would also blank handles and DIDs, because they are credential string leaves. | — |
| D20 | No `defaultPublishLimit`. | Spec assumption: the write budget is far above personal use. | — |
| D21 | The 3,000-byte check is a provider-specific issue with code `text_too_many_bytes` (error, field `text`, `count`, `limit: 3000`). It is added after `validateAgainstCapabilities`. | FR-011. The `ValidationIssue.code` union already accepts provider strings. | Adding a second counting rule to `ProviderCapabilities` (a framework change nothing else needs). |
| D22 | No new runtime dependency. `@atproto/api` 0.22.0 is already in `package.json`. | Constitution VI. | — |
| D23 | Tests stub `globalThis.fetch` with a scripted fake PDS (`tests/helpers/fake-pds.ts`). It can return status, headers and body, hang until abort, reset mid-body, or fail before sending. It records each request with its auth header, so secret-absence checks can find the tokens. Engine-level tests use the real `runTick` against the test DB. | FR-027 and SC-002: no live calls, and the library is not mocked. | `vi.mock("@atproto/api")` (it would not test the real error mapping). |

## Remaining unverified items

- **U1 (R1)**: the Bluesky rate-limit reset header's name and units. Fallback: `Retry-After`, then engine backoff (D3).
- **U2**: whether `uploadBlob` and `createRecord` through the `bsky.social` entryway always proxy to the user's PDS. **[src]** The library comment says they do. This is verified with mocks only.
- **U3**: real platform behaviour overall. With no live credentials, it is "verified with mocks only" (constitution II, SC-009).
