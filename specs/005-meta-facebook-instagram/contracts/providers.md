# Contract: provider framework changes (G5–G8)

All changes are in `src/providers/types.ts` and `src/providers/registry.ts`. They are additive for `credentials` and `manual-token` providers: `mock` and `bluesky` change by zero lines. The only existing type that changes shape is the unused `{ strategy: "oauth" }`. No provider uses it today.

## G5 — OAuth connect groups and candidates

```ts
export interface ProviderEnvIssue { name: string; reason: string } // messages never carry values

export interface ConnectCandidate {
  providerKey: string;
  externalId: string;
  displayName: string;
  settings: unknown;
  credentials: unknown;
  expiresAt: Date | null;
  /** Shown nested under this candidate in the chooser (e.g. Instagram under its Page). */
  parent?: { providerKey: string; externalId: string };
  notes?: readonly string[];
}

export type CandidatesResult =
  | { ok: true; candidates: readonly ConnectCandidate[]; notices?: readonly string[] }
  | { ok: false; message: string };

export interface OAuthConnectGroup {
  /** `[a-z0-9-]+`, unique among groups. Stored in `connect_attempts.group_key`. */
  key: string;
  /** "Facebook Pages and Instagram". Used in "Connect <displayName>". */
  displayName: string;
  /** Repo-relative doc shown when the group is not configured, e.g. "docs/meta-setup.md". */
  setupDoc?: string;
  /** G8. Pure, reads only `source`. */
  environment: {
    variables: readonly { name: string; secret: boolean; required: boolean }[];
    issues(source: Readonly<Record<string, string | undefined>>): ProviderEnvIssue[];
    configured(source: Readonly<Record<string, string | undefined>>): boolean;
  };
  /** Pure. The absolute URL of the platform's login dialog. */
  authorizationUrl(input: { state: string; redirectUri: string }): string;
  /** Server-side code exchange → candidates. Must not throw for expected refusals. */
  exchangeCode(input: { code: string; redirectUri: string; now: Date; signal: AbortSignal }): Promise<CandidatesResult>;
  /** Maps the callback's error query (e.g. a cancelled login) to a plain message. Default: a generic message. */
  describeCallbackError?(params: URLSearchParams): { code: "cancelled" | "platform_error"; message: string };
  /** G6. A token generated in the platform's tools → the same candidates. */
  pasteToken?: {
    field: CredentialField; // secret: true
    help: string;
    exchange(input: { token: string; now: Date; signal: AbortSignal }): Promise<CandidatesResult>;
  };
}

export type ConnectStrategy =
  | { strategy: "oauth"; group: OAuthConnectGroup }
  | { strategy: "credentials"; fields: readonly CredentialField[] }
  | { strategy: "manual-token"; fields: readonly CredentialField[] };
```

**Rules**

- A provider with `strategy: "oauth"` must not define `connectAccount`. Its accounts are created only from candidates.
- A candidate's `providerKey` must be a registered provider whose `connect.group.key` equals the group's key. The framework drops, and `console.warn`s with the key only, any candidate that breaks this, has invalid settings, or duplicates an earlier `(providerKey, externalId)`.
- `exchangeCode` / `pasteToken.exchange` return messages that must not contain secrets. The framework still runs them through `redact()`, with the submitted token and code as known secrets.
- Credentials in candidates are stored through the same encryption as `saveConnectedAccount` (AAD `social_account:<id>`).

## G6 — pasted token

This is `OAuthConnectGroup.pasteToken` above. The token is trimmed, checked to be 20–2048 characters, never stored, and never echoed.

## G7 — credentials invalid

```ts
export type StepResult = (
  | { kind: "continue"; state: unknown; notBefore?: Date }
  | { kind: "done"; externalId: string; url?: string }
  | { kind: "retryable_error"; error: string; notBefore?: Date; credentialsExpired?: boolean }
  | { kind: "fatal_error"; error: string; credentialsInvalid?: true }
  | { kind: "ambiguous"; error: string }
) & { summary?: AttemptSummary };
```

- `credentialsInvalid: true` means the platform said these credentials are dead (for Meta, Graph code 190). The engine marks the account `needs_reauth` and fails the target with no retry. See [scheduler.md](./scheduler.md).
- Return it from a `mayPublish` step only when the platform's response proves nothing was published.

## G8 — group-declared environment

This is `OAuthConnectGroup.environment` above. `src/server/provider-env.ts`:

```ts
export function providerEnvIssues(source: Record<string, string | undefined>): EnvIssue[]; // every group's issues, de-duplicated
export function isGroupConfigured(groupKey: string, source?: Record<string, string | undefined>): boolean;
```

`runStartup` reports `[...parseEnv issues, ...providerEnvIssues]` in one `formatEnvIssues` block, then exits 1. Unit tests cover the merge.

## Registry

```ts
export function listConnectGroups(): readonly { group: OAuthConnectGroup; providers: readonly SocialProvider[] }[];
export function findConnectGroup(key: string): { group: OAuthConnectGroup; providers: readonly SocialProvider[] } | undefined;
```

`registry.ts` gains two lines:

```ts
export const providers = [mockProvider, blueskyProvider, facebookProvider, instagramProvider] as SocialProvider[];
```

That is one line per provider, plus their imports.

**Registry invariants** (`registry.test.ts`, extended):

- Group keys match `[a-z0-9-]+`. One key maps to exactly one group object (identity).
- An `oauth` provider has no `connectAccount`.
- Every group's `environment.variables` names are `[A-Z][A-Z0-9_]*` and listed in `.env.example`. This is a test that reads the file.
- `pasteToken.field.secret === true`.
- The existing invariants still hold for every provider: `stepFor` totality on malformed state, consistent media constraints, and `settingsSchema.parse({})` succeeds.
