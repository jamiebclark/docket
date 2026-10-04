# Contract: connect service and accounts screen (G10, G12, G13)

Changes to `src/server/services/connect.ts`, `src/server/services/accounts.ts`, `src/app/connect/callback/route.ts` and `src/app/p/[projectSlug]/accounts/*`. Nothing here names Threads.

## `listConnectGroups(scope)` → `ConnectGroupView[]`

```ts
interface ConnectGroupView {
  // existing: key, displayName, providerNames, providerKeys, configured, setupDoc, redirectUri, paste
  /** configured && redirectUriProblem(group, redirectUriFor()) === null */
  available: boolean;
  /** Set when configured but the callback address does not qualify (G10). */
  unavailable: { reason: string; doc: string | null } | null;
}
```

## `startOAuthConnect(scope, { groupKey }, session)`

The existing order, with one new check:

1. Parse the input.
2. `account:manage` (`ForbiddenError`).
3. The group exists (`NotFoundError`).
4. The group is configured (`NotFoundError`).
5. **New (G10)**: `redirectUriProblem(group, redirectUriFor())` is null, otherwise `ForbiddenError(reason)`. This happens **before** the purge, the state row and the redirect URL.
6. Purge, create the state, return the URL (unchanged).

The Server Action already maps errors to `{ ok: false, message }`, so the reason appears under the button.

## `pasteConnectToken(...)`

Unchanged. It is **not** subject to G10, so the paste fallback stays available.

## `handleOAuthCallback(params, caller)` → `CallbackOutcome`

```ts
| { kind: "accounts"; projectSlug: string; groupKey: string; code: "cancelled" | "platform_error" | "exchange_failed" | "no_candidates" | "too_many" | "not_allowed" }
```

Only `groupKey` is added (G12). Its value is the attempt's stored `group_key`, never a query parameter from the platform.

## `GET /connect/callback`

- `accounts` → redirect to `/p/<slug>/accounts?connect=<code>&group=<groupKey>`.
- Other outcomes are unchanged.

## Accounts page (`page.tsx`)

- **Banner**: `CONNECT_BANNER[code]`. When `group` names a registered group with a `callbackHint` and the code is `platform_error`, `exchange_failed` or `no_candidates`, the hint is appended as a second sentence. An unknown `group` is ignored.
- **`ConnectGroupSection`**:
  - not configured → as today;
  - configured, unavailable (G10) → for owners and admins, the text "<reason> See <code>{doc}</code>." in place of the Connect button, then the paste form when the group has one. Editors see the reason only;
  - available → as today.

  Keyboard, labels and `role="alert"` behaviour follow the `docket-ui` skill.
- **Reconnect buttons** (`ReconnectGroupButton`) render only for groups that are `configured && available`. For an unavailable group, the card points to the group's paste form above ("Paste a new token in Connect <group> to reconnect.").
- **Account card**: below the "Connected …" line, each string in `AccountView.notes` (G13) renders as a `<p class="text-sm">`. With no notes there is no extra markup.

## `listAccounts(scope)` → `AccountView[]`

`notes: string[]` is added, from `provider.accountNotes?.({ settings: parsedSettings, credentialsExpireAt })`. A throw, a non-array or an unknown provider → `[]`. Strings are capped at 300 characters each and 5 notes. Credentials are never decrypted for this.

## Threads notes and messages shown

| Where | Text |
|---|---|
| Unavailable connect | "Threads needs an HTTPS address that is not localhost. See `docs/meta-setup.md#local-https-for-threads`." |
| Callback banner hint | "If Threads refused the login, check that this Threads account accepted the tester invite in Threads under Settings → Website permissions." |
| Chooser note (paste saved as is) | "Expiry estimated: Docket could not confirm when this token expires and assumes 60 days. Paste a freshly generated token for the best estimate." |
| Account note (while estimated) | "Token expiry is estimated (about <YYYY-MM-DD>). Docket renews it automatically before then." |
| Chooser note (publish not granted) | "Publishing permission was not granted. Connect again and allow it." |

## Authorization (unchanged rules, re-tested for Threads)

Start, callback, chooser, choose and paste require `account:manage` on the server. Editors get no connect action, no paste form and no reconnect button. `tests/integration/actions-authz.test.ts` gains rows for an unavailable group.
