# Contract: generic credential connect (G1) — service, action, UI

## 1. Service: `src/server/services/accounts.ts`

```ts
export type ConnectOutcome =
  | { ok: true; account: AccountView }
  | { ok: false; message: string; fieldErrors?: Record<string, string>; retryAt?: Date };

export async function connectWithCredentials(
  scope: ProjectScope,
  input: unknown,   // { providerKey: string; fields: Record<string, string>; accountId?: string }
): Promise<ConnectOutcome>;
```

Order. Every refusal happens **before** any network call unless stated.

1. Zod-parse the input:
   - `providerKey`: string;
   - `fields`: `Record<string, string>` with each value ≤ 2,048 characters;
   - `accountId`: optional uuid.
2. `require(scope, "manage")`. An editor gets `ForbiddenError`, and **no** platform request is made (US1-AS5).
3. The provider must exist and have `connectAccount`, otherwise `NotFoundError("That provider is not available.")`.
4. **Reconnect** (`accountId` set): the account must exist in scope and not be removed (`NotFoundError` otherwise), and its `providerKey` must match (`ConflictError` otherwise).
5. Build the field values per [providers.md G1](./providers.md#g1--connectaccount-and-richer-credentialfield). A missing required field → `{ ok:false, fieldErrors }`.
6. `provider.connectAccount({ fields, now: clock.now(), signal: AbortSignal.timeout(15_000) })`, **outside any transaction**. A throw → `{ ok:false, message:"Could not connect. Try again." }`.
7. On `ok:false`, return `{ ok:false, message: redact(message, secretFieldValues), fieldErrors: field ? { [field]: same } : undefined, retryAt }`.
8. Reconnect only: if `result.account.externalId !== account.externalAccountId` → `{ ok:false, message:"That is a different <provider> account. Sign in as <account.displayName> to reconnect it, or connect it as a new account." }`.
9. `saveConnectedAccount(scope, { providerKey, externalAccountId, displayName, settings, credentials, credentialsExpireAt })`. This is the existing upsert. It updates an existing row with the same provider and external id in place, sets it `active` and clears `last_error` (US1-AS6, US5-AS5). It then encrypts with the row-id AAD.
   - A unique-violation race (two connects of the same new DID at once) is retried once as an update.
10. Return `{ ok:true, account: view }`.

`connectMock` / `reconnectMock` are unchanged.

`listConnectableProviders` adds `credentialConnect: boolean`, which is `connectAccount` present and the mock gate passed. Field metadata (names, labels, help, defaults) is non-secret and may go to the client.

## 2. Server action: `src/app/p/[projectSlug]/accounts/actions.ts`

```ts
export async function connectCredentialsAction(
  slug: string,
  input: { providerKey: string; fields: Record<string, string>; accountId?: string },
): Promise<ActionResult<accounts.AccountView>>;
```

- It goes through `mutate(slug, …)`, so the route refreshes on success.
- `ConnectOutcome.ok === false` → `fail("validation", message, fieldErrors)`. `retryAt` is folded into `message` as text by the service ("Try again after HH:MM <zone>"), using the project time zone.
- **Never** echo `input.fields` back in any result. The action result contains no field values.
- `tests/integration/actions-authz.test.ts` gains a row: owner and admin ✓, editor → `forbidden`, and no fake-PDS request is recorded for the editor.

## 3. UI: accounts screen (`page.tsx` + new `ConnectCredentialsForm.tsx`)

Follow the `docket-ui` skill: server component page, a client leaf form, labelled controls, visible focus, keyboard only.

- **Connect section**, shown when `canManage`. For each provider with `credentialConnect`, a `<section aria-labelledby>` headed "Connect a <displayName> account" contains `ConnectCredentialsForm`. The mock form keeps its own place, gated as it is today.
- **`ConnectCredentialsForm`** props: `{ slug, providerKey, providerName, fields: CredentialField[], accountId?, submitLabel }`.
  - Render one `Field` per declared field, in the declared order:
    - `label` → `<label>`, and `help` → `hint` (via `aria-describedby`);
    - `placeholder` is passed through;
    - `defaultValue` pre-fills the input;
    - a required field gets `required` and `aria-required`.
  - **Secret** fields use `type="password"` and `autoComplete="new-password"`. They are cleared after **every** submit, success or failure, and never re-populated (FR-005).
  - Non-secret fields use `autoComplete="off"` and `spellCheck={false}`. A field named like a URL may use `inputMode="url"`.
  - Pending state: the button shows "Connecting…" and is `aria-disabled`.
  - Failure: field errors appear on their fields, and the form-level `message` goes in `role="alert"`. Focus moves to the first invalid field, or to the alert.
  - Success: the form resets to defaults, and a polite live region announces "Connected <displayName>".
- **Reconnect**: in an account card where `status === "needs_reauth"` and the provider has `credentialConnect` and `canManage`, a "Reconnect" disclosure (a `<details>` or the existing `Dialog`) holds the same form with `accountId` and `submitLabel="Reconnect"`. The existing "Needs reconnecting" badge and the app-wide banner are unchanged. The banner links to `#account-<id>`.
- Editors see neither the connect section nor reconnect controls (US1-AS5). The server enforces this independently (§1 step 2).
- No credential, token or app password ever reaches props, the page HTML or an action result (SC-007). `tests/integration/no-plaintext.test.ts` is extended.

## 4. Tests

- **`tests/integration/accounts-credentials-connect.test.ts`** (real DB, fake PDS through stubbed `fetch`, Bluesky provider):
  - success: the row, the decrypted credentials and the settings; the app password appears nowhere in the DB dump, the action result or the captured console;
  - the default PDS is used when the field is blank, and a custom PDS receives the request (AS1-1, AS1-2);
  - every failure row from [bluesky.md §4](./bluesky.md#4-connect-and-refresh-sessionts) → no row created or modified;
  - a rate-limited attempt shows the retry time;
  - the same DID twice → one row, updated in place;
  - reconnect with the same DID → `active` with `last_error` cleared, while a different DID is refused and leaves the row untouched;
  - an editor is refused with zero PDS requests;
  - an invalid PDS URL or handle is rejected with zero PDS requests.
- **`tests/integration/accounts-ui.test.ts`** (extended): the connect section renders the declared fields with the right `type` / `autocomplete` / `required`. Editors see no form.
- **Composer**: `tests/integration/compose-check-route.test.ts` (extended). A Bluesky target returns the grapheme count, `text_too_long` at 301, `text_too_many_bytes`, `too_many_images` and the adaptation notes.
