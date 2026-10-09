# Contract: generic hooks G25–G28 (and the G13 `now`)

Each hook is optional, generic, and inert for a provider that does not use it (FR-001, FR-012–FR-015, FR-043). Each one is documented in `docs/adding-a-provider.md` (contract table, generic hooks index) and in `docs/decisions.md` (`## 026`, with how to reverse it).

## G25 — Per-target posting fields

### Types (`src/providers/types.ts`)

```ts
export interface PostingOptionView { value: string; label: string; disabled?: { reason: string } }

export type PostingFieldView = {
  /** `[a-z][a-zA-Z0-9]*`, unique; issues use `posting.<key>`. */
  key: string;
  label: string;
  help?: string;
  disabled?: { reason: string };
} & (
  | { kind: "choice"; value: string | null; options: PostingOptionView[]; required: boolean; placeholder: string }
  | { kind: "toggle"; value: boolean }
  | { kind: "text"; value: string; maxLength: number; countingRule: TextCountingRule; optional: true }
  | { kind: "fixed"; value: string; display: string; explanation: string; doc?: string }
);

export interface PostingDeclaration<Values = unknown, Details = unknown> {
  /** Parses stored or submitted values; a failure means "not set". */
  valuesSchema: z.ZodType<Values>;
  /** Pure, total. The fields to show for these values, details and post type, in order. `details` is null while loading or after a failed read. */
  view(input: { values: Values | null; details: Details | null; postType: PostType }): PostingFieldView[];
  /** Pure. A heading line for the panel, e.g. "Posting to Ada". */
  heading?(details: Details | null): string | null;
  /** Pure. An optional notice above the fields (e.g. the unaudited explanation). */
  notice?(): { text: string; doc?: string } | null;
  /** Pure. Short label shown beside the target's status everywhere (e.g. "Private on TikTok"). */
  targetNote?(values: Values | null): string | null;
  /** Pure. Extra lines for the requirements summary. */
  summaryNotes?(): string[];
  /** Pure. A line shown under the preview, e.g. TikTok's "may take a few minutes". */
  afterPreview?: string;
}
```

- `SocialProvider.posting?: PostingDeclaration<…>`.
- `PostContent.posting?: { values: unknown | null; details: unknown | null }`. Absent for a provider without `posting`. `values` is the parsed `posting_fields`, or null. `details` is the live details (composer check) or the consent's stored details (gate, engine), or null.
- `ValidationIssue.field` gains `"posting"`, `` `posting.${string}` `` and `"consent"`.

### Where values travel

| Caller | Reads | Writes |
|---|---|---|
| Composer check (`checkComposition`) | input `targets[].posting` (absent = stored) | nothing |
| Save (`createDraft`, `updatePost`) | input `targets[].posting` | `posting_fields`, after `valuesSchema` (an invalid value is a `ValidationIssuesError` on `targets.<i>.posting`). Absent keeps the stored value; `null` clears it. |
| Gate (`loadTargetContent` → `validateTargetContent`) | `posting_fields`, `consent_details` | — |
| Engine (`execute`) | `posting_fields`, `consent_details` → `PostContent.posting` for every step | — |

Issue order: `FIELD_RANK` in `posts/validate.ts` puts `posting*` and `consent` after `postType` and before `media`.

### Target notes and summary notes

- `targetNoteFor(providerKey, postingFieldsJson)` (`src/server/services/posts/notes.ts`) is the one helper. It returns `provider.posting?.targetNote?.(parsed ?? null) ?? null`, and a throw means null.
- `PostViewTarget.note`, `PostListItem.targets[].note`, the `target` member of `CalendarItem` and `TargetCheck.note` all come from it.
- `requirementsOf(caps, { …, notes })` copies `notes` into `RequirementsSummary.notes` (optional). `checkComposition` passes `provider.posting?.summaryNotes?.() ?? []`. `RequirementsSummary.tsx` renders them as a list under the summary when non-empty.

### Inertness tests

`tests/integration/compose/posting-hooks-inert.test.ts`:

- for every registered provider without `posting`: `TargetCheck.posting === null`, `note === null`, `requirements.notes` absent or empty;
- saving with `posting` set for such a provider leaves `posting_fields` null;
- the gate and the engine pass `PostContent` without `posting`.

## G26 — Live account details

