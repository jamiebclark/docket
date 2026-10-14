# Contract: the generic changes this entry makes

One new hook and two corrections to an existing one. Each is inert for every provider that does not opt
in, and each is pinned by a test that proves it. Nothing here touches the scheduler, the schema or the
publish engine.

## G29 — a choice field may store its label

### Shape (`src/providers/types.ts`)

```ts
export type PostingFieldView = { key; label; help?; disabled? } & (
  | { kind: "choice";
      value: string | null;
      options: PostingOptionView[];
      required: boolean;
      placeholder: string;
      /**
       * When set, choosing an option also stores that option's label under this key, so a view with no
       * live account details can name the choice. Clearing the choice stores "".
       */
      labelKey?: string }
  | …unchanged…
);
```

### Behaviour (`src/components/compose/PostingFieldsPanel.tsx`)

On a `<select>` change, where `id` is `""` for the placeholder and `label` is the chosen option's label:

```
onChange(field.key, id === "" ? null : id);
if (field.labelKey) onChange(field.labelKey, id === "" ? "" : label);
```

Two `withValue` updates on the same state compose, so one interaction yields one render with both
members set (F14).

### Why

`posting.targetNote(values)` receives **values only** (F12), and the posts list, post detail page and
calendar have no live account details to turn a Pinterest board id into a board name (F11). FR-018
requires the board's name beside the target's status in all of them.

### Rules

- The label is **display only**. A provider must never send it to the platform: the id is authoritative.
- The provider's `valuesSchema` owns the label's validation; it should cap its length and tolerate it
  being absent or stale (a board renamed on Pinterest refreshes the label on the next composer read).
- A label submitted by the browser is user-controlled text, like any other posting field value. It is
  length-capped by the schema and rendered as text.

### Reverse

Delete `labelKey` from the union and the panel's second `onChange`. Stored labels become unread members
that the provider's schema strips; no migration, no data loss that matters.

### Inertness test

`tests/integration/compose/posting-hooks-inert.test.ts`: a provider whose choice field declares no
`labelKey` produces exactly one `onChange` per selection and the same values as today; TikTok's panel
markup is byte-identical.

## G25 amendment — `notice` gains `docLabel`

```ts
notice?(): { text: string; doc?: string; docLabel?: string } | null;
```

The panel renders `notice.docLabel ?? "Read more"` as the link text instead of the hard-coded
"Read how TikTok's audit works" (F15). TikTok's declaration supplies
`docLabel: "Read how TikTok's audit works"`, so its rendered output does not change; Pinterest supplies
"Read how Pinterest's Trial access works".

*Reverse:* drop `docLabel` and the panel falls back to "Read more".

*Test:* the existing TikTok panel markup test still passes unchanged, and a Pinterest panel test asserts
its own label.

## Correction — the posting text counter uses the declared rule

`src/components/compose/posting-ui.ts` gains

```ts
/** The count the provider's own rule gives, with `length` as the fallback for a rule that lost its function to JSON. */
export function countPostingText(value: string, rule: TextCountingRule): number;
```

built on `countText` (`src/providers/text.ts`, already client-safe). The panel's `text` field renders
`countPostingText(field.value, field.countingRule)` instead of `field.value.length` (F16).

Why: `/compose/check` is a route handler, so a `CustomCountingRule` reaches the browser as JSON **without**
its `count` function; a built-in rule reaches it as a string. TikTok's rule is custom (UTF-16 units) and
its displayed count is unchanged by the fallback. Pinterest's title and link are `code_points`, so without
this the composer would show a count the refusal contradicts for any text containing an emoji or an
astral-plane character.

*Test:* `src/components/compose/posting-ui.test.ts` covers all four rule shapes.

## What this entry does **not** change generically

- No new column, no migration, no `post_targets` change: `posting_fields` from 026 is enough.
- No `consent` (G27) use, no `creationAllowance` (G22), no `afterPublish` (G23), no `wait` (G24).
- No engine, scheduler, gate or validation-path edit. `validateResolvedContent`, `postingContentOf`,
  `targetNoteFor` and `readAccountDetails` are used exactly as 026 left them.
- `exchangeCode`'s `callbackParams` (G28) is received and ignored.
