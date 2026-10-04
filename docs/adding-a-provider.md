# Adding a provider

A platform is one folder under `src/providers/<key>/` and one line in
`src/providers/registry.ts`. The scheduler, services and schema never change.
The contract lives in `src/providers/types.ts`; the `mock` provider
(`src/providers/mock/`) is the worked example.

## 1. Checklist

- [ ] Create `src/providers/<key>/index.ts` exporting a `SocialProvider`.
- [ ] Put non-secret settings in `settings.ts` (a zod schema; `z.object({})` if none).
- [ ] Add one line to `providers` in `src/providers/registry.ts`. The key must be unique and match `[a-z0-9-]+`.
- [ ] Write `<key>.test.ts` next to it with mocked HTTP: `validate` and every `advance` result, including the ambiguous paths.
- [ ] Update this guide if you introduced a new pattern.

`src/providers/**` must not import from `src/server/**`. A lint test enforces it.

## 2. The `SocialProvider` contract

| Field | Meaning |
|---|---|
| `key` | Lowercase `[a-z0-9-]+`, unique. Stored in `social_accounts.provider_key`. |
| `displayName` | Shown in the UI. |
| `capabilities` | Limits the shared validator checks (section 3). |
| `defaultPublishLimit?` | `{ count, windowSeconds }` (section 8). |
| `connect` | How an account is connected (section 4). |
| `settingsSchema` | Zod schema for non-secret per-account settings (section 5). |
| `refreshCredentials?` | Renew credentials before they expire (section 9). |
| `validate(content, caps)` | Returns `ValidationIssue[]`. Usually `validateAgainstCapabilities`, plus provider-specific codes. |
| `stepFor(state, settings)` | Pure, total: names the next step and says whether it `mayPublish` (section 6). |
| `advance(ctx)` | Does one bounded unit of work and returns a `StepResult` (section 7). |

## 3. Capabilities and counting rules

`capabilities.text` has `maxLength` and a `countingRule`:

- `graphemes`: user-perceived characters (`Intl.Segmenter`). `"👨‍👩‍👧‍👦"` is 1.
- `code_points`: `[...text].length`. The same emoji is 7.
- `utf8_bytes`: `Buffer.byteLength`. The same emoji is 25.

Use the rule the platform itself uses. `capabilities.media` sets `maxImages` (0 = none), `allowedMimeTypes`,
`maxBytesPerFile` and `required`. `textOnlyAllowed` and `postTypes` finish the picture.
Everything is checked by `validateAgainstCapabilities` in `src/providers/validation.ts`.

### Declaring media constraints

Image rules live in `capabilities.media`, inside the provider's own folder. Nothing else changes when a platform's rules do.
Beyond the fields above, a provider may declare:

- `outputMimeType`: what to convert to when a source type is not accepted (default: the first `allowedMimeTypes`);
- `minWidth`, `maxWidth`, `minHeight`, `maxHeight`;
- `minAspectRatio`, `maxAspectRatio` (width ÷ height);
- `maxAltTextLength`.

`mediaConstraintsOf(capabilities)` in `src/providers/media.ts` normalises these, and the pure `planImage` decides per image whether to
send the original, derive a variant (convert, downscale, compress) or refuse it (aspect ratio out of range, below the minimum size).
Derived variants are generated at compose time and cached by constraint hash. Fixable mismatches surface as `info` notes, not errors.
`validate` therefore judges the content as it will be sent; do not re-implement image adaptation in a provider.

## 4. Connect strategies and where credentials live

`connect` is one of `oauth`, `credentials` (named fields, e.g. a handle and app password) or `manual-token`.
Whatever the flow, it ends by calling `accounts.saveConnectedAccount`. Credentials are encrypted at rest.
The engine decrypts them and passes them to `advance` as `ctx.account.credentials`; a provider never touches storage.

## 5. Settings vs credentials

- **Settings** are non-secret and stored as plain jsonb: a region, a page id, a mock behaviour. They are parsed by
  `settingsSchema` and arrive as `ctx.account.settings`.
- **Credentials** are secrets: tokens, passwords. They are encrypted and appear only as `ctx.account.credentials`.

If you are unsure, it is a credential.