```ts
export type AccountDetailsResult<D> =
  | { ok: true; details: D }
  /** `message` is plain text, secrets scrubbed, ≤ 300 chars. */
  | { ok: false; message: string; credentialsExpired?: boolean; transient: boolean };

export interface AccountDetailsReader<Settings = unknown, D = unknown> {
  schema: z.ZodType<D>;
  read(input: { account: { id: string; externalId: string; settings: Settings }; credentials: unknown; now: Date; signal: AbortSignal }): Promise<AccountDetailsResult<D>>;
}
```

- `SocialProvider.accountDetails?: AccountDetailsReader`.
- **Service** `readAccountDetails(scope, accountId, opts?: { fresh?: boolean })` in `src/server/services/account-details.ts`:
  1. `scope.can({ post: ["view"] })`, else `ForbiddenError`. The account must be in the scope and `active`.
  2. Cache hit (`< 60 s`, unless `fresh`): return it.
  3. Read the ciphertext through `forSchedulerProject(scope.project.id).accounts.getCredentialsCiphertext`, then decrypt it.
  4. If `provider.needsRefresh?.(credentials, now)`, call `refreshForPublish` (F8). `refreshed` or `changed` gives the new credentials. `busy` gives `{ ok: false, transient: true, message: "Couldn't load this <platform> account's options." }`. `refused` or `unavailable` gives the reconnect message.
  5. Call `read` with `AbortSignal.timeout(providerTimeoutMs)`. A thrown error is `transient`. A result with `credentialsExpired` is refreshed once more (step 4, forced) and read once more.
  6. Parse `details` with `schema`; a failure is "Couldn't load …". Cache only `ok`.
- The browser receives `details` only, never credentials or the raw reply.
- No transaction is held during the read. Callers are `checkComposition` (outside any transaction) and the save path, before its transaction opens.

## G27 — Explicit consent

```ts
export interface ConsentDeclaration<Values = unknown> {
  /** Pure. The declaration shown beside "I agree". */
  declaration(values: Values | null): string;
}
```

- `SocialProvider.consent?: ConsentDeclaration`. It requires `posting`. A `registry.test.ts` case checks that every provider declaring `consent` or `accountDetails` also declares `posting`.
- **Service** `src/server/services/posts/consent.ts`:
  - `consentFingerprint(input)`: data-model §5.
  - `consentStatus({ target, content: TargetContent, details })` → `valid | missing | stale`.
  - `consentIssue(provider)` → `{ severity: "error", code: "consent_required", field: "consent", message: "Tick 'I agree' to post to <displayName>." }`.
  - `recordConsentOnSave(tx, target, input, details)`: writes the record when `input.consent?.fingerprint` equals the recomputed fingerprint and `tx.actor.kind === "member"`. It clears a stale record. It returns whether consent is now valid.
  - `engineConsentRefusal(repos, target, provider, text)`: null when valid, otherwise "No consent recorded for this <displayName> post; nothing was posted."
- **Gate.** `validateTargetContent` adds `consentIssue` when the provider declares `consent`, `posting_fields` is set, and the status is not `valid`. When `posting_fields` is null, the provider's own `posting_required` issue stands alone (P5).
- **Engine.** In `execute()` the first-step block (after `validateResolvedContent`, before credentials) calls `engineConsentRefusal`. A refusal is a `fatal_error` on step `engine-validate`, and no provider call is made.
- **Composer.** The check input gains `targets[].consent?: { fingerprint: string }`. The response gains `TargetCheck.posting.consent = { declaration, fingerprint, agreed }`, where `agreed` means the input fingerprint equals the current one.

### Tests (`tests/integration/posts/consent.test.ts`)

- scheduling, queueing, publishing now, approving (auto-queue) and retrying a TikTok target without consent are each refused with "Tick 'I agree' to post to TikTok.";
- consent is recorded with user, time, fingerprint and details;
- editing the text, an override, the media, a video edit or a posting value makes it stale. A draft clears it. A scheduled target's edit without re-consent is refused (F5);
- an API-key actor's consent is ignored;
- a new post with the same values has no consent (F6);
- the engine refuses a target whose consent went stale after scheduling (simulated with a direct row update) on step `engine-validate`, with no fetch;
- a provider without `consent` is unaffected.

## G28 — `exchangeCode` receives the callback query

`OAuthConnectGroup.exchangeCode(input)` input gains `callbackParams: URLSearchParams`, a fresh copy of the callback's query. `handleOAuthCallback` passes `new URLSearchParams(params)`. The group must not echo it. Existing groups ignore it, and `tests/integration/connect/*` pass unchanged.

## G13 — `accountNotes` receives `now`

The input gains `now?: Date`. `notesFor` in `src/server/services/accounts.ts` passes the DB clock, read once per listing. Existing providers ignore it.
