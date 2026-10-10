# UI contract: Accounts restructure and first-post flow

This is what each screen shows, in which order, and to whom. Strings in `code` are exact, and tests may pin them.
Visual rules follow `docs/design-system.md` and the docket-ui skill. Every changed screen must work at 390 px with full
keyboard use and visible focus (FR-063).

## 1. Account card (Accounts page)

```
┌ section#account-{id}  aria-labelledby=account-{id}-name ────────────────────┐
│ [mark] h3#account-{id}-name {displayName}  · {providerName}   [Badge status] │  1 Status
│ Connected {LocalTime}                                                         │
│ Last error: {lastError}                         (if any)                      │
│ {notes…}                                                                      │
│ [Mock behaviour…] [Reconnect]                   (managers, mock only)         │
│ [Reconnect with {group}] / paste hint / ▸ Reconnect (credentials)             │
│                                                 (managers, needs_reauth only) │
│ {landing message — reconnect only}              (see §2)                      │
│                                                                               │
│ h4#account-{id}-slots  Posting slots ({tz})                                   │  2 Posting slots
│ {landing message — new account only}            (see §2)                      │
│ [table Day | Time | Status | Actions*]  or  "No posting slots yet."           │
│ [Add a posting slot form]*                                                    │
│                                                                               │
│ ▸ Posting instructions · Set   |   ▸ Posting instructions · None              │  3 Posting instructions
│     (open) form* / read-only text / "No posting instructions."                │
│ ─────────────────────────────────────────────────────────────────────────────│
│                                                         [Remove account]*     │  4 Remove
└───────────────────────────────────────────────────────────────────────────────┘
* owners and admins only
```

**Rules**:

- **Strings**:
  - the summary is `Posting instructions · Set` or `Posting instructions · None`; the separator is ` · ` (space,
    U+00B7, space);
  - editors' empty text stays `No posting instructions.`;
  - the slot empty text stays `No posting slots yet.`.
- **Summary styling**: `cursor-pointer rounded-md text-sm font-semibold focus-visible:outline-none
  focus-visible:ring-2 focus-visible:ring-focus`.
- **Section spacing**: the card keeps `gap-3`. Sections 2 and 3 may sit in a `flex flex-col gap-3` wrapper each.
  Section 4 uses `border-t border-border pt-4` with `flex justify-end`.
- **Order guarantee for tests**, in the HTML of every card:
  - `account-{id}-name` < `account-{id}-slots` < `Posting instructions ·`;
  - for managers, < the Remove button's text.
- **Editors** see no `<form>` in the card, no Remove, no Actions column, no mock or reconnect controls (FR-009).
- **The page-level definition** `#posting-slots-definition` stays where it is: once, above the cards (FR-007).
- **At 390 px**: the header wraps as today (`flex-wrap`), the table keeps the `Table` primitive's own overflow
  handling, and the weekday pills wrap (`SegmentedControl` `flex-wrap`). No section adds a fixed width.

## 2. Landing after a successful connect

| Route | Where the browser goes | Focus | Visible message (inside the card) | Announced |
|---|---|---|---|---|
| Chooser, ≥1 new | `?landed=…#account-{firstNew}-slots` | checked weekday radio of that card's add-slot form | under the Posting slots heading | same text, polite |
| Chooser, only already-connected or needs-reconnect | `?landed=…#account-{first}` | that card's `h3` (`tabIndex=-1`) | end of the status block | same |
| Credentials "Connect", new account | as chooser ≥1 new | as above | as above | as above |
| Credentials "Connect", handle already connected | as reconnect | `h3` | status block | same |
| Credentials "Reconnect" | as reconnect | `h3` | status block | same |
| Mock "Connect mock account" | as new | weekday radio | under slots heading | same |
| Mock "Reconnect" | as reconnect | `h3` | status block | same |
| Any failure or cancel | unchanged (top of Accounts, existing banner or inline error) | unchanged | none | unchanged |

