# Contract: the settings surface

**Feature**: `specs/065-per-project-llm` | Phase 1

Follows the `docket-ui` skill and `docs/design-system.md`. No new UI primitive: `PageHeader`, `Card`,
`Field`, `SegmentedControl`, `Button`/`buttonStyles`, `Alert`, `Dialog`, `LocalTime` all exist.

## 1. Where it lives

A settings sub-page, **`/p/[projectSlug]/settings/model`**, beside API keys and Webhooks (L15).

| File | Kind | What it does |
|---|---|---|
| `src/app/p/[projectSlug]/settings/model/page.tsx` | server | `forProject` → `getProjectLlm(scope)`; `ForbiddenError`/`NotFoundError` → `notFound()` |
| `src/app/p/[projectSlug]/settings/model/loading.tsx` | server | `Skeleton`, matching the api-keys page |
| `src/app/p/[projectSlug]/settings/model/ModelPanel.tsx` | client | the form, the check button and the remove dialog |
| `src/app/p/[projectSlug]/settings/model/actions.ts` | server actions | `saveProjectModel`, `removeProjectModel`, `checkProjectModel` |
| `src/app/p/[projectSlug]/settings/layout.tsx` | server | one more sub-nav item, behind `llm_credential: ["manage"]` |

**Nav label**: "Model & API key". **Page title**: "Model & API key". **Description**: "Which model this
project generates with, and whose provider credit it spends."

### Role awareness (FR-014, SC-005, spec 028's convention)

- An **editor** sees no sub-nav item — absent, not disabled. The layout already filters by permission;
  one more `scope.can({ llm_credential: ["manage"] })` call joins the existing `canManageApi` call.
- An **editor** who types the URL gets `notFound()` — the api-keys precedent, so existence is not
  revealed.
- Every action re-checks on the server and refuses whatever the UI showed.

## 2. What the page shows

```text
┌ Model & API key ─────────────────────────────────────────────────────────────┐
│ In use now:  Anthropic · claude-… · this project's own key                   │
│              (or)  Anthropic · claude-… · this Docket's key                  │
│              (or)  Generation is not configured for this project. Set: …     │
│              (or)  [danger] This project's stored API key cannot be read. …  │
│                                                                              │
│ Last changed by Jamie on 12 October 2026 at 14:03                            │
│                                                                              │
│ [ Check this credential ]                                                    │
│   → result line: source=…, provider, model, outcome, how long it took        │
├─ This project's own credential ─────────────────────────────────────────────┤
│ Provider      (•) OpenAI   ( ) Anthropic          SegmentedControl           │
│ Model id      [____________________]              Field, hint: no spaces…    │
│ API key       [••••••••••••••••••••]              Field type=password        │
│               Leave blank to keep the key already stored.                    │
│                                                      [ Save ]                │
│                                                                              │
│ [ Remove this project's credential ]              danger, opens a Dialog     │
└──────────────────────────────────────────────────────────────────────────────┘
```

Rules:

- **No character of the key is ever rendered** — no prefix, no last-four, no length, no masked
  placeholder of the real length (FR-013, FR-015, K7). "A key is stored" / "No key is stored" is the whole
  status.
- The key `Field` is `type="password"`, `autoComplete="off"`, with **no `defaultValue` and no `value`**
  (L16).
