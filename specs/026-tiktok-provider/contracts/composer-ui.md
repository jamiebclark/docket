# Contract: composer, saving and target views

The UI follows the `docket-ui` skill: server components by default, a client component only for interactivity, labelled controls, visible focus, and reasons tied to controls with `aria-describedby`. There is no TikTok-specific UI code. Everything renders from G25–G27 (contracts/generic-hooks.md).

## 1. Check and save input (`postTargetInputSchema`, `src/lib/validation/scheduling.ts`)

```ts
postTargetInputSchema = z.object({
  accountId, postType, overrideText,                 // unchanged
  /** Absent keeps the stored values; null clears them. Parsed by the provider's `posting.valuesSchema` in the service. */
  posting: z.unknown().nullish(),
  /** The fingerprint the person agreed to; absent = not ticked. */
  consent: z.object({ fingerprint: z.string().regex(/^v1:[0-9a-f]{64}$/) }).optional(),
})
```

The compose check body limit (256 KB) is unchanged; posting values are small. The public API body (F7) does not gain these members.

## 2. Check response (`TargetCheck`, `src/server/services/posts/compose.ts`)

```ts
interface PostingPanelView {
  heading: string | null;                         // "Posting to Ada"
  notice: { text: string; doc?: string } | null;  // unaudited explanation
  details: "ready" | "error";
  detailsError: string | null;                    // "Couldn't load this TikTok account's options."
  fields: PostingFieldView[];                     // from posting.view (G25)
  afterPreview: string | null;                    // "It may take a few minutes for the post to process and be visible on TikTok."
  consent: { declaration: string; fingerprint: string; agreed: boolean } | null;
}
// TargetCheck gains (optional, so existing literal fixtures in Composer.test.ts stay valid):
posting?: PostingPanelView | null;   // the check sets null exactly when the provider declares no `posting`
note?: string | null;                // "Private on TikTok"
```

The check input (`checkSchema`) also gains `refreshDetails?: boolean`. When it is true, `readAccountDetails` bypasses the cache (`fresh: true`). Only Retry sends it.

How the check fills it, for each target whose provider declares `posting`:

1. Values are the input `posting` when present, else the stored `posting_fields`, else null. With null values, `view` builds the defaults (nothing chosen, all off).
2. Details come from `readAccountDetails(scope, accountId)` (cached, G26). A failure sets `details: "error"`, `detailsError`, and the blocking issue `{ code: "details_unavailable", field: "posting", message: detailsError }`.
3. `validateTargetContent` gets `posting: { values, details }`. Its issues are the provider's plus G27's consent issue, unless `details` failed.
4. `consent.fingerprint` is `consentFingerprint` over the unsaved state. `agreed` is true when it equals the input `consent.fingerprint`.
5. `canSchedule` is false while any error remains, so the consent, privacy, disclosure and details issues all block.

## 3. Composer state and rendering (`Composer.tsx`, new `src/components/compose/PostingFieldsPanel.tsx`, `posting-ui.ts`)

- State:
  - `postingValues: Record<accountId, unknown>`, seeded from `ComposerInitial.targets[].posting`;
  - `agreed: Record<accountId, string | undefined>`, seeded from `ComposerInitial.targets[].consentFingerprint`, the stored fingerprint when the consent is valid.