**Rules**:

- **Message**: the visible message is `<p className={alertStyles("success")}>` with no `role`. The announcement goes
  through `ConnectLanding`'s `LiveRegion` (polite) after focus moves. The strings are in research R6.
- **Scroll**: the landed section's top sits below the sticky header (the existing `scroll-mt`).
- **Once only**: after landing, the URL keeps only the hash, so a reload doesn't repeat the focus or the message.
- **Invalid targets**: if `landed` doesn't match an account on the page, or the viewer is an editor, the page shows no
  message and no `tabIndex`, and moves no focus (FR-018).
- **Without JavaScript**: the fragment jump and the visible message still work. Only focus and the announcement need
  the client.

## 3. SetupNotice (Generate, Batch jobs, New batch job, New batch job from CSV)

```
┌ section aria-labelledby=setup-notice-title  (dashed, rounded-xl, bg-surface) ┐
│                         ( icon disc )                                         │
│                h2#setup-notice-title  Before you can generate                │
│                    {lead — optional, not used by the gates}                   │
│   ┌ ol (max-w-xl, mx-auto, left-aligned) ───────────────────────────────┐    │
│   │ ○ Set up AI generation   To do                  [Open the setup guide]│    │
│   │   The server needs an AI provider…                                    │    │
│   │ ✓ Connect an account     Done                                          │    │
│   │ ◷ Create a voice profile Waiting on Ana and Sam                        │    │
│   └───────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Rules**:

- **Frame**: `rounded-xl border border-dashed border-input/70 bg-surface px-6 py-10` (EmptyState's frame). The icon
  disc is `size-11 rounded-full bg-accent/60 text-accent-foreground`.
- **Title**: `text-base font-semibold text-heading`.
- **Rows**: `ChecklistRows`, identical to the overview's rows. The status is in words (`Done`, `To do`,
  `Waiting on {names}`), the icon is decorative, and each row has at most one action or one blocked line.
- **Icons**: Generate passes `icon="generate"` and the three job pages pass `icon="jobs"`.
- **Placement**: it goes exactly where the `Checklist` was, directly under the `PageHeader`, with nothing else on the
  gate (the form stays hidden).
- **Overview**: still uses `Checklist` titled `Getting started` (FR-023).
- **Content**: byte-identical to entry 2 for owners, admins and editors (FR-024).

## 4. Composer success dialogs

| Dialog | Title when done | New element (first post only) | Destination |
|---|---|---|---|
| Add to queue | `Added to the queue` | `See it on the calendar` | `/p/{slug}/calendar?view=month&date={date of earliest assigned time, project zone}` |
| Schedule | `Scheduled` | `See it on the calendar` | same rule, with the scheduled time |
| Publish now | `Publishing` | `See it on the calendar` | `/p/{slug}/calendar` |

**Rules**:

- **Placement**: the footer row (`mt-4 flex justify-end gap-2`), in DOM order: the link first, then `Close`. The link
  uses `buttonStyles({ variant: "primary" })`. Tab from the outcome rows reaches the link, then Close.
- **When it shows**: only when the project had no scheduled, publishing, published or partially failed post at page
  load (`firstPostDone === false`), captured at confirm, **and** at least one row is `ok`.
- **When it doesn't**: no link when every row failed or on any later post (FR-033). The outcome list, the
  `aria-live="polite"` container, the titles and `Close` are unchanged (FR-035).
- **Roles**: owners, admins and editors all see it (FR-034).

## 5. Getting started (overview card) and the guide

**Card**:

- Under the list, in both the full and the `Setup complete` collapsed form, show
  `<a href="https://jamiebclark.github.io/docket/getting-started/" target="_blank" rel="noreferrer" class="text-sm underline">Read the getting-started guide</a>`.
- The link sits outside the `<details>`, so it is visible while collapsed.
- When the checklist is `null` (the card is hidden), there is no link (US5 scenario 4).

**`docs/getting-started.md` outline** (FR-041–FR-045; short enough to read in under 5 minutes, about 700–900 words):

1. `# Getting started`: one paragraph on what a project is (accounts, posts and a team, in one time zone).
2. `## 1. Connect an account`: Accounts → Add an account; pick Pages or profiles; owners and admins only.
3. `## 2. Add posting slots`: weekly times per account. Add to queue fills the next free slot. Schedule and Publish
   now don't need slots.