## 6. `stepFor`, `mayPublish` and state

A publish can take several steps (create a container, wait for processing, publish it).
`stepFor(state, settings)` returns `{ name, mayPublish }` for the step that `advance` would run next.

- It must be **pure and total**. It returns an answer for every state, including `null` (first step).
- `mayPublish: true` marks a step whose request can make the post public.
- `state` is whatever a `continue` result returned. The engine stores it between ticks as plain jsonb and hands it back.
- If the engine loses track of a step (killed tick, provider throws, timeout), `mayPublish` decides: true means `ambiguous`, false means retry.

## 7. Each `StepResult`

| Result | Use when | Engine action |
|---|---|---|
| `continue` | The step worked and another is needed. | Persists `state`, resets the attempt count, releases the lease, schedules the next step (after `notBefore`) in a **later** tick. |
| `done` | The post is live and you have its id. | `published`, stores `externalId` / `url`. |
| `retryable_error` | You are **sure** nothing was published. | Backoff; `failed` at the cap. `notBefore` overrides the backoff. |
| `fatal_error` | The platform definitively rejected it. | `failed` at once. |
| `ambiguous` | The request that could publish was sent and you cannot tell if it took. | `ambiguous`. Never retried; a human resolves it. |

**When to return `ambiguous`:**

| Situation | Return |
|---|---|
| Connection refused / DNS failure before sending | `retryable_error` |
| 5xx or 429 *before* the create call, or on a read-only/container step | `retryable_error` |
| 4xx on the create call (validation, permission) | `fatal_error` |
| Timeout or abort **after** sending a `mayPublish` request | `ambiguous` |
| Connection reset mid-response on a `mayPublish` request | `ambiguous` |
| 2xx you cannot parse, on a `mayPublish` request | `ambiguous` |
| Timeout on a step with `mayPublish: false` | `retryable_error` |

Never return `retryable_error` from a `mayPublish` step unless you know the request was not sent.
`advance` does **one** bounded unit of work: no polling loops, no sleeps. Return `continue` with `notBefore` instead.
Honour `ctx.signal` on every network call.

## 8. Publish limits

Set `defaultPublishLimit` (e.g. Instagram `{ count: 100, windowSeconds: 86400 }`) and the engine enforces it:
targets over the limit wait rather than fail. An account can override it with its own limit.
The provider does no counting.

## 9. `refreshCredentials` and `needs_reauth`

Implement `refreshCredentials({ account, credentials, now, signal })` for expiring tokens. The engine calls it ahead of
expiry. Return `{ ok: true, credentials, expiresAt }` to store the new credentials, or `{ ok: false, reason }`.
A failure marks the account `needs_reauth`: its targets stop publishing until the user reconnects.
Do not throw for an expected refusal; return `ok: false`.

## 10. Testing with mocked HTTP only

Tests never make live calls. Stub `fetch` (e.g. `vi.stubGlobal("fetch", ...)`) and assert on each result:
`done`, `continue`, `retryable_error`, `fatal_error` and every `ambiguous` path (timeout after send,
unparseable 2xx, reset). Cover `validate` against the capability edges. A throwaway provider can be registered
in a test to prove the engine needs no change (`tests/integration/scheduler/provider-plugin.test.ts`).

## 11. The no-secrets rule

Secrets exist only in the HTTP request itself. Never put them in `error`, `summary`, `state`, thrown messages or logs.
`state` is stored as plain jsonb, so keep tokens out of it. The engine redacts as a backstop, not a licence.

## 12. Worked example: the `mock` provider

`src/providers/mock/index.ts` is a complete provider in about 100 lines:

- `settingsSchema` has a `behaviour` (`succeed`, `multi_step`, `retryable`, `fatal`, `ambiguous`, `rate_limited`, `throw`)
  so tests can script any outcome.
- `stepFor(null)` is `publish` (with `mayPublish`) or, for `multi_step`, `create_container` (without).
  With state `{ done: n }` it yields `create_container` until `n` reaches `steps`, then `publish`.
- `advance` maps each behaviour to a `StepResult`, sleeping `delayMs` through `ctx.signal`.
- `refreshCredentials` succeeds or fails per the `refresh` setting.
- Registered by a single line in `registry.ts`.
