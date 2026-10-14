# Contract: the board picker and the Pinterest target in the UI

Covers FR-016–FR-020, FR-018 and FR-031. Nothing in the composer names Pinterest: every control below is
rendered by the generic `PostingFieldsPanel` from the provider's own declaration (G25, G26, G29).

## 1. Where the fields come from

```
Composer  ──POST /p/<slug>/compose/check──▶  checkComposition
                                              └─ readAccountDetails(scope, accountId, { fresh? })
                                                   └─ pinterestAccountDetails.read  →  GET /v5/boards …
                                              └─ validateTargetContent  →  validatePinterest
                                            ◀── TargetCheck.posting: PostingPanelView
```

- `readAccountDetails` already resolves project scope and `post:view`, renews credentials through
  `refreshForPublish` when `needsRefresh` says so, retries once on `credentialsExpired`, and caches a
  success for 60 seconds. The panel's **Retry** sends `refreshDetails: true`, which bypasses that cache.
  That is FR-017's "read live each time the panel is opened", bounded to one call a minute per account.
- A failed read reaches `view()` as `details: null` **and** surfaces as `panel.details === "error"` with
  `panel.detailsError`, which the panel renders above the fields with a Retry button.
- No provider call happens inside a transaction (the details read precedes the save's transaction, as
  026 established).

## 2. What the panel shows for a Pinterest target

| Element | Source | Content |
|---|---|---|
| Notice | `posting.notice()` | The Trial line, with a link to the setup guide labelled "Read how Pinterest's Trial access works" (needs `docLabel`, §4) |
| Board | `view()` field 1 | A `<select>`, required, placeholder "Choose a board…", one option per public board, **no board pre-selected** (US2-1) |
| Pin title | `view()` field 2 | Optional text, counter "n / 100" in code points |
| Pin link | `view()` field 3 | Optional text, counter "n / 2048" in code points |
| After the preview | `posting.afterPreview` | "The pin's title and link are Pinterest-only; other accounts ignore them." |
| Requirements summary | `posting.summaryNotes()` | The Trial line; "A pin needs one image and a board."; "About 100 pins a minute per account." |
| Target status badge | `posting.targetNote(values)` | `Board: <name>` |

The five board states, the options each produces and the issue each raises are the table in
data-model.md §5. In every state where the list is unusable the control is **disabled** and the stored
choice is still displayed — never cleared, never silently replaced (FR-019).

## 3. The board name beside a target's status (FR-018)

`targetNoteFor(providerKey, postingFields)` already feeds the note into:

- the composer's target card,
- the posts list (`src/server/services/posts/list.ts` → `posts/page.tsx`),
- the post detail page,
- the calendar (`CalendarItem.note` → `CalendarBoard.tsx`).

All four are existing generic plumbing from 026; none of them changes. They work for Pinterest only
because the board's **name** is stored in the target's values, which is what G29 (§4) is for: those views
have no live board list to resolve an id with.

## 4. Generic edits the panel needs

See [generic-hooks.md](./generic-hooks.md) for the exact shapes. In summary:

1. **G29** — a `choice` field view may declare `labelKey`; choosing an option stores its label under that
   key too, and clearing the choice clears the label.
2. **G25's `notice` gains `docLabel`** — the panel renders it instead of the hard-coded
   "Read how TikTok's audit works", and TikTok supplies its current label so nothing it shows changes.
3. **The `text` field counter uses the declared counting rule** — `countPostingText(value, rule)` in
   `posting-ui.ts`, built on `countText`, with today's `value.length` as the fallback when a custom rule
   crossed the JSON boundary without its function. TikTok's UTF-16 display is unchanged.

## 5. Accessibility and `docket-ui`

- Every control is labelled; the disabled reason and the help text are wired through
  `fieldDescribedBy` → `aria-describedby` (existing).
- The board select is a native `<select>`, so keyboard use and focus are the platform's.
- The failed-read message is `role="alert"` with an adjacent **Retry** button (existing).
- Loading shows a **disabled control**, never an empty list (FR-019, SC-008).
- No limit literal is written in UI code: 100, 2048 and 800 reach the browser only through the
  declaration.

## 6. Tests

`tests/integration/compose/pinterest-check.test.ts`:

- a Pinterest target with no board → `canSchedule: false` and an issue on `posting.boardId`;
- the picker lists every board, in Pinterest's order, with nothing pre-selected;
- an account with 300 boards → every board listed (two pages followed);
- an account with no boards → the disabled control, the "create one on Pinterest" reason, `no_boards`,
  and `canSchedule: false`;
- a failed board read → `details: "error"`, `detailsError` set, the control disabled, the stored board
  still shown and the stored id intact;
- Retry sends `refreshDetails: true` and the second read is not served from the cache;
- a stored board that is no longer on Pinterest → it is still the selected option, disabled and labelled,
  with `board_not_found`;
- two Pinterest accounts on one post each keep their own board (spec's last edge case);
- `targetNote` renders "Board: <name>" in the composer card, the posts list, the post detail page and the
  calendar;
- the Trial line appears in the notice, the summary notes and the account card, and the word "public" is
  never used of a published pin (FR-032).

`src/components/compose/posting-ui.test.ts` — `countPostingText` for `code_points`, `graphemes`,
`utf8_bytes`, a custom rule with its function, and a custom rule that arrived without one.

`tests/integration/compose/posting-hooks-inert.test.ts` (extended) — a provider that declares no
`labelKey` and no `docLabel` renders exactly as before; a throwaway provider declaring `labelKey` stores
the label.
