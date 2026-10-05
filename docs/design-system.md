# Docket design system

The single source of truth for how Docket looks. Code follows this file; when
they disagree, fix one of them in the same change. Pipeline phases read it
through the `docket-ui` skill, and interactive sessions through the
`docket-ui-designer` agent (`.claude/agents/docket-ui-designer.md`).

- **Tokens:** `src/app/globals.css`
- **Components:** `src/components/ui/`, `src/components/brand/`, `src/components/shell/`
- **Contrast check:** `node scripts/check-contrast.mjs` (fails below WCAG AA)
- **Icons:** `node scripts/brand-icons.mjs` regenerates `favicon.ico` and `apple-icon.png` from `src/app/icon.svg`

## 1. Principles

1. **Calm workspace, confident brand.** Screens are mostly white and off-white.
   Brand colour marks *where you are* and *what to do next*, and nothing else.
   Deep purple is structure (headings, primary actions, the active nav item);
   magenta is the single headline action; lavender is selection and hover.
2. **Semantic tokens only.** Components say `bg-surface`, `text-danger`,
   `border-input`, never `bg-white`, `text-red-700` or `border-foreground/40`.
   Dark mode comes from the tokens, so no `dark:` colour variants are needed.
3. **Shared primitives over class strings.** A button is `<Button>` or
   `buttonStyles()`; a text input is `<Field>` or `controlStyles`. If a screen
   needs a new look, add a variant to the primitive.
4. **Accessible by construction.** Every pairing in §3 passes WCAG AA (checked
   by script). Status is always text plus colour. Every interactive element has
   a visible `ring-focus` focus ring. Keyboard paths from `docket-ui` still apply.
5. **Clean and fast over fancy.** No UI framework, no icon package, no web-font
   requests. Fonts are vendored, icons are inline SVG, motion is minimal and
   respects `prefers-reduced-motion`.

## 2. Brand

### Logo

| Asset | File | Use |
|---|---|---|
| Mark (SVG) | `src/app/icon.svg` | Browser tab icon (Next `icon` convention) |
| Mark (component) | `<LogoMark size title?>` in `src/components/brand/Logo.tsx` | Header, anywhere in-app |
| Mark + wordmark | `<Logo size>` | Auth pages and marketing moments |
| Favicon | `src/app/favicon.ico` (32 + 48 px) | Legacy `/favicon.ico` requests |
| Apple touch icon | `src/app/apple-icon.png` (180 px, white tile) | iOS home screen |
| Install icons | `public/icon-192.png`, `public/icon-512.png`, `public/icon-maskable-512.png` | Listed in `src/app/manifest.ts` (served at `/manifest.webmanifest`, public without a session) |
| Share image | `src/app/opengraph-image.png`, `src/app/twitter-image.png` (1200×630) + `.alt.txt` | Link previews in Slack, social sites, chat apps. Absolute URLs come from `metadataBase` = `BETTER_AUTH_URL` |

All raster assets come from `src/app/icon.svg` via `node scripts/brand-icons.mjs`; the share image
is rendered with Next's `ImageResponse` using the Poppins WOFF files in `scripts/brand-assets/`.

The mark is a purple→magenta gradient "D" with two lavender broadcast waves.
Rules: never recolour the mark, never put it on a busy background, keep clear
space of at least half its height, minimum size 16 px. The wordmark is
"Docket" set in Poppins Bold in `text-heading` (it is real text, not an image).
`LogoMark` creates a unique gradient id per instance, so several marks on one
page are valid HTML.

### Palette

Brand colours (from the Concept 2 brief) and how they are used:

| Brand | Hex | Role in the UI |
|---|---|---|
| Deep Purple | `#4A148C` | `primary`, `heading`, `accent-foreground` (light theme) |
| Magenta | `#E91E63` | Gradient end, decorative fills. **Not** for text or small filled buttons |
| Soft Lavender | `#E1BEE7` | `accent` (selection, active nav, hover on secondary buttons); dark-theme headings |
| Off-white | `#F8F9FA` | `background` (app canvas) |
| Dark gray | `#212121` | `foreground` (body text) |

> **Why the CTA is `#C2185B`, not `#E91E63`.** White text on `#E91E63` is
> 4.36:1, below AA for normal-size text. Filled magenta buttons use
> `--cta: #C2185B` (5.87:1) and hover to `#AD1457`. Brand magenta stays in the
> logo, the gradient and decorative shapes.

## 3. Tokens

