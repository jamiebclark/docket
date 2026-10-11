# Contracts — UI: the grid, the card, the wording

Follows `docs/design-system.md` and the `docket-ui` skill. Every control here is a server-rendered form
that works with **no client JavaScript** (FR-017); nothing on either screen becomes a client component.

---

## 1. The switch (`NotificationSwitch`, new, server component)

One switch = one `<form>` = one submit button (Q18).

```tsx
<NotificationSwitch
  projectSlug="woodwork"        // omitted on the project settings card (the route supplies it)
  projectName="Woodwork"
  axis="kind"                   // "kind" | "platform"
  switchKey="failed"
  label="Failed"                // OUTCOME_LABEL, or the platform's display name
  on={true}
/>
```

Renders:

```html
<form action="…server action…">
  <input type="hidden" name="projectSlug" value="woodwork">
  <input type="hidden" name="axis" value="kind">
  <input type="hidden" name="key" value="failed">
  <input type="hidden" name="on" value="false">            <!-- the target state, not a toggle -->
  <button type="submit" class="…Button secondary sm…">On
    <span class="sr-only"> — turn off Failed notifications for Woodwork</span>
  </button>
</form>
```

- **Visible text** is `On` or `Off` — status as text, which is what the design system requires; the
  button's purple outline is the only colour, so nothing depends on hue.
- **Accessible name** is `"On — turn off Failed notifications for Woodwork"`: the state, the project
  and what the switch governs, so two projects' "Failed" switches are distinguishable (FR-015, SC-008).
- **No `aria-pressed`** (Q18): the visible label already is the state.
- Focus ring comes from `buttonStyles`; the switch is in the normal tab order with no `tabindex`.
- The two project-level controls are the same component with `axis="project"` and visible text
  "Turn all off" / "Turn all on", sr-only " notifications for Woodwork".

## 2. The grid (`NotificationPreferenceGrid`, new, server component)

`/notifications`, replacing the "Projects" card's three-column table (FR-015, Q19).

```
Table caption (sr-only): "Notifications for each of your projects"
Columns: Project | Failed | Needs your decision | Needs reconnecting | Connect failed | This project
```

Per project, one `RowGroup` holding:

- a `Row`: `Cell header` with the project name (and, when the roll-up is off, `projectOffText()` as a
  `Sub` line; when every kind is on but platforms are off, `platformsOffNote(labels)` as a `Sub` line —
  the spec's edge case, so the row never implies nothing is set); four `Cell`s each holding one kind
  switch; a last `Cell` holding "Turn all off" and "Turn all on" side by side (secondary + secondary,
  never two filled buttons);
- a `DetailRow` spanning all six columns:

  ```html
  <details>
    <summary>Platforms (2 of 3 on) — Woodwork</summary>
    <!-- one NotificationSwitch per offered platform, in registry order -->
    <!-- when none are offered: "This project has no connected accounts yet." -->
  </details>
  ```

  `<details>`/`<summary>` is the sanctioned no-JavaScript disclosure (§7 "Row actions"); the summary
  names the project so two open disclosures are still distinguishable. Keyboard: `Tab` reaches the
  summary, `Enter`/`Space` opens it, `Tab` continues into the switches. No JavaScript is involved in
  opening it.

Tab order within a project: name → the four kinds, left to right → Turn all off → Turn all on →
Platforms summary → the platform switches (FR-017, US4 scenario 4).

Below the grid, once per page: `preferenceHelpText()` (FR-018) and the existing "Docket only notifies
you inside Docket…" webhook sentence.

Phone layout is `Table`'s existing stacked rows: each cell is labelled with its column name from
`--col-N`, so the four kinds read as "Failed: On", "Needs your decision: Off" — no extra markup
(Q19).

Empty state: a person in no project gets the existing `EmptyState` ("You are not a member of any
project yet." + "Back to Docket"), not an error (US4 scenario 6, FR-015).

## 3. The project settings card

`/p/[projectSlug]/settings`, "Your notifications" (FR-016, N10 unchanged). The same per-project
control, built from the same component as one grid row, for **every** member role, in a `Card` separate
from `SettingsForm`:

- description: "Only you see this. Problems in this project always stay in Activity."
- a line naming the roll-up state in words (`projectOffText()` or "Notifications for this project are
  on.") — text, with a `Badge` only as reinforcement;
- the four kind switches as a labelled group (`<fieldset>` + sr-only `<legend>` "Tell me about");
- "Turn all off" / "Turn all on";
- the platforms `<details>` with the same offered set;
- `preferenceHelpText()`.

An editor who cannot submit `SettingsForm` can submit every one of these (US4 scenario 5).

## 4. Confirmations and errors

Both screens render from the query string, as today (Q20):

| State | Where | Text |
|---|---|---|
| a switch changed | `Alert tone="success"` above the cards | `switchConfirmation(name, label, on)` |
| a project control used | same | `projectSwitchConfirmation(name, on)` |
| unparseable confirmation params | same | "Notifications updated." |
| not found / busy / invalid | `Alert tone="danger"` | `muteErrorText(code)`, unchanged wording |

The `Alert`s are the existing ones in the page body; the announcement for screen readers is the
redirect itself (a fresh page load reads the alert). No `LiveRegion` is added for switch changes — the
no-JavaScript path is a full navigation, and the existing row actions keep their own announcements
(N12: the refresh stays quiet).

## 5. Wording that must appear (FR-018, FR-005)

| Thing | Words |
|---|---|
| What off does | "Turning a switch off only hides its notifications — the problems stay in Activity for everyone. Turning one back on starts from that moment: anything from while it was off is never delivered later." |
| The roll-up, off | "Notifications for this project are off." |
| A project-level control | "Turn all off" turns the four kinds off; "Turn all on" turns the four kinds **and** any switched-off platform on — stated in the help text so the asymmetry is never a surprise (Q12). |
| The panel, all projects off | "Notifications are off for all of your projects." + the Notifications link (FR-012, unchanged sentence) |

## 6. Accessibility checklist (SC-008)

- [ ] Every switch and button is reachable and operable by keyboard alone, in the order above, with a
      visible `ring-focus` ring.
- [ ] Every control's accessible name identifies the project **and** what it governs.
- [ ] Every state is text as well as colour (the switch says On/Off; the roll-up is a sentence).
- [ ] The grid is a real `<table>` with a `<caption>` and `<th scope="col">` / `<th scope="row">`.
- [ ] The platform disclosure is reachable and changeable with client JavaScript unavailable.
- [ ] `node scripts/check-contrast.mjs` stays green (no new colour pairing is introduced).
- [ ] The grid and the card render identically for every member role; nothing here is owner-only.

## 7. Docs owed by this entry (FR-025)

- `docs/design-system.md` §7: "a switch that saves on activation" (Q18) and the control-matrix
  exception to the five-column ceiling (Q19); `NotificationSwitch` and
  `NotificationPreferenceGrid` added to the component table.
- `.claude/skills/docket-ui/SKILL.md`: `/notifications` is "the per-project notification grid" rather
  than "mute settings", and the new pattern is named.
- `docs/activity.md` §Notifications: the "Muting" bullet is replaced by per-kind and per-platform
  preferences, the roll-up, the one-click all-off/all-on, the fresh-start rule, and the unchanged fact
  that delivery outside Docket is webhooks.
- `docs/decisions.md`: N25–N41 next to N5, N6 and N10, and Q1–Q24 next to 022's R1, R4, R5 and R14 —
  each stating the reversal, the replacement and the fate of the data written under the old rule.
