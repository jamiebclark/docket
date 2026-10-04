# Contract: settings screens, job page changes and server actions (009)

Every screen follows the `docket-ui` skill:

- server components by default, with client leaves only for forms and dialogs;
- labelled fields, with help text through `aria-describedby`;
- errors next to the field, announced politely, with focus moved to the first invalid field;
- one primary action per form, right-aligned;
- destructive actions confirmed in a dialog that names the thing;
- `loading.tsx`, empty, `error.tsx` and populated states;
- statuses shown as text plus colour;
- times shown in the project time zone with `LocalTime`.

Read `node_modules/next/dist/docs/01-app/` before writing UI (AGENTS.md). Reuse `Dialog`, `CopyField`, `Table`, `StatusBadge`, `Field`, `Button`, `EmptyState` and `LiveRegion` from `src/components/ui/`.

## Routes

| Route | Kind | Purpose |
|---|---|---|
| `/p/[projectSlug]/settings/api-keys` | server page + `loading.tsx` + client `CreateKeyForm`, `ShowOnceDialog`, `RevokeKeyDialog` | FR-041, API keys |
| `/p/[projectSlug]/settings/webhooks` | server page + `loading.tsx` + client `EndpointForm`, `ShowOnceDialog`, endpoint row actions | FR-041, Webhooks |
| `/p/[projectSlug]/settings/webhooks/[endpointId]` | server page + `loading.tsx` | delivery log, resend, send test, edit, rotate |
| `/p/[projectSlug]/settings` (layout) | changed | the sub-nav gains "API keys" and "Webhooks", shown only when `scope.can({ api_key: ["manage"] })` |
| `/p/[projectSlug]/jobs/[jobId]` | changed | the "Open: accepting items" state and the "Close job" action |
| `/p/[projectSlug]/settings/members` (activity list) | changed | labels for the new audit actions |

An editor who opens a settings URL directly gets `notFound()`, because the service throws `ForbiddenError` and the page maps it to not found. That matches the existing settings pages. The page titles are "API keys" and "Webhooks", and the endpoint page is titled "Webhook: {host}".

## API keys page

- **Header**: "API keys" (h1). Below it: "Keys let tools like n8n use this project's API. Each key works only in this project, only for the permissions you tick." Then links: "API reference (OpenAPI)" → `/api/v1/openapi.json`, and "n8n guide" → the README anchor that links `docs/n8n.md`.
- **Create form** (`<form>`, server action `createApiKeyAction`):
  1. **Name** (text, required, 1–64). Help: "For example: n8n."
  2. **Permissions** (fieldset with a legend, checkboxes; at least one). `read` is preselected. Each box has help text:
     - `read`: "See accounts, media, posts, slots and jobs."
     - `write_posts`: "Upload media, create posts, add them to the queue or schedule them."
     - `generate`: "Generate a post with the model."
     - `manage_jobs`: "Create generation jobs, add items, close, retry and cancel them."
     - `auto_approve`: "Let this key skip review: posts it generates can be approved, and queued, without anyone checking them." This one is shown with warning styling.
  3. **Rate limit** (number, 1–1,000, default 60). Help: "Requests per minute."
  4. **Expiry** (`Select`): Never, 30 days, 90 days, 365 days.

  The primary button reads "Create key". It is disabled only while pending and shows "Creating…".
- **Show-once dialog** (opens after a successful create; client state only, never in the URL or a cookie):
  - title "Copy your new key";
  - `CopyField` holding the key;
  - the text "This is the only time the key is shown. Store it somewhere safe, such as an n8n credential.";
  - an "I have stored this key" button that closes the dialog and refreshes the list.

  Escape and the close button behave the same. The plaintext lives only in the action's return value and component state, and is dropped on close.
- **Table** (`<table>`). Its columns:
  - Name;
  - Key (`dkt_…AbCd`, in monospace);
  - Permissions (comma list);
  - Rate limit ("60/min");
  - Created by (the name, plus "(no longer a member)" when applicable);
  - Created;
  - Last used ("Never" or `LocalTime`);
  - Expires ("Never" or `LocalTime`);
  - Status (badge: `active` green "Active", `expired` grey "Expired", `revoked` grey "Revoked {date} by {name}");
  - Actions ("Revoke…", only for active and expired keys).
- **Revoke dialog**: "Revoke the key "{name}"? Anything using it stops working on its next request. This cannot be undone." Buttons "Revoke key" (destructive) and "Cancel". A concurrent revoke shows "This key was already revoked." in the live region.
- **Empty**: "No API keys yet. Create one to connect n8n or another tool." The form is shown directly below.
- **Errors**: field errors from `fieldErrorsFromZod`. The 25-key cap shows the service message as a form error.

## Webhooks page