All tokens live on `:root` in `globals.css`, are redefined under
`@media (prefers-color-scheme: dark)`, and are exposed to Tailwind through
`@theme inline` as `--color-*`. Use them as `bg-*`, `text-*`, `border-*`,
`ring-*`, `divide-*`, with opacity modifiers where noted.

| Token | Light | Dark | Use |
|---|---|---|---|
| `background` | `#F8F9FA` | `#120C19` | Page canvas behind cards |
| `surface` | `#FFFFFF` | `#1B1424` | Cards, header, sidebar, inputs, dialogs, menus |
| `muted` | `#F4EEF8` | `#261D33` | Hover fill, table header, skeletons, chips |
| `foreground` | `#212121` | `#ECE6F2` | Body text |
| `muted-foreground` | `#5E5768` | `#B4AAC2` | Secondary text, hints, captions, inactive nav |
| `heading` | `#4A148C` | `#E1BEE7` | `h1` (automatic), card titles, wordmark |
| `border` | `#E4DDEB` | `#342845` | Hairlines: cards, dividers, table rows |
| `input` | `#9A8CAD` | `#7A6D8F` | Form-control borders (≥ 3:1 against surface) |
| `focus` | `#9C27B0` | `#E1BEE7` | Focus rings |
| `primary` / `-hover` / `-foreground` | `#4A148C` / `#6A1B9A` / `#FFF` | `#D1A8F5` / `#E1C4FA` / `#24063F` | Primary buttons, active tab, links that act |
| `cta` / `-hover` / `-foreground` | `#C2185B` / `#AD1457` / `#FFF` | `#F06292` / `#F48FB1` / `#2B0612` | The one headline action; count pills |
| `accent` / `-foreground` | `#E1BEE7` / `#4A148C` | `#3A2350` / `#EBD3F5` | Selected rows/options, active nav (`bg-accent/60`) |
| `danger` / `-bg` / `-border` | `#B3261E` / `#FDECEC` / `#E6A5A1` | `#FFB4AB` / `#3A1414` / `#8C3A33` | Errors, destructive actions, failed |
| `warning` / `-bg` / `-border` | `#8A4B00` / `#FFF4E0` / `#E3B46B` | `#FFC772` / `#33230A` / `#8A6420` | Needs review, needs your decision, reconnect |
| `success` / `-bg` / `-border` | `#1B6E3A` / `#E8F5EC` / `#9BCDAA` | `#8FD9A8` / `#0F2A1A` / `#2F6B45` | Published, connected, done |
| `info` / `-bg` / `-border` | `#1F5BA8` / `#E8F0FB` / `#A7C1E6` | `#A9C7FF` / `#10203A` / `#35588F` | Approved, publishing, running |
| `brand-purple` / `-magenta` / `-lavender` | fixed | fixed | Brand moments only (gradient, auth backdrop) |

Utility: `bg-brand-gradient` (135°, purple → magenta) for the avatar and logo
tiles. Shadows: `shadow-card` (resting cards), `shadow-overlay` (dialogs,
menus, the auth card).

Run `node scripts/check-contrast.mjs` after changing any colour; it checks 27
text/UI pairs in both themes.

## 4. Typography

| Role | Font | Size / weight | Class |
|---|---|---|---|
| Page title (`h1`) | Poppins | 28 px (24 on mobile) / 600, `heading` colour | `PageHeader`, or `text-2xl font-semibold` |
| Section title (`h2`) | Poppins | 18–20 px / 600 | `text-lg font-semibold` |
| Card title (`h2` in `Card`) | Poppins | 16 px / 600, `heading` colour | built into `Card` |
| Sub-section (`h3`) | Poppins | 14–16 px / 500–600 | `text-base font-medium` |
| Body | Inter | 14 px / 400 | `text-sm` (app default density) |
| Long-form / composer text | Inter | 16 px | `text-base` |
| Caption, hint, table header | Inter | 12 px | `text-xs` (+ `uppercase tracking-wide` for table headers and nav groups) |
| Code, slugs, keys | System mono | 12–14 px | `font-mono` |

- `h1`–`h4` get Poppins and `-0.01em` tracking from the base layer; `h1` is
  also coloured `heading`. Utilities still override.
- Fonts are vendored in `src/app/fonts/` (OFL, licences alongside) and loaded
  with `next/font/local` as `--font-inter` (variable 100–900) and
  `--font-poppins` (500/600/700). Nothing is fetched at build or run time,
  which keeps decision #16 (no Google Fonts download) intact.
