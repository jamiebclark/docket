# Contract: `Checklist` (new shared component, audit M2)

File: `src/components/ui/Checklist.tsx`. It's a server-compatible component: no `"use client"`, no hooks and no
JavaScript is needed. It's the only new shared component this entry adds (FR-046). Overview-specific sections go in
`src/components/overview/`, not `ui/`.

## Props

```ts
export type ChecklistStatus = { kind: "done" } | { kind: "todo" } | { kind: "waiting"; on: string };

export interface ChecklistItem {
  key: string;
  title: string;
  description: string;              // one line
  optional?: boolean;               // renders the text "Optional"
  status: ChecklistStatus;
  action?: { label: string; href: string } | null;   // at most one
  blocked?: string | null;          // shown instead of an action, e.g. "Needs an account first"
  children?: ReactNode;             // extra content under the line (the server-setup links)
}

export function Checklist(props: {
  title: string;                    // "Getting started", rendered as the card's <h2>
  items: readonly ChecklistItem[];
  /** When set, the whole list sits inside <details> whose <summary> reads this text (e.g. "Setup complete"). */
  collapsedSummary?: string;
}): JSX.Element;
```

## Rendering rules

- It's a `Card` with `title`, and the items go in an `<ol>` (FR-011). Each `<li>` contains:
  - a decorative `Icon` with `aria-hidden`: `circleCheck` for done, a new `circle` icon for to do, `clock` for
    waiting;
  - the title, with "Optional" as text when `optional`;
  - the status as text: "Done", "To do", or "Waiting on {on}";
  - the description;
  - then one of: the action as a `Link` styled with `buttonStyles({ variant: "secondary", size: "sm" })` (visible
    focus ring); `blocked` as muted text; or nothing.
- Status is never shown by colour or icon alone. The text is always present.
- `collapsedSummary` set: the card holds a native `<details>` with `<summary>` reading the text and the `<ol>` inside.
  The summary has `focus-visible:ring-2 focus-visible:ring-focus`. Closed by default.
- Phone width: rows wrap (`flex-wrap`), and actions drop under the text. Nothing is wider than the viewport.

## Uses in this entry

The overview's Getting started card (steps 1–6, plus the owner's "Server setup" row as an item whose `children` is a
`<ul>` of docs links). Entry 2 may reuse it for the Generate and Jobs prerequisite lists.

## Docs

Add one row to `docs/design-system.md` §7 (FR-060):

| Component | Variants / props | Notes |
|---|---|---|
| `Checklist` | `title`, `items` (`key`, `title`, `description`, `optional`, `status` done/todo/waiting, `action`, `blocked`, `children`), `collapsedSummary` | Ordered setup steps, each with status as text, a decorative icon, one line and at most one action. `collapsedSummary` folds it into a native `<details>`. State comes from data, never from stored dismissal. Used by the project overview. |
