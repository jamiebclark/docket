# Contract — Screens

Two screens, both server components, both fully usable with client JavaScript unavailable. Follows
`docs/design-system.md` and the `docket-ui` skill; the one extension to the design document is E28, written
into it in the same change.

---

## 1. The "Email" card on `/notifications`

`src/components/email/EmailSettingsCard.tsx`, rendered by `src/app/notifications/page.tsx` between the
problems list and the per-project preference grid. A `Card` with a heading, a short description and one
`<form>`.

### Six states

| State | What it shows |
|---|---|
| **unavailable** (`getMailer() === null`) | `text.unavailable`, no controls at all — not a disabled control, because a disabled control still implies a choice that could work (FR-002, FR-038) |
| **transport unavailable** (group set, `NEEDS DEPENDENCY`) | the controls, plus an `Alert` tone warning: "Email is configured but this build has no mail client installed, so nothing is being sent. Nothing is lost: the problems still waiting will be emailed once it is." (FR-005, US5 §6) |
| **off** (the default for everybody) | the cadence control with "Off" selected, the hour, zone and quiet-hours fields present but explained as applying once email is on, and all four sentences of FR-038 |
| **immediate** | as above, plus `text.immediateMeans` with `WORKER_INTERVAL_SECONDS` interpolated |
| **digest** | as above, plus `text.digestBeatsQuiet` beside the quiet-hours fieldset |
| **paused** | an `Alert` tone danger with `pausedRejected` or `pausedFailing`, its own one-button "Resume email" form, and `StatusBadge` "Paused" — words, never colour alone (FR-023, FR-035) |

