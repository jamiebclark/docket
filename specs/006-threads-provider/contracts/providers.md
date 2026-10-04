# Contract: provider framework changes (G9–G13) and the `threads` provider

All changes are optional additions or widenings. Existing providers compile and behave unchanged.

## G9 — counting rules (`src/providers/types.ts`, `src/providers/text.ts`)

```ts
export type BuiltInCountingRule = "graphemes" | "code_points" | "utf8_bytes";
export interface CustomCountingRule {
  kind: "custom";
  /** `[a-z0-9-]+`, shown as `TargetCheck.countingRule`. */
  name: string;
  /** Plural unit for messages: "Text is 501 characters; the limit is 500." */
  unit: string;
  /** Pure and total; never throws; returns a non-negative integer. */
  count(text: string): number;
}
export type TextCountingRule = BuiltInCountingRule | CustomCountingRule;

// text.ts
export function countText(text: string, rule: TextCountingRule): number;   // custom → rule.count(text)
export function countingRuleName(rule: TextCountingRule): string;           // built-in string or custom name
export function countingUnit(rule: TextCountingRule): string;               // "graphemes" | "characters" | "bytes" | custom unit
```

- `validateAgainstCapabilities` uses `countText` and `countingUnit`.
- `checkComposition` sets `count: countText(effectiveText, rule)` and `countingRule: countingRuleName(rule)`.
- The registry test asserts that every custom rule has a valid name and that `count("")` is `0`.
- **Invariant (tested with a throwaway provider)**: for any text, `TargetCheck.count` equals the `count` on `text_too_long` from validation, and the publish gate blocks exactly when the count exceeds `maxLength`.

## G10 — callback-address requirement (`OAuthConnectGroup`)

```ts
redirectRequirement?: {
  https: boolean;       // refuse non-https: callback addresses
  publicHost: boolean;  // refuse localhost, *.localhost, IPv4 and IPv6 literals
  reason: string;       // shown as is, e.g. "Threads needs an HTTPS address that is not localhost."
  doc?: string;         // repo-relative doc path with optional #anchor
};

// src/providers/connect.ts (pure, no server imports)
export function redirectUriProblem(group: OAuthConnectGroup, redirectUri: string): string | null;
```

## G12 — callback hint (`OAuthConnectGroup`)

```ts
/** Static, non-secret. Appended to the accounts banner after a failed or refused callback for this group. */
callbackHint?: string;
```

## G13 — account notes (`SocialProvider`)

```ts
/** Pure. Non-secret notes shown on the account card. Never receives credentials. A throw or a non-array → []. */
accountNotes?(input: { settings: Settings; credentialsExpireAt: Date | null }): string[];
```

## G11 — refresh results

The `RefreshResult` shape is unchanged. The scheduled section now honours `retryAt` on a transient result (see [scheduler.md](./scheduler.md)).

## The `threads` provider (`src/providers/threads/index.ts`)

```ts
export const threadsProvider: SocialProvider<ThreadsSettings, ThreadsState> = {
  key: "threads",
  displayName: "Threads",
  capabilities: threadsCapabilities,              // research D4
  defaultPublishLimit: { count: 250, windowSeconds: 86_400 },
  connect: { strategy: "oauth", group: threadsConnectGroup },
  settingsSchema: threadsSettingsSchema,          // data-model §2
  refreshCredentials: refreshThreads,             // research D7; no needsRefresh (FR-019)
  accountNotes: threadsAccountNotes,              // G13
  validate: validateThreads,                      // research D4
  stepFor: (state, _settings, content) => threadsStepFor(state, content), // data-model §5
  advance: (ctx) => advanceThreads(ctx),
};
```

- Registered by one line in `src/providers/registry.ts` (FR-001).
- `src/providers/threads/**` imports only `../types`, `../validation`, `../text`, `../connect` and `../meta/*` (the lint rule bans `src/server/**`).

### `threadsConnectGroup`

| Member | Value |
|---|---|
| `key` / `displayName` / `setupDoc` | `"threads"` / `"Threads"` / `"docs/meta-setup.md"` |
| `environment` | `THREADS_APP_ID`, `THREADS_APP_SECRET`, `THREADS_GRAPH_BASE` (data-model §7) |
| `redirectRequirement` | `{ https: true, publicHost: true, reason: "Threads needs an HTTPS address that is not localhost.", doc: "docs/meta-setup.md#local-https-for-threads" }` |
| `callbackHint` | "If Threads refused the login, check that this Threads account accepted the tester invite in Threads under Settings → Website permissions." |
| `authorizationUrl` | [threads-api.md § Authorization](./threads-api.md#authorization-browser-redirect-built-by-authorizationurl) |
| `exchangeCode` | code → short-lived → long-lived → profile → one candidate (data-model §4) |
| `describeCallbackError` | `access_denied` / `user_denied` → `cancelled`; else `platform_error` |
| `pasteToken.field` | `{ name: "accessToken", label: "Threads access token", secret: true }` |
| `pasteToken.help` | "Generate a Threads access token for your tester account (with threads_basic and threads_content_publish) in the Meta dashboard's Threads use case → User Token Generator, then paste it here. Unverified: where the generator lives may differ." |
| `pasteToken.exchange` | research D6 order |

Failure messages (no secrets; each says what to check):

- Code exchange refused: "Could not finish signing in with Threads (<scrubbed reason>). Check THREADS_APP_ID, THREADS_APP_SECRET, the redirect address and that the account accepted the tester invite (docs/meta-setup.md)."
- Long-lived exchange or profile refused: the same, with its own reason.
- Unreachable: "Threads could not be reached. Nothing changed. Try again."