- Numbers that change in place (counts, pagination) use `tabular-nums`.

## 5. Space, shape, elevation

- **Spacing:** Tailwind's 4 px scale. Page gutters `px-4 sm:px-6 lg:px-10`,
  page top `py-6 lg:py-8`, card padding `p-5`, gap between page sections
  `gap-6`, between form fields `gap-4`.
- **Content width:** project pages sit in `max-w-6xl` centred. Forms and
  reading text are capped at `max-w-2xl`.
- **Radius:** controls and buttons `rounded-lg` (8 px); cards, tables, tab
  bars `rounded-xl` (12 px); dialogs and the auth card `rounded-2xl`; pills and
  avatars `rounded-full`.
- **Elevation:** flat by default. `shadow-card` for cards and tables,
  `shadow-overlay` for anything floating. Header is sticky with a translucent
  surface and backdrop blur.
- **Control heights:** `sm` 32 px (dense rows, pagination, menus), `md` 36 px
  (default), `lg` 44 px (auth forms, touch-first). Touch targets on mobile are
  ≥ 36 px tall.

## 6. Layout

### App shell (`src/app/p/[projectSlug]/layout.tsx`)

```
┌────────────────────────────────────────────────────────────────────┐
│ [D] Docket │ Acme Launch ▾  ⌘K   ● Scheduler ran 12 s ago   ✉ Invitations  (RO) Sign out │  ← sticky header, h-14
├──────────────┬─────────────────────────────────────────────────────┤
│ PUBLISH      │  (banners: scheduler stale = danger, reauth = warning) │
│ ▣ Calendar   │                                                     │
│ ☰ Posts      │   Page title                         [Secondary][Primary]
│ ✎ Compose    │   One-line description                              │
│ ✓ Review  3  │                                                     │
│ ⚠ Failures 1 │   ┌ Card ────────────────────────────────────────┐  │
│ CREATE       │   │                                              │  │
│ ✦ Generate   │   └──────────────────────────────────────────────┘  │
│ ≡ Jobs       │                                                     │
│ ▢ Media      │                 max-w-6xl, centred                  │
│ 🎙 Voice      │                                                     │
│ PROJECT      │                                                     │
│ 👥 Accounts   │                                                     │
│ ⚙ Settings   │                                                     │
└──────────────┴─────────────────────────────────────────────────────┘
```

- **Header:** logo (links home), divider, project switcher (pill button with
  chevron and `Ctrl/⌘ K` hint), quiet scheduler status (green dot, `lg+`
  only), then invitations and user menu (initials avatar from the user's own
  display name, never from their email).
- **Sidebar:** 240 px, sticky below the header, grouped by job: **Publish**
  (Calendar, Posts, Compose, Review, Failures), **Create** (Generate, Jobs,
  Media, Voice), **Project** (Accounts, Settings). Review stays directly above
  Failures (tested). Active item: `bg-accent/60`, purple icon, 4 px purple
  indicator bar, `aria-current="page"`. Counts render as pills (magenta for
  Review, danger tint for Failures) and the accessible name still reads
  "Review (3)".
- **Below `md`:** the sidebar becomes a horizontally scrolling strip under the
  header (no group labels), and header labels collapse to icons with
  screen-reader text.
- **Banners** span the full width between header and body
  (`alertStyles(tone, true)`).

### Page anatomy

1. `PageHeader` — `title`, optional `description`, `actions` (primary last).
2. Optional `FilterTabs` (segmented control) and toolbar.
3. Content in `Card`s / `Table` / `EmptyState`; one topic per card.
4. `Pagination` at the bottom of lists.

### Sticky elements

Everything that sticks reads its offset from `--sticky-top`, set on the shell
body: header plus phone nav strip (`6.875rem`) below `md`, header only
(`3.5rem`) from `md` up. Never hard-code `top-0` inside the shell; it slides
under the header.

| Element | Sticks | Where |
|---|---|---|
| App header | top, always | `SignedInHeader` (`z-30`) |
| Project nav | phone strip under the header; sidebar from `md` | `LeftNav` (`z-20`); the strip scrolls the current section into view |
| Commit row of long forms | bottom, from `md` up | `ActionBar stickyFrom="md"` — Compose, Generate, Jobs, Series plan |
| Selection bars | bottom (Review bulk actions) or under the header (Media selection), always | `ActionBar` with `label` |
| Composer preview | top, from `lg` up | `Composer` preview card |
| In-page anchors | `scroll-mt-[calc(var(--sticky-top)+1rem)]` | Accounts sections, so jumps land below the sticky chrome |

