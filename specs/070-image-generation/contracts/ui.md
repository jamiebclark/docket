# Contract — Interface: the Media page's "Generate an image" action

**Feature**: `070-image-generation` | Covers **FR-030 – FR-036**, G22 – G26, **P20 – P23**
Follows the `docket-ui` skill and `docs/design-system.md`.

---

## 1. Where it lives

Route: `/p/[projectSlug]/media` — the existing page. **No new route.** The spec's out-of-scope list
rules out a "Generated" library view, so there is nowhere else for this to be.

Files:

| File | Change |
|---|---|
| `src/app/p/[projectSlug]/media/page.tsx` | server component — computes the gate, renders the trigger in both storage-on branches |
| `src/app/p/[projectSlug]/media/GenerateImageDialog.tsx` | **NEW** client component — the trigger button, the dialog, the form, the live region |
| `src/app/p/[projectSlug]/media/actions.ts` | **+** `generateImageAction` |
| `src/components/media/MediaCard.tsx` | **+** the "Generated" badge and the prompt disclosure |

## 2. The gate

```ts
const canGenerateImage =
  status.enabled && scope.can({ media: ["generate"] }) && imageGenerationEnabled(scope);
```

| State | What the page shows |
|---|---|
| Storage off | The existing storage `EmptyState` and nothing else — the whole library is already replaced. The action is inside the `status.enabled` branch, so "hide the UI" needs no new condition (G26, FR-030, US4-1). |
| Storage on, no image provider configured | No trigger anywhere (FR-030, US4-3). |
| Storage on, provider configured, **editor** | No trigger anywhere. Absent, not disabled (G23, FR-031, US4-4). |
| Storage on, provider configured, **owner/admin** | The trigger, in both the empty-library branch and the populated branch (**P21**). |

The server refuses regardless of what the interface showed: the action calls `generateImage`,
which checks `media: ["generate"]` first (contracts/services.md § 7). An editor's hand-built
request is refused with no provider call and no asset (SC-008, US4-5).

## 3. The trigger

A `Button` with `variant="secondary"`, label **"Generate an image"**, placed directly under the
`UploadDropzone` in both branches — the two ways to get a picture into the library, side by side.
In the empty-library branch the `EmptyState` message is unchanged; the trigger sits above it with
the dropzone.

Keyboard: an ordinary button in document order. Opening the dialog moves focus into it;
`Dialog` returns focus to the trigger on close (`src/components/ui/Dialog.tsx`).

## 4. The dialog

`<Dialog open title="Generate an image" size="md" dismissOnBackdrop={false}>` — backdrop dismissal
is off because the dialog holds unsaved input, which is the documented rule for that prop.

| Control | Type | Rules |
|---|---|---|
| Prompt | `TextareaField`, `minRows={3}`, `maxRows={10}`, `required` | Label **"Describe the image"**. Hint (FR-036): *"Up to 1000 characters. Don't ask for a real, identifiable person — Docket tells the provider not to draw one."* `maxLength={1000}`; the client also refuses an empty or whitespace-only value, and the server refuses both again (FR-012, US1-4). |
| Shape | `ChoiceField` (renders a `SegmentedControl` at three options — **P23**) | `<legend>` **"Shape"**; options **Square**, **Portrait**, **Landscape**; default Square (`DEFAULT_IMAGE_ASPECT`). The names are Docket's; the pixels are the adapter's (G5). |
| Submit | `Button pending={pending} pendingLabel="Generating…"` | Disabled only while pending or while the prompt is empty/over-length — never otherwise (`docket-ui`: "Disable submit only while pending"). One primary action. |
| Cancel | `Button variant="secondary"` | Closes the dialog. The typed prompt is kept in component state, so re-opening does not lose it. |

No size field: the interface offers the three aspects, never pixels (**P9**).

## 5. States and announcements

`LiveRegion` is **kept mounted** throughout and only its `message` changes — an element added
together with its text is often not announced (`src/components/ui/LiveRegion.tsx`).

