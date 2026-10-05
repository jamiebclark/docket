---
name: docket-ui
description: Docket's UI conventions — layout shell, project switcher, forms, tables, calendar, empty/error/loading states, keyboard and accessibility rules, server vs client components. Use whenever building or changing any screen, component or form under src/app or src/components.
---

# Docket UI conventions

Docket is a tool its owner uses daily to hop between projects. **Clean and fast
over fancy.** Every screen must be fully usable from the keyboard.

## Before writing UI code
- Read `docs/design-system.md` — brand, colour tokens, typography, layout,
  component variants and do/don't. Visual decisions live there, not here.
- Read `node_modules/next/dist/docs/01-app/` for the App Router API you are
  about to use (Next 16 differs from older versions — see `AGENTS.md`).
- Reuse components in `src/components/ui/` before adding new ones (`Button` /
  `buttonStyles()`, `Field`, `Select`, `controlStyles`, `Card`, `PageHeader`,
  `Table`, `Badge`/`StatusBadge`, `Alert`, `EmptyState`, `FilterTabs`,
  `Dialog`, `Menu`, `Pagination`, `Skeleton`, `Icon`). If you add one, put it
  there with a short JSDoc comment on its props and list it in the design doc.
- In interactive sessions, delegate UI work to the `docket-ui-designer` agent.
  Pipeline phases cannot spawn agents, so they follow this skill and the design
  doc directly.

## Structure
- Routes: `/p/[projectSlug]/...` for everything project-scoped; `/login`,
  `/signup` (invitation token only), `/setup` (first-run), `/invitations`.
- App shell (`src/app/p/[projectSlug]/layout.tsx`): grouped left nav — Publish
  (Calendar, Posts, Compose, Review, Failures), Create (Generate, Jobs, Media,
  Voice), Project (Accounts, Settings) — from `NAV_SECTIONS` in
  `src/components/shell/LeftNav.tsx`; sticky top bar with the logo, the
  **project switcher** and a scheduler-health indicator (last successful tick;
  red banner when stale). Signed-out pages use `AuthShell`.
- **Server components by default.** Fetch through `src/server/services/` (never
  the DB directly). Client components (`"use client"`) only for interactivity:
  composer, calendar drag/drop, switcher, live validation. Keep them leaf-level.
- Mutations: server actions that call services and return a typed
  `{ ok: true, data } | { ok: false, error, fieldErrors? }` result; validate
  input with the same Zod schema the API uses.

## Project switcher
- Always visible. Opens with a button and with `Ctrl/⌘+K`. It's a combobox
  (`role="combobox"`, listbox options, arrow keys, Enter, Escape) with type-to-filter.
- Remembers the last project (cookie `docket_last_project`); `/` redirects there.

## Forms
- Every input has a visible `<label>`; help text via `aria-describedby`;
  errors rendered next to the field and announced (`aria-live="polite"`), and
  focus moves to the first invalid field on submit.
- Group related fields with `<fieldset>`/`<legend>`. One primary action per
  form, right-aligned; destructive actions are secondary styling and confirm
  in a dialog that names the thing being destroyed.
- Disable submit only while pending; show pending state on the button itself.
- One-of-many choices never use a native `<select>`: 2–6 short options are a
  `SegmentedControl` (option `cards` when each needs explaining), lists that
  grow with data use `ChoiceField`, long lists (time zones) use `Combobox` /
  `TimeZoneField`. See `docs/design-system.md` §7.
- Long forms end in an `ActionBar` (sticky from `md`); anything sticky inside
  the shell offsets from `var(--sticky-top)`, never `top-0`.

## Lists, tables, calendar
- Tables use real `<table>` markup with `<th scope>`. Filters are links/
  search params (shareable URLs), not hidden client state.
- Status badges use text + colour (never colour alone). Post statuses:
  draft, needs_review, approved, scheduled, publishing, published,
  partially_failed, failed; target `ambiguous` is shown in amber with
  "Needs your decision".
- Calendar: month and week views in the **project's time zone** (show the
  zone name). Empty slots render as dashed placeholders per account; a post
  can be dropped onto one, and every drag action has a keyboard equivalent
  (select post → "Move to slot…" menu).
- Per-platform character counts in the composer show `used / limit` and turn
  to an error state past the limit, using each provider's own counting rule
  (graphemes for Bluesky, etc.) from provider capabilities — never re-implement
  the counting in the component.

## States
Every data view handles four states explicitly:
- **loading** — `loading.tsx` skeleton matching the layout (no spinners for
  whole pages);
- **empty** — a sentence saying what goes here and the primary action to
  create it (e.g. "No posting slots yet. Add a slot");
- **error** — `error.tsx` with a plain-language message and a retry; never
  show stack traces or tokens;
- **populated**.

## Accessibility and style
- Visible focus rings (`focus-visible:ring-2`), logical tab order, skip link
  to main content, `<main>`/`<nav>` landmarks, page `<title>` per route.
- Colour contrast ≥ 4.5:1 for text (3:1 for control borders and focus rings);
  `node scripts/check-contrast.mjs` checks every token pair. Use only the
  semantic token classes from `src/app/globals.css` (`bg-surface`,
  `text-muted-foreground`, `border-input`, `text-danger`, …); dark mode comes
  from those tokens, so never add `dark:` colour variants or raw palette
  classes.
- Tailwind 4 only (CSS-first config); no additional UI framework unless a spec
  justifies it and it is logged in `docs/decisions.md`.
- Dates/times always shown with the project time zone; relative times
  ("in 2 h") get the absolute time in a `title`/tooltip.
