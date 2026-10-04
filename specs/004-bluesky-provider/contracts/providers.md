# Contract: provider framework changes (G1–G4)

These are generic changes to `src/providers/types.ts`, `src/providers/registry.ts` and their rules. Each one is recorded in `docs/decisions.md` (what, why, how to reverse) and documented in `docs/adding-a-provider.md`. Type shapes are in [data-model.md §6](../data-model.md#6-framework-type-changes-srcproviderstypests).

## G1 — `connectAccount` and richer `CredentialField`

```ts
connectAccount?(input: {
  fields: Readonly<Record<string, string>>;   // declared names only, already normalised by the framework (below)
  now: Date;                                  // engine clock
  signal: AbortSignal;                        // aborted after CONNECT_TIMEOUT_MS (15 s)
}): Promise<ConnectResult>;
```

**Framework duties** (`accounts.connectWithCredentials`, before calling the hook):

1. Keep only declared field names; unknown keys are ignored.
2. **Non-secret** values are trimmed. **Secret** values are passed exactly as typed, never trimmed.
3. Empty and `optional` → `defaultValue ?? ""`. Empty and required → field error "Enter <label>." with no hook call.
4. Each value is at most 2,048 characters, otherwise a field error.

**Provider duties**:

- Provider-specific checks (handle shape, URL rules) come first and return `{ ok:false, field, message }` without any network call.
- Make **at most one** sign-in request.
- Never throw for an expected refusal. A throw is mapped to a generic "Could not connect. Try again." message, and the error text is not shown.
- `message` must be readable and must contain no secret. The framework also redacts it using the secret field values as a backstop.
- `retryAt`, when known, is rendered as "Try again after <local time>".
- On `ok:true`:
  - `externalId` is stable per platform account;
  - `credentials` is JSON-serialisable;
  - `settings` must pass `settingsSchema`.

## G2 — publish-time refresh hooks

```ts
needsRefresh?(credentials: unknown, now: Date): boolean;   // pure; no I/O; must not throw (return false when unsure)
```

- **Proactive**: the engine calls `needsRefresh` with the decrypted credentials before `advance`. When it returns true (and `refreshCredentials` exists), the engine refreshes first ([scheduler.md §2](./scheduler.md#2-publish-time-refresh-execute)).
- **Reactive**: a `retryable_error` with `credentialsExpired: true` asks the engine to refresh after recording the result.
  - It is legal **only** when the platform definitively rejected the access credential, which proves nothing was published. It is allowed on any step, including a `mayPublish` one.
  - On any other kind it is ignored.
- `advance` must never refresh credentials itself, and never call a library that does so on its own.

## G3 — `RefreshResult`

```ts
| { ok: true; credentials; expiresAt; displayName?: string }
| { ok: false; reason: string; transient?: boolean; retryAt?: Date }
```

- `transient: true` means the platform did not say the credential is bad: network error, timeout, 5xx, 429, or an unclassified response. The engine keeps the account `active`. See [scheduler.md §3](./scheduler.md#3-shared-refresh-core-and-the-scheduled-section).
- Without `transient`, the failure is a **definitive refusal**, and the account becomes `needs_reauth`. This is unchanged from decision 002.
- `displayName`, when it differs from the stored one, replaces `social_accounts.display_name` (FR-025).
- `reason` must be secret-free; the engine still redacts it.

## G4 — `stepFor` sees content shape; `advance` sees the leased step

```ts
stepFor(state: State | null, settings: Settings, content: StepContent): StepInfo;   // StepContent = { text, mediaCount }
interface PublishContext { …; step: StepInfo }
```

- `stepFor` must still be **pure and total**: an answer for every `state`, including `null` and malformed values.
- `content` is the target's effective text and media count at claim time.
- `advance` should compare `ctx.step` with the step it would run. On a mismatch it returns `retryable_error` with no request sent.

## Registry invariants (`src/providers/registry.test.ts`, extended)

For every registered provider:

- the key is unique and matches `[a-z0-9-]+` (existing);
- media constraints are consistent (existing);
- **new**:
  - `connectAccount` ⇒ `connect.strategy ∈ {credentials, manual-token}` with ≥ 1 field;
  - field names are unique and match `[a-zA-Z][a-zA-Z0-9]*`;
  - `defaultValue` ⇒ `optional`;
  - `secret` ⇒ no `defaultValue`;
  - `needsRefresh` ⇒ `refreshCredentials`;
- **new**: `stepFor` is total, so `stepFor(<malformed>, parsedDefaultSettings, {text:"", mediaCount:0})` does not throw.

`registry.ts` gains exactly one line: `blueskyProvider as SocialProvider`.

## Import boundary (unchanged, still enforced)

`src/providers/**` must not import `src/server/**` (`tests/lint/import-boundaries.test.ts`). The Bluesky provider imports only `zod`, `@atproto/api` and `../text`, `../validation`, `../types`.