4. `## 3. Write your first post`: Compose; pick accounts; Add to queue, Schedule or Publish now; then "See it on the
   calendar".
5. `## Optional next steps`:
   - `### Brand voice and generating posts`: a voice profile; Generate and Batch jobs; approving in Review.
   - `### Media`: images and videos in Media. Instagram and TikTok posts always need media (`docs/limits.md:72`,
     `:193`, "media required: yes"); the other platforms accept text-only posts. Link to `limits.md` for which kinds
     and sizes.
   - `### Invite teammates`: Settings → Members.
6. `## Roles`: Owner, Admin and Editor, in the app's words (`src/lib/roles/roles.ts`). Editors write, schedule and
   generate posts but can't connect accounts or manage posting slots or the brand voice.
7. `## Where to look afterwards`: Calendar, Posts, Review, Failures, Activity, and the notifications bell for problems.
8. `## Running the server`: one sentence: "If you run the server, see [Deploying](deployment.md)."

**Rules**:

- No shell commands, code blocks of commands, or environment variable names (SC-006).
- Relative links only, to pages that exist.
- Every platform fact (which media is required) must match `docs/limits.md`. Check it there, not from memory.

**Nav**:

- `mkdocs.yml` gets `- Getting started: getting-started.md` as the first item of "Using Docket".
- `docs/index.md` lists it first under "Using Docket".

## 6. Project switcher

- **Unchanged**: everything visible, the dialog, and the Ctrl/⌘+K handler.
- **Button**: `aria-keyshortcuts="Control+K Meta+K"`. Its accessible name is computed from `{currentName}` only.
- **`<kbd>Ctrl/⌘ K</kbd>`**: `aria-hidden="true"`. It is still hidden below `sm` (`hidden … sm:inline`).

## 7. First-run setup form

**Password**:

- the hint `12–128 characters` has `id="password-hint"` and is always visible;
- the input has `aria-describedby="password-hint"`, or `"password-hint password-error"` when there is an error.

**Name and email** have no hint. With an error they get `aria-describedby="{name}-error"` as today; without one, no
attribute.

**Unchanged**: labels `Name`, `Email` and `Password`; `autocomplete` values `name`, `username` and `new-password`;
`required`; the submit text `Create account` / `Creating…`; the form-level alert.

## 8. Documentation edits

- `docs/design-system.md` §7:
  - add a `SetupNotice` row (props; "EmptyState variant for prerequisite gates: Generate, Batch jobs, New batch job,
    New batch job from CSV"; rows shared with Checklist);
  - in the `Checklist` row, remove "also used for prerequisite lists (Generate, Jobs)" and add the `footer` prop.
- `docs/accounts.md:66`: "just above its posting slots" → "below its posting slots, in a collapsed **Posting
  instructions** section". Also add one sentence that connecting an account opens its posting slots.
- `docs/decisions.md`: a new `## 033 — Accounts restructure and first-post flow (2026-10-09)` section with:
  - FR-019 (navigation, not a connect-flow behaviour change);
  - FR-062 (not included, no later owner);
  - the Intl-for-instant→date note (research R10);
  - the `accounts-ui.test.ts` assertions that changed on purpose;
  - the open item: the exact docket-ui skill line, if the sandbox refuses the write (FR-027). The line, in the
    "States" section: `Prerequisite gates (Generate, Batch jobs, New batch job pages) use SetupNotice; the overview's
    progress list uses Checklist.`, replacing the entry-2 phrase "prerequisite lists use `Checklist`".