- `keyMaxLength` comes from the server view and is applied as `maxLength`; no literal in the component
  (`tests/lint/ui-limit-literals.test.ts`'s convention).
- Provider is a `SegmentedControl` (two short options, never a native `<select>`).
- The instant in "Last changed …" goes through `LocalTime` in the project's time zone — one date format.
- The "in use now" line is text, not colour alone. The unreadable-key state uses `Alert` `danger` with
  `LLM_KEY_UNREADABLE`; everything else is plain text in a `Card`.
- No section mentions spend, tokens or cost (out of scope — entry 3).

### The remove dialog (FR-017, K13, L19)

`Dialog` with `dismissOnBackdrop={false}`, title **"Remove this project's credential?"**, body naming the
project and saying: *"Generation in <project> will go back to the model and API key configured for this
Docket, and this project's stored key will be deleted. This cannot be undone."* Confirm button is danger
styling and reads "Remove credential". One confirmed action; the submit works with client JavaScript
unavailable through the form's own action.

### The check control (FR-019, FR-020)

One button, "Check this credential", that submits a form (works without client JavaScript), shows a
pending state on the button itself, and renders the outcome in a `role="status"` region:

| Outcome | Rendered |
|---|---|
| success | "Worked. <Provider> · <model> · this project's own key (or: this Docket's key) · answered in 1.8 s." |
| failure | the one fixed `llmFailureMessage(kind)` sentence, with the same source/provider/model line |
| not configured | the existing "Set: …" list |
| key unreadable | `LLM_KEY_UNREADABLE` |
| refused for the cooldown | `LLM_CHECK_BUSY` |

No provider error text, no key, no part of a key, no HTTP status, no SDK message (FR-011, FR-020, K10).

## 3. Server actions

`src/app/p/[projectSlug]/settings/model/actions.ts`, each returning the house
`ActionResult<T>` through the existing `runAction(slug, fn)` helper, so `ForbiddenError` → the generic
refusal and `ValidationIssuesError` → `fieldErrors`.

```ts
saveProjectModel(slug, prev, formData): Promise<ActionResult<ProjectLlmView>>
removeProjectModel(slug): Promise<ActionResult<ProjectLlmView>>
checkProjectModel(slug): Promise<ActionResult<LlmCheckResult>>
```

- The `FormData` is read into the shared Zod schema; the raw key string is never put into a returned
  value, a thrown message, a log line or a revalidation tag (FR-010).
- `revalidatePath` on the settings page after a save or a removal.
- No action result has a field whose value is or contains the key, in any encoding — asserted by the
  secret scan (L32).

## 4. Batch jobs notices (FR-028, L26)

`CreditHoldNotice` gains one prop:

```tsx
<CreditHoldNotice since={hold.since} scope={hold.scope} timeZone={tz} />
```

The sentence order is unchanged; the account sentence is chosen by `scope`:

- `"project"` → `CREDIT_HOLD_ACCOUNT_PROJECT` ("Add credit to this project's own provider account.")
- `"install"` → the existing `CREDIT_HOLD_ACTION` ("Add credit to the provider account.")

Everything else about the two screens is untouched: `role="note"`, the "paused since" instant through
`LocalTime`, "none of them has failed, and nobody needs to retry them", the waiting row's reason, cancel
and "Retry failed items". A funded project shows no notice because `generationCreditHold` asks only about
*its* owner (AS 3.6).

The job page's not-configured notice gains one branch: when resolution says `key_unreadable`, it renders
`LLM_KEY_UNREADABLE` instead of the "Set: …" list (FR-012).

## 5. Accessibility

- Every control has a visible `<label>`; the key field's hint and error are linked through
  `aria-describedby` by `Field` already.
- Errors are in `Field`'s `aria-live="polite"` region; the check outcome is a `role="status"`; the
  unreadable-key alert is `Alert`'s `role="alert"`.
- Full keyboard operation: the `SegmentedControl` is radio semantics, the `Dialog` is a native `<dialog>`
  with `showModal()` focus trapping and focus return, and every submit is a real form submit.
- Visible focus comes from the shared control styles; nothing relies on colour alone.
- Empty/error/loading: `loading.tsx` renders a `Skeleton`; a project with no credential is not an "empty
  state" but a described default (`LLM_SOURCE_INSTALL`).

## 6. Not built here

- No screen anywhere shows spend, tokens or cost (entry 3).
- No notification, email or activity event is produced by a credential change or a failed check (the
  notifications roadmap owns attention events).
- No change to the Generate, Voice, Compose, Review, Media or Accounts screens. A project's resolved
  model is not displayed on them; they behave exactly as today, on whatever the project resolves to.