- **Header**: "Webhooks" (h1), plus "Docket can tell another service when posts publish or fail, when a job finishes, or when an account needs reconnecting." Then a link to "Verifying webhook signatures" (`docs/n8n.md` section, via the README link).
- **Add form** (`createEndpointAction`):
  - URL (required). With `http:` it shows the warning "This address is not encrypted (http). Use https unless the receiver is on your own network." The warning does not block.
  - Description (optional, ≤ 200).
  - Events (fieldset, checkboxes, at least one): "Post published", "Post failed", "Job finished", "Account needs reconnecting".
  - Primary button "Add endpoint". The cap of 10 shows the service message.
- **Show-once secret dialog**: as for keys, titled "Copy the signing secret". It reuses `ShowOnceDialog`.
- **Table**:
  - Endpoint (host + path, linking to the endpoint page);
  - Description;
  - Events;
  - Status (badge: "Enabled" green; "Disabled: receiver said it is gone (410)", "Disabled: 20 deliveries failed in a row" or "Disabled" grey);
  - Last delivery ("Succeeded {time}" / "Failed {time} ({status})" / "None yet");
  - Actions ("Enable" / "Disable", "Delete…").
- **Delete dialog**: names the endpoint host: "Delete the webhook to {host}? Its delivery log is deleted too."
- **Empty**: "No webhook endpoints yet. Add one to get notified instead of polling."

## Endpoint page (`/settings/webhooks/[endpointId]`)

- **Summary**: URL, description, events, status, and when the secret was last rotated. During an overlap it shows "Old secret still accepted until {time}".
- **Actions**:
  - "Edit" (the same form, prefilled; `updateEndpointAction`);
  - "Send test event" (`sendTestEventAction`, which then announces "Test event queued. It is sent on the next scheduler tick.");
  - "Rotate secret…". Its confirm dialog reads "A new secret is created now. For the next 24 hours deliveries are signed with both the new and the old secret, so you can update the receiver without missing events." It is followed by the show-once dialog.
- **Delivery log** (table, newest first, 50 per page): Event (type + id short form), Created, Status (badge: Pending / Sending / Succeeded / Failed), Attempts ("3 of 8"), Next attempt, Last result (status code or error kind) and "Resend". Each row expands with a `<details>` element (keyboard accessible by default) to list its attempts: time, result, duration and response excerpt (in monospace, max 1,000 characters).
- **Empty log**: "No deliveries yet. Send a test event to check the receiver."

## Job page changes

- **Open job**: the status area shows the badge "Open: accepting items" (blue, with text) beside the usual status. A "Close job" button (secondary) has the confirm dialog "Close the job "{summary}"? No more items can be added. It finishes once every item is done." It calls `closeJobAction` → `jobs.closeJob`. An empty open job shows the service message "Add at least one item or cancel the job."
- Jobs and posts created with a key show "API key: {name}" as their creator in the jobs list, the job page and the post page.

## Server actions

All are in `src/app/p/[projectSlug]/settings/{api-keys,webhooks}/actions.ts` and the existing `jobs/actions.ts`. Each:

1. resolves `forProject(session, slug)`;
2. calls one service;
3. returns `ActionResult`;
4. calls `revalidatePath` for its page.

| Action | Service | Returns |
|---|---|---|
| `createApiKeyAction(slug, formData)` | `apiKeys.createApiKey` | `{ ok: true, data: { secret, key } }`. The secret is never logged. |
| `revokeApiKeyAction(slug, id)` | `apiKeys.revokeApiKey` | `{ ok: true, data: { revoked, message? } }` |
| `createEndpointAction(slug, formData)` | `webhooks.createEndpoint` | `{ ok: true, data: { secret, endpoint } }` |
| `updateEndpointAction(slug, id, formData)` | `webhooks.updateEndpoint` | endpoint |
| `setEndpointEnabledAction(slug, id, enabled)` | `webhooks.setEndpointEnabled` | – |
| `deleteEndpointAction(slug, id)` | `webhooks.deleteEndpoint` | – |
| `rotateSecretAction(slug, id)` | `webhooks.rotateSecret` | `{ secret }` |
| `resendDeliveryAction(slug, deliveryId)` | `webhooks.resendDelivery` | – |
| `sendTestEventAction(slug, endpointId)` | `webhooks.sendTestEvent` | – |
| `closeJobAction(slug, jobId)` | `jobs.closeJob` | – |

`tests/integration/actions-authz.test.ts` gains every action × role:

- owner and admin are allowed;
- editors are refused for keys and webhooks, and allowed for `closeJob`, matching `cancelJob`;
- non-members get not found.

A UI test (`tests/integration/api-keys/ui.test.tsx`) renders the page states and checks:

- that the list markup never contains the plaintext after create (FR-006);
- the show-once dialog;
- the revoke confirmation text.
