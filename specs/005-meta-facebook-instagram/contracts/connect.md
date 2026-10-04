# Contract: OAuth connect flow, chooser and token paste (generic, G5/G6)

The service is `src/server/services/connect.ts` and the repository is `src/server/dal/connect-attempts.ts` ([data-model §1](../data-model.md)). The route handler, Server Actions and pages are under `src/app/`. Nothing here names Meta. The group comes from the registry.

## Service functions

```ts
export interface ConnectGroupView {
  key: string;
  displayName: string;
  providerNames: string[];          // ["Facebook", "Instagram"]
  configured: boolean;
  setupDoc: string | null;
  redirectUri: string;              // `${BETTER_AUTH_URL}/connect/callback`
  paste: { label: string; help: string } | null;
}

/** Requires account:view. Lists every registered group, whether or not it is configured. */
listConnectGroups(scope): Promise<ConnectGroupView[]>;

/** Requires account:manage; group configured. Purges expired attempts, inserts one, returns the dialog URL. */
startOAuthConnect(scope, input: { groupKey: string }, session: { sessionId: string }): Promise<{ url: string }>;

/**
 * The callback. Never throws for expected failures. Order: shape → lookup by hash → binding (user + session) →
 * scope (forProject + account:manage) → consume (conditional UPDATE) → platform error? → exchange → store.
 */
handleOAuthCallback(input: { query: URLSearchParams; session: SessionWithId | null }): Promise<
  | { kind: "invalid" }                                                     // → /connect/invalid
  | { kind: "failed"; projectSlug: string; code: CallbackFailureCode }      // → /p/<slug>/accounts?connect=<code>
  | { kind: "ready"; projectSlug: string; attemptId: string }               // → /p/<slug>/accounts/connect/<id>
>;
type CallbackFailureCode = "cancelled" | "platform_error" | "exchange_failed" | "no_candidates" | "not_allowed";

/** Requires account:manage. Exchanges the pasted token, creates a ready attempt. Never echoes the token. */
pasteConnectToken(scope, input: { groupKey: string; token: string }, session): Promise<
  { ok: true; attemptId: string } | { ok: false; message: string }
>;

/** Requires account:manage, same user + session, ready and unexpired. Secrets never leave the server. */
getConnectChoice(scope, attemptId: string, session): Promise<{
  groupDisplayName: string;
  expiresAt: Date;
  candidates: CandidateView[];
  missing: { accountId: string; displayName: string; providerName: string }[];
  notices: string[];
} | null>;   // null → the page shows "This connection attempt has expired or is not valid. Start again."

/** One transaction: lock attempt, save the chosen ones in place, complete + discard ciphertext. */
chooseConnectCandidates(scope, input: { attemptId: string; selected: string[] /* candidate keys */ }, session): Promise<
  { ok: true; saved: AccountView[] } | { ok: false; message: string }
>;
```

- `saveConnectedAccount` is split into the existing public function plus an internal `saveConnectedAccountTx(tx, input)`, so the chooser can save several accounts in its own transaction. The behaviour is unchanged.
- `listConnectableProviders` excludes `oauth` providers from the credentials list. The page renders them through `listConnectGroups` instead.

**Network calls**: `exchangeCode` and `pasteToken.exchange` run **outside** any transaction, with `AbortSignal.timeout(15_000)` (the same as `CONNECT_TIMEOUT_MS`).

**Messages** (fixed text, US2):

| Case | Message |
|---|---|
| invalid / expired / reused / foreign state | "This connection attempt has expired or is not valid. Start again." |
| `cancelled` | "Connecting was cancelled. Nothing changed." |
| `platform_error` | "Facebook returned an error. Nothing changed. Try again." (the group's `describeCallbackError`) |
| `exchange_failed` | the group's message, e.g. "Could not finish signing in. Check the Meta app id, secret and redirect address (docs/meta-setup.md)." |
| `no_candidates` | the group's message (for Meta, which permissions are needed) |
| `not_allowed` | "Only project owners and admins can connect accounts." |
| chooser submitted with nothing ticked | "Nothing was connected." |

## Routes and pages

| Path | Kind | Notes |
|---|---|---|
| `/connect/callback` | Route Handler `GET` | Calls `handleOAuthCallback` and responds with `redirect(...)` (outside `try`). Not public: the proxy's session gate applies. Always `Cache-Control: no-store`. |
| `/connect/invalid` | page | Static text and a link to `/`. It reveals no project. |
| `/p/[projectSlug]/accounts` | page (existing) | New: one "Connect `<group>`" section per group (owners and admins), with a start button, a paste form, and the "not configured" state showing the setup doc and a copyable redirect URI. Also a reconnect for `needs_reauth` oauth accounts (start again, or paste), and a `?connect=<code>` banner (alert role). |
| `/p/[projectSlug]/accounts/connect/[attemptId]` | page | Chooser: a fieldset per Page with a checkbox, and its Instagram account as a nested checkbox. "Already connected" / "Needs reconnecting" badges, notes, the missing list, the expiry time, and Connect / Cancel. Editors get `notFound()`. |

## Server Actions (`src/app/p/[projectSlug]/accounts/actions.ts`)

```ts
startOAuthConnectAction(slug, { groupKey }): Promise<ActionResult<never>>       // redirect(url) on success
pasteConnectTokenAction(slug, { groupKey, token }): Promise<ActionResult<never>> // redirect(chooser) on success; never echoes token
chooseConnectCandidatesAction(slug, { attemptId, selected }): Promise<ActionResult<{ saved: number }>> // refresh + redirect(accounts)
```

The session id comes from `getSession()` on the server. It is never a client input.

## Authorization matrix (added to `tests/integration/actions-authz.test.ts`)

| Action / route | owner | admin | editor | non-member |
|---|---|---|---|---|
| start, paste, choose | ✔ | ✔ | forbidden | not_found |
| callback with a valid state | ✔ | ✔ | `not_allowed`, no exchange | `invalid` |
| chooser page | ✔ | ✔ | 404 | 404 |