- Both travel in `targets[]` on every check and every save. A field change updates `postingValues`. The next check returns a new fingerprint, so `agreed` no longer matches, and the box shows unticked. This is how "any change clears the consent" appears in the UI.
- `PostingFieldsPanel` sits inside the target's preview card, after "Post as" and before the requirements summary. It shows:
  1. the heading as text (the creator's nickname);
  2. the notice as an info alert, with "Read how TikTok's audit works" linking `doc`;
  3. the fields:
     - **choice**: `<label>` + `<select required>`, with a first `<option value="">Choose…</option>` and no default. A disabled option keeps its reason in the option text ("Only me — Branded content can't be private.").
     - **toggle**: a checkbox with its label. When disabled, its reason sits in a `<p id>` referenced by `aria-describedby`.
     - **text**: an input with a live count ("12 / 90").
     - **fixed**: read-only text ("Only me (private)") and the explanation, with a link to `doc`.
  4. When `details === "error"`: `detailsError` and a secondary "Retry" button that bumps a `checkVersion` state, so the check runs again with `refreshDetails: true`.
  5. The content preview: the card's existing text, the video preview (`VideoTargetPreview`) and, for a consent target, image thumbnails in post order (`<img alt>` from the media view, with "Image <n>" when it has no alt text).
  6. `afterPreview` as muted text.
  7. The declaration and `<input type="checkbox">` "I agree", unticked unless `agreed`. Ticking it stores the current `consent.fingerprint` in `agreed[accountId]`; unticking deletes it.
- The fieldset is disabled when the composer is not editable.
- `posting-ui.ts` holds the pure helpers (`isAgreed`, `withValue`, `fieldDescribedBy`, `defaultValues`), each unit-tested.

## 4. Save (`createDraft`, `updatePost`)

1. Before the transaction, for each target with `consent` whose provider declares `consent`: `readAccountDetails` (cached). A failure means no consent is recorded.
2. Inside the transaction: write `posting_fields` (absent keeps, null clears, otherwise parsed by `valuesSchema`; a parse failure is a `ValidationIssuesError` at `targets.<i>.posting`). Then `recordConsentOnSave` per target (G27).
3. The existing "scheduled targets must stay publishable" re-gate (F5) now includes consent. An edit to a scheduled TikTok target without re-consent is refused with the consent issue.
4. `saveDraftAction` returns `{ postId }` as now. The next check shows the recorded state.
5. `src/app/p/[projectSlug]/compose/[postId]/page.tsx` passes `posting` and `consentFingerprint` (only when valid) into `ComposerInitial.targets[]`.

## 5. Target notes in every view (P9, P39)

| View | File | Rendering |
|---|---|---|
| Composer card | `Composer.tsx` | A neutral `Badge` with `TargetCheck.note` beside the counter |
| Post list | `src/app/p/[projectSlug]/posts/page.tsx` | Beside each target's status badge, from `PostListItem.targets[].note` |
| Post detail | `src/app/p/[projectSlug]/posts/[postId]/page.tsx` | Beside the target's status, from `PostViewTarget.note` |
| Calendar | `CalendarBoard.tsx` | Under the item's status, from `CalendarItem.note` |

The note is shown in every status, before and after publishing. A published TikTok target has no external link (spec D11). The detail page shows "Published on TikTok" with no link when `externalUrl` is null.

## 6. Requirements summary

`RequirementsSummary.tsx` renders `requirements.notes` (when present) as a bulleted list headed "Also", after the existing parts. For TikTok these are data-model §3's `summaryNotes`. The unaudited note appears only on an unaudited install.

## 7. Tests

- `tests/integration/tiktok/unaudited-ui.test.tsx` (FR-039, US6). With `TIKTOK_APP_AUDITED` unset and creator info offering all four levels, render (`renderToStaticMarkup`):
  - the composer with a TikTok target and its check result: "Only me (private)", the explanation, no privacy `<select>`, and "Branded content" disabled;
  - the post list and post detail pages: "Private on TikTok" for the target, both scheduled and published;
  - the calendar item.
- `tests/integration/compose/tiktok-check.test.ts` (US2):
  - with `TIKTOK_APP_AUDITED=true` and options `PUBLIC_TO_EVERYONE`, `FOLLOWER_OF_CREATOR`, `SELF_ONLY` with `duet_disabled`: the heading, three options with no selection, Duet disabled with its reason, Comment and Stitch off, photo targets showing only Comment;
  - the blocking issues until privacy and consent are given, and the disclosure rule;
  - `details_unavailable` with Retry, and the cache reused within 60 s;
  - a duration over the creator's maximum.
- `src/components/compose/posting-ui.test.ts`: the pure helpers.
- The existing composer tests (`Composer.test.ts`, `check.test.ts`, `post-type-choice.test.ts`) pass unchanged: `posting` is null and `note` is null for their providers.