Two further sentences appear when they apply, instead of promising mail that cannot come (FR-038, the
spec's first Edge Case): `text.noProjects` when the person is in no project, `text.allSwitchesOff` when no
project of theirs has any kind on.

### The controls

| Field | Control | Why |
|---|---|---|
| Cadence | `SegmentedControl layout="cards"` — Off / Immediate / Daily digest | three fixed options, each needing a sentence; built on native radios, so it submits with no JavaScript (design-system §7) |
| Digest hour | `Select`, 24 options, labelled in the person's zone | 24 options must be **changeable** with no JavaScript, which `Combobox`'s hidden input cannot do (E28) |
| Time zone | `Select`, grouped `<optgroup>` by area over `Intl.supportedValuesOf("timeZone")` plus `UTC`, with any unrecognised stored value kept as its own option so editing another field never silently changes it | same reason (E28) |
| Quiet hours | `<fieldset>` with `<legend>` "Quiet hours" and two `Select`s, From and To | the empty window (From = To) is "no quiet hours", stated in the hint (E14) |
| Save | one primary `Button`, right-aligned, pending state on the button itself | one primary action per form (docket-ui "Forms") |
| Resume | a separate one-button form, the Q18 state-showing-submit shape | a different question, so a different form (E29) |

`BrowserTimeZone` is the only client code on the page: a leaf `"use client"` component that, **only when
no zone is stored**, sets the zone `Select`'s value to
`Intl.DateTimeFormat().resolvedOptions().timeZone` on mount (N48). With JavaScript unavailable the select
is already correct — it is pre-selected to the derived default and says so — so the page loses a
convenience, never a capability (FR-037, SC-012).

### What the card reports back

- "Last emailed {formatLocal(lastSentAt, zone)}" or "You have not been emailed yet";
- when the last attempt failed: "Last attempt {formatLocal(at, zone)} — {reason in plain words}" (FR-035);
- nothing about anyone else, no delivery-log table, no other person's anything (N63, FR-035).

The zone hint names the zone in words beside every hour it governs (FR-008, N48), using
`zoneDerived` / `zoneDerivedUtc` / `zoneUnknown` from `text.ts`.

### Per-project exclusions

The card lists any project the person has excluded by the per-project unsubscribe, each with a one-button
"Email me about {Project} again" form. A project with no exclusion is not listed — absence is the neutral
state, so there is no column of "—" (docket-ui "Lists, tables"). The per-*kind* and per-*platform*
switches stay exactly where 043 put them, in the grid below; this card never duplicates them (FR-009,
N46).

---

## 2. The unsubscribe page

`src/app/email/unsubscribe/page.tsx`, inside `AuthShell` (`src/components/brand/AuthShell.tsx`). No session, no client JavaScript, no navigation
into the app beyond a sign-in link.

### With a valid token

A `PageHeader` "Problem emails", then, in this order:

1. **what is happening now**, in words: "You are getting an email about problems as soon as they appear"
   or "…one email a day at 7:00 AM EDT" or "You are not getting problem emails";
2. the primary submit: **"Stop all problem emails"**, one clearly labelled button (N57, FR-027);
3. a `<fieldset>` "Or something less drastic" with the three finer submits — stop one named project, send
   one email a day instead, turn them back on — each its own one-button form (FR-028);
4. **what is not affected**: "Your notifications inside Docket are not changed by anything on this page.
   The bell, the problems list and your per-project switches stay exactly as they are." (FR-030, N58);
5. a sign-in link for everything else: "Signed in, you can change all of this on your Notifications page."

### After a submit

The same page, re-rendered, with an `Alert` tone success naming **exactly** what was turned off and
**exactly** what is still on (FR-027, FR-028, SC-008). For example: "Problem emails are off. You will not
be emailed about problems in any project. Your notifications inside Docket have not changed."

### The one neutral page

Tampered, truncated, re-signed, expired, unknown, a rotated key, a deleted person, or a project the person
has left — all render the identical page, 200, nothing written (FR-029, E23):

> **This link cannot be used**
>
> It may have expired, or it may have been changed on its way here. Sign in to change your email settings,
> or use the link in a more recent email.
>
> [Sign in]

It reveals nothing about whether a person, a project or a token exists: one sentence, one status code, one
render path.

---

## 3. The invitation result

`src/app/p/[projectSlug]/settings/members/` — the invite and regenerate flows. `DeliveryDto` gains the
`email` field (services.md §7) and the result says which happened (FR-041, US7):

| Result | What the inviter is shown |
|---|---|
| `in_app`, `unavailable` | exactly today's wording. No mention of email (FR-041, US7 §3) |
| `manual_link`, `unavailable` | exactly today's `CopyField` link. No mention of email |
| `in_app`, `sent` | "Invitation sent. {Name} will see it in Docket and has been emailed." |
| `manual_link`, `sent` | "Invitation emailed." **plus the copyable link**, because a mail that never arrives must not strand an invitation (FR-041, N65) |
| either, `failed` | "The invitation was created, but the email did not go out." plus the copyable link, with no technical detail and **no address** in the message (FR-034) |

Nothing about the invitation record, its token, its hashing, its single use or its expiry changes
(FR-041).

---

## 4. Accessibility checklist

Every item asserted by `tests/integration/email/ui.test.ts` over the rendered markup.

- [ ] every control has a visible `<label>`; help text through `aria-describedby`; errors beside the field
      and announced (`aria-live="polite"`);
- [ ] related fields grouped in `<fieldset>`/`<legend>` — the quiet-hours pair, and the unsubscribe page's
      finer options;
- [ ] one primary action per form, right-aligned; the resume and per-project forms are secondary styling;
- [ ] full keyboard operation with visible focus rings (`focus-visible:ring-2`) and a logical tab order;
      the `SegmentedControl`'s radios move with the arrow keys and leave with Tab;
- [ ] every state is text as well as colour — "Paused", "Off", "Unavailable" are words, never a colour
      alone (docket-ui "Status badges");
- [ ] accessible names say what the control governs, not just its state: the resume button's hidden span
      names email, the per-project form's names the project;
- [ ] **every control works and every change saves with client JavaScript unavailable**, asserted by
      rendering with no client bundle and submitting the forms directly (FR-037, FR-039, SC-012);
- [ ] semantic token classes only (`bg-surface`, `text-muted-foreground`, `border-input`, `text-danger`);
      no `dark:` variants, no raw palette classes;
- [ ] every instant through `formatLocal` / `LocalTime` — one date format, in the person's zone
      (`tests/lint/date-format.test.ts`);
- [ ] the unsubscribe page is reachable with no session and renders inside `AuthShell` with a `<main>`
      landmark, a page `<title>` and a skip link;
- [ ] `loading.tsx` on `/notifications` gains a skeleton block matching the new card's height, so the page
      does not jump (docket-ui "States").

---

## 5. Docs this entry owes

| File | What changes |
|---|---|
| `docs/decisions.md` | **N42–N67** next to the decisions they extend or depart from — N45 next to N27 stating plainly that it is *not* a reversal, N56's strengthening next to N56, N60's departure next to the webhook-log decisions, N64/N65 next to R1 and the invitation decisions, N58 next to N5, N61 next to R14 — plus plan decisions **E1–E34** |
| `docs/deployment.md` | configuring a mail server; what happens with none; that asynchronous delivery reports are invisible to Docket (N62); and, beside the backup instructions, that restoring to a point before a send is the one case the no-double-send rule cannot cover |
| `docs/accounts.md` | line 44's "Docket sends no email" replaced by both paths |
| `docs/build-prompt.md` | line 85's "Invitation delivery, for now, uses no email at all" replaced by the kept promise |
| `docs/activity.md` | §Notifications gains email, cadence, quiet hours, pausing and unsubscribe |
| `docs/design-system.md` | §7's control table gains the no-JavaScript exception (E28) |
| `.claude/skills/docket-ui/SKILL.md` | the same exception, for later UI work |
| `.env.example` | the seven SMTP variables in the house Group/Optional format (mailer.md §3) |
| `docs/n8n.md` | **unchanged** — still the answer for automation, and named as such |

Each of these says what this entry does not do and which later entry owns it: real-time transport is
`realtime-updates`; push and chat delivery, success notifications, per-event actions inside an email and
inbound mail are owned by nothing in this roadmap (FR-047).