### Responsiveness

Built in, not per-page: the shell becomes a sticky icon strip below `md`; the
header collapses labels to icons with screen-reader text; content gutters step
`px-4 → sm:px-6 → lg:px-10`; `PageHeader`, toolbars and form rows stack with
`flex-col sm:flex-row` / `flex-wrap`; `Table` rows become labelled cards below
`sm`; dialogs are `w-[calc(100%-2rem)]`; segmented controls wrap. Checked by
an overflow sweep of every route at 390 px (no page scrolls sideways).

### Signed-out and first-run pages

`AuthShell` (`src/components/brand/AuthShell.tsx`): soft lavender and magenta
blurred shapes on the canvas, the full logo, and one `max-w-md` card with
`shadow-overlay`. Used by `/login`, `/setup`, `/signup`. The card's `h1` is a
greeting, followed by one muted sentence and the form; the submit button is
full width, size `lg`.

## 7. Components

| Component | Variants / props | Notes |
|---|---|---|
| `Button`, `buttonStyles()` | `primary`, `cta`, `secondary`, `ghost`, `danger`; sizes `sm`/`md`/`lg`; `pending` + `pendingLabel` | Use `buttonStyles()` on `<Link>` so links and buttons match. **One** `primary` per form; **at most one** `cta` per screen (Schedule / Publish now). `danger` always confirms in a `Dialog` that names the thing. |
| `Field`, `Select` | `label`, `hint`, `error`; `Select` also `compact` | Errors in an `aria-live` region; invalid styling from `aria-invalid`. `compact` (toolbars) drops the reserved empty error line. Prefer the choice controls below to `Select`. |
| `controlStyles`, `labelStyles`, `hintStyles`, `errorStyles`, `checkStyles` | — | For raw `<input>`, `<textarea>`, checkboxes (brand `accent-color`). Every checkbox uses `checkStyles`. |
| `SegmentedControl` | `name`, `label`, `options` (`value`, `label`, `description`, `disabled`), `layout` `pills`/`cards`, `size`, `hideLabel` | Short exclusive choices as a button row on native radios (arrow keys, form submit, no JS needed). `cards` stacks options with an explanation each. |
| `Combobox` | `id`, `name`, `label`, `options`, `value`/`defaultValue`, `onChange`, `compact` | Autocomplete for long or growing lists: type to filter (every word, `_ / -` read as spaces), ↑/↓, Enter, Escape restores. Submits through a hidden input. Options render only while open. |
| `ChoiceField` | `Combobox` props + `autoSubmit` | Lists of unknown length (accounts, voice profiles, tags): ≤ 5 short options → `SegmentedControl`, otherwise `Combobox`. `autoSubmit` applies GET filters on choice; keep a `<noscript>` submit button. |
| `TimeZoneField` | `id`, `name`, `defaultValue` or `value`/`onChange` | `Combobox` over every IANA zone with its current offset ("new york", "GMT+1" both work). |
| `ActionBar` | `message`, `label`, `edge` `top`/`bottom`, `stickyFrom` `always`/`md` | Floating commit/selection row; primary action last. |
| `Card`, `cardStyles` | `title`, `description`, `actions`, `as`, `padded` | `cardStyles` for a `<form>` or `<fieldset>` that is itself the card. |
| `PageHeader` | `title`, `description`, `actions`, `eyebrow` | The route's only `h1`. |
| `Table`, `Row`, `Cell` | `caption`, `columns`, `header` cell | Card-wrapped, uppercase muted column heads, row hover. Below `sm` each row stacks into a card and every cell is labelled with its column name (CSS variables `--col-N` + `.stack-table` in globals.css, so rows can come from any server or client component). |
| `Badge`, `StatusBadge` | tones `neutral`, `brand`, `info`, `success`, `warning`, `danger` | Tinted pill + dot + text. Status → tone map lives in `StatusBadge` (scheduled = brand, approved/publishing/running = info). |
| `Alert`, `alertStyles()` | tones `info`, `success`, `warning`, `danger`; `banner` | `role="alert"` for danger/warning, `status` otherwise. |
| `EmptyState` | `message`, `action`, `icon` | Dashed card, lavender icon disc, one sentence, one action. |
| `FilterTabs` | tabs with `count` | Segmented control on a surface; active = filled primary. Counts are pills; the accessible text stays "(3)". |
| `SubNav` | `label`, `items`, `nested` | Underlined tab row for a section's own pages (Settings). Active = purple underline + `aria-current`. |
| `Dialog`, `ShowOnceDialog` | — | Native `<dialog>`, `rounded-2xl`, `shadow-overlay`, blurred backdrop (base layer). |
| `Menu` | items, `triggerClassName` | Trigger looks like `secondary sm` unless `triggerClassName` is given (calendar chips); focused item lavender. |
| `Pagination` | — | `secondary sm` buttons; disabled ends at 50% opacity. |
| `CopyField` | — | Mono read-only input plus secondary Copy button. |
| `Skeleton` | `className` | `bg-muted`, pulses only with `motion-safe`. |
| `Icon` | `name`, `size` | 24-px grid, 1.75 stroke, `currentColor`, always `aria-hidden`. Add glyphs to the `PATHS` map. |
| `Logo`, `LogoMark`, `AuthShell` | — | §2, §6. |