| State | Live region | Screen |
|---|---|---|
| Idle | `""` | the form |
| In flight | `"Generating an image…"` | the submit button shows its own pending state; the button cannot be submitted again; **focus is not moved** (US1-2, FR-033) |
| Success | `"Image added to the library."` | the dialog closes, `refresh()` re-renders the library, the new asset is there without a reload (FR-034, US1-1/3) |
| Failure | the failure sentence, verbatim | the dialog stays open, the prompt is still in the field, and the sentence is rendered in a `role="alert"` block (FR-034, US1-5) |
| Field problem | the field's own error | `TextareaField` renders it next to the field in its `aria-live="polite"` region; focus moves to the field |

One fixed sentence per outcome, from `IMAGE_FAILURE_MESSAGES` or the service's refusals. **No SDK
error text, no provider payload and no part of the provider's own explanation is ever rendered**
(FR-020, SC-005, spec edge case "a prompt the provider declines on content grounds").

Two deliberate submissions make two images (G25): the button is disabled only while a request is
in flight, which stops a double-click and nothing else.

## 6. The server action

```ts
// src/app/p/[projectSlug]/media/actions.ts
export async function generateImageAction(
  slug: string,
  input: { prompt: string; aspect?: ImageAspect },
): Promise<ActionResult<{ mediaAssetId: string } | { message: string }>>;
```

Shape, following every other action on this page:

```ts
const result = await runAction(slug, (scope) => generateImage(scope, input));
if (result.ok && result.data.ok) refresh();
return result;
```

- `runAction` maps a `ForbiddenError` (editor, wrong project) and a `ZodError` (bad prompt) to an
  `ActionResult` — expected refusals come back as data, never thrown (`contracts/ui.md` of the
  existing codebase; `src/app/p/[projectSlug]/run-action.ts`).
- Expected *generation* refusals — no storage, not configured, key unreadable, a provider
  failure — come back inside `ImageGenerationResult` as `{ ok: false, message }`, so the dialog
  renders one sentence either way.
- `refresh()` **only** on success, so a failure leaves the library untouched (FR-034).
- No `signal` is passed (**P18**).

## 7. Provenance on the card (FR-035, US5-1)

`MediaCard` renders, when `item.generated` is set:

```tsx
<Badge>Generated</Badge>
<details className="text-xs text-muted-foreground">
  <summary>Prompt</summary>
  <p className="mt-1 whitespace-pre-wrap">{item.generated.prompt}</p>
</details>
```

- A native `<details>`: keyboard-operable with no JavaScript, works inside the server-rendered
  card, and a 1000-character prompt does not have to fit a tile (**P22**).
- Text **and** colour on the badge, never colour alone (`docket-ui`).
- Shown to anyone who can view the library — a member, not only the generator (FR-035).
- Provider and model are on the row and in the API-free service shape; the card shows the prompt,
  which is what "why does this graphic say that?" actually asks. Provider and model are asserted on
  the row by test (US5-2) rather than crowding the tile.
- No new filter, tab or view (G20, FR-027). An uploaded asset renders exactly as before (US5-3).

## 8. Accessibility checklist (FR-032, constitution)

- Every control has a visible `<label>`; the aspect group is a `<fieldset>` with a `<legend>`.
- Help text and errors are linked by `aria-describedby`; errors are in an `aria-live="polite"`
  region (`TextareaField` already does both).
- Focus: the dialog traps it (`showModal()`), Escape closes, focus returns to the trigger. Focus is
  never moved out from under a person mid-generation (US1-2).
- Visible focus rings from the shared control styles; no `dark:` variants and no raw palette
  classes — semantic tokens only.
- The whole flow is operable from the keyboard with no pointer: Tab to the trigger, Enter, Tab
  through prompt and shape, Enter to submit, Escape to close.
- No spinner stands in for a page; the pending state is on the button and in the live region.

## 9. What the interface does **not** gain

- No new route, sub-nav item, settings screen or library filter.
- No image preview-before-save, no "try another", no gallery of candidates — one prompt, one image
  (G7).
- No size, quality, format or provider control.
- No spend figure, estimate or remaining-credit display in the dialog. Usage is where spend lives
  (G12, G25), and the Usage screen already shows it per purpose.
- No change to the upload dropzone, the selection bar, the composer's picker or the "generate posts
  for these images" links.