### Choosing a control for one-of-many

| Options | Control |
|---|---|
| 2–6 fixed, short labels (role, expiry, weekday, view) | `SegmentedControl` (`pills`) |
| 2–4 fixed, each needs explaining (approval, scheduling policy) | `SegmentedControl layout="cards"` |
| A list that grows with data (accounts, voice profiles, tags) | `ChoiceField` (switches by size) |
| Long or open-ended (time zones, anything > 6) | `Combobox` / `TimeZoneField` |
| Many-of-many | Checkboxes with `checkStyles` |

Native `<select>` is no longer used in the app; `Select` stays only for
callers outside the design system.

## 8. States

Unchanged from `docket-ui`, now with the components above:
**loading** = `loading.tsx` built from `Skeleton`-style blocks matching the
layout; **empty** = `EmptyState`; **error** = `error.tsx` with `Alert` tone
danger copy and a `secondary` "Try again"; **populated**.

## 9. Motion

`transition-colors` on interactive elements (150 ms default). Skeleton pulse
only under `motion-safe`. No entrance animations, parallax or animated
gradients.

## 10. Do / don't

- **Do** use `text-muted-foreground` for secondary text. **Don't** use
  `opacity-70` on text (it drops contrast unpredictably).
- **Do** use `border-border` for hairlines and `border-input` for controls.
- **Do** put the primary action rightmost in a row. **Don't** place two filled
  buttons side by side; pair `primary` with `secondary` or `ghost`.
- **Don't** add `dark:` colour classes. If dark mode looks wrong, fix the token.
- **Don't** use raw Tailwind palette colours (`red-700`, `zinc-100`, `white`)
  outside `src/components/brand/`.
- **Don't** use `#E91E63` behind text.

## 11. Audit of the previous UI (2026-10-04)

What the makeover found, and what was done about it.

| # | Finding | Severity | Resolution |
|---|---|---|---|
| A1 | Monochrome theme: two tokens (`background`, `foreground`) and ~400 opacity hacks (`foreground/10`, `/30`, `/70`) stood in for every grey, border and hover. No brand colour anywhere. | High | Full semantic token set (§3); codemod `scripts/codemods/design-tokens.mjs` rewrote every use. |
| A2 | ~200 raw palette classes for status (`text-red-700 dark:text-red-400`, `border-amber-700`, `bg-amber-50`), each with a hand-written dark twin. | High | `danger`/`warning`/`success`/`info` token families; `dark:` twins removed. |
| A3 | 25+ hand-rolled button and button-like link styles with drifting radius (`rounded` vs `rounded-md`), padding (`py-1.5` vs `py-2`) and no hover on some. | High | `Button` variants + `buttonStyles()`; codemod `scripts/codemods/shared-styles.mjs` replaced them. |
| A4 | 60+ raw form controls with three different looks (`bg-transparent`, `bg-background`, `border-foreground/30` vs `/40`); input borders below 3:1. | High | `controlStyles` (3.1:1 border, purple hover/focus, `aria-invalid` state) applied everywhere. |
| A5 | Some focus rings had no colour (`focus-visible:ring-2` alone falls back to `currentColor`). | Medium | Every ring now carries `ring-focus`. |
| A6 | Header had no brand, a boxed "Sign out" and plain-text scheduler status. | Medium | Logo, divider, pill switcher with ⌘K hint, status dot, avatar, icon buttons. |
| A7 | Sidebar: flat list of 11 text links, fixed `w-48`, no mobile behaviour (overflowed phones). | Medium | Grouped, iconed, sticky sidebar; horizontal strip below `md`. |
| A8 | Content stretched edge to edge (`p-6`, no max width); long lines on wide screens. | Medium | `max-w-6xl` centred column with responsive gutters. |
| A9 | Tables, empty states and skeletons were bare (no surface, static grey blocks). | Medium | Card-wrapped tables, iconed empty states, pulsing skeletons. |
| A10 | System fonts only; headings indistinguishable from body. | Medium | Vendored Poppins (headings) + Inter (body). |
| A11 | Default Next.js favicon; no app icons. | Low | Docket mark as `icon.svg`, `favicon.ico`, `apple-icon.png`. |
| A12 | Auth pages were an unstyled column. | Low | `AuthShell` brand frame. |
| A13 | Badges were outline-only, low emphasis. | Low | Tinted pill + dot, new `brand` tone for scheduled. |
| A14 | Composer was one long column with four equal-weight buttons. | Medium | Card per fieldset, sticky preview on `lg`, sticky action bar on `md+`, Add to queue as the magenta `cta`. |
| A15 | Calendar: plain grid, today underlined only, post chips styled as buttons. | Medium | Card-wrapped grid, uppercase weekday heads, filled purple today marker, lavender post chips, softer empty slots, segmented Month/Week toggle. |
| A16 | Settings sub-nav had no active state. | Low | `SubNav` with `aria-current` and a purple underline. |

## 12. Controls and layout audit (2026-10-05)

| # | Finding | Severity | Resolution |
|---|---|---|---|
| B1 | Time zone was a free-text box ("IANA name, e.g. America/New_York") over ~400 valid values; typos only surfaced on save. | High | `TimeZoneField` autocomplete in project settings and project creation (browser zone still pre-filled). |
| B2 | Eleven native `<select>`s regardless of length: 2-option policies, 3-option roles, 4-option expiry, 7 weekdays, and growing lists of accounts and voice profiles. | Medium | Short sets → `SegmentedControl`; policies → option cards with explanations; growing lists → `ChoiceField`; mock behaviour and tags → autocomplete. |
| B3 | Account filters needed a second "Filter"/"Apply" click. | Low | `ChoiceField autoSubmit`; the button remains in `<noscript>`. |
| B4 | Media selection bar stuck at `top-0`, underneath the sticky header. | Medium | `ActionBar edge="top"` using `--sticky-top`. |
| B5 | Phone nav strip scrolled away, and the current section could sit off-screen in it. | Medium | Strip sticks under the header and scrolls the active item into view. |
| B6 | Long forms (Generate, Jobs, Series plan) put the only action at the very bottom. | Medium | Shared sticky `ActionBar` (from `md`), same as Compose; Review bulk actions use it too. |
| B7 | Tables on phones hid columns behind a sideways scroll (Members' role and actions were off-screen). | Medium | Tables stack into labelled cards below `sm`. |
| B8 | Accounts page buried connected accounts below three connect forms; the mock form had no card. | Medium | Connected accounts first, "Add an account" jump link, connect options in a two-column grid, mock form in its own card. |
| B9 | Project not-found rendered a second `<main id="main">` inside the shell; `/connect/invalid` had no `#main` for the skip link. | Medium (a11y) | Section inside the shell; branded `AuthShell` pages for global not-found and invalid connect. |
| B10 | Checkboxes and a few inputs (resolve-URL field, CSV file input) skipped the shared styles; alignment relied on `mt-6` offsets. | Low | `checkStyles` on every checkbox, `controlStyles` and a styled file button; rows align with `items-end`. |

No page scrolls sideways at 390 px (sweep of all 20 project routes plus
`/p/new` and `/invitations`).

### Backlog (not yet done)

1. Adopt `PageHeader` on every route (most still use the older
   `<div className="mb-4 flex …"><h1>` row; they inherit the brand heading
   styles but not the description slot).
2. Group long forms (Settings, Voice editor, Generate, Job forms) into `Card`s
   with `fieldset`/`legend` titles.
3. Calendar: a selected-day state and drag-over highlight for empty slots
   (today marker, chips and grid are done).
4. Composer: inline per-platform preview styling (avatar, platform frame) in
   the preview card; the two-column layout and cta are done.
5. Composer account picker: selectable account cards instead of a checkbox list once projects have many accounts (with a filter box past ~8).
6. Toasts for "Saved" / "Scheduled" confirmations (live region already exists).
7. Optional manual theme toggle (light / dark / system) stored per user.
8. Visual regression screenshots for the shell and three key pages in CI.
