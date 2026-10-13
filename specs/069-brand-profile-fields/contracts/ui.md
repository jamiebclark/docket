# Contract: the project settings surface

**Feature**: `specs/069-brand-profile-fields` | **Date**: 2026-10-13

Three fields on the form that already exists, and one new sentence in the activity log. Follows the
`docket-ui` skill and `docs/design-system.md`; adds no UI primitive.

## 1. Where the fields go

`src/app/p/[projectSlug]/settings/settings-form.tsx`, in the existing General form, directly after
**URL name** and before **Time zone** (P24). Order within the form:

```text
Name
URL name
Tagline            ← new
Description        ← new
Website            ← new
Time zone
Default approval
Default scheduling
[unreviewed-queue confirmation]
Save settings
```

They answer the same question Name and URL name answer; time zone and the policies are operational.
One form, one post, one transaction — which is what makes "a slug conflict leaves the tagline unchanged"
true (contracts/services.md §1). No `<fieldset>`: this form has none today, and three labelled inputs do
not need a group heading to be understood.

`SettingsValues` gains `tagline: string | null; description: string | null; websiteUrl: string | null`,
passed by `page.tsx` from `scope.project` beside the five values it already passes.

## 2. The three controls

| Field | Component | `name` / `id` | Label | Hint |
|---|---|---|---|---|
| tagline | `Field` | `tagline` | `Tagline` | `One sentence saying what this is. Generated posts can use it. Up to {TAGLINE_MAX} characters.` |
| description | `TextareaField`, `minRows={4} maxRows={12}` | `description` | `Description` | `A longer explanation of what this is, for generated posts to draw on. Up to {BRAND_DESCRIPTION_MAX} characters.` |
| website | `Field`, `inputMode="url"`, `spellCheck={false}` | `websiteUrl` | `Website` | `The brand's own link, starting http:// or https://. Generated posts use it when a post needs a link. Up to {LINK_URL_MAX} characters.` |

Each limit is interpolated from the constant in `src/lib/validation/{brand,link}.ts` through
`.toLocaleString("en-US")` — the shape `PostingInstructionsForm` already uses for
`POSTING_INSTRUCTIONS_MAX` — never written as a literal, so a hint and its rule cannot drift. The form
imports them from `@/lib/validation/brand` and `@/lib/validation/link` directly, not through the
`@/lib/validation` barrel, so a client component pulls in two zod-only modules and nothing else.

All three:

- `defaultValue={values.<field> ?? ""}` — uncontrolled, like every other field on this form;
- `disabled={!canEdit}`;
- `error={errors.<field>}` — which both components render in their own `aria-live="polite"` region and
  link through `aria-describedby`, together with the hint (FR-020, FR-022);
- optional: nothing is `required`, and nothing becomes required for an existing project.

Multi-line text uses `TextareaField`, never a raw `<textarea>` (the skill requires this).

**No `maxLength` and no `type="url"`** (P26). `maxLength` truncates silently, hiding the over-length
error FR-010 and SC-006 require a person to see; `type="url"` hands the verdict to the browser, which
blocks submission with a native bubble instead of the field's announced message *and* accepts `ftp://`.
`src/lib/validation/link.ts` is the only judge.

No live character counter (P25): it needs a controlled value, `counterLabel` lives in the Generate
route, and nothing else on this form counts characters. The hint names each limit.

## 3. States

| Who | What they see |
|---|---|
| owner / admin | the three fields editable, with their current values, and the existing **Save settings** button |
| editor | the three fields **disabled**, showing their current values, under the existing note "Only owners and admins can change project settings.", and **no** save button (FR-023 — the form's current behaviour for name, slug, time zone and policies, inherited) |
| empty brand | empty inputs; no placeholder text pretending to be a value, no "not set" |
| save succeeded | the existing `role="status"` "Settings saved." (FR-022) |
| save failed on a brand field | that field's error text in its `aria-live` region; the other fields keep what was typed (the form re-renders from `defaultValue`, which is the current behaviour for name and slug too) |
| save failed overall | the existing `role="alert"` form-level message |

**Keyboard and no-JavaScript**: nothing new. The fields are plain form controls inside the form that
already posts to `updateProjectSettings`, so they are tab-reachable in visual order, show the shared
focus ring from `controlStyles`, and work with client JavaScript unavailable (FR-024) exactly as the
existing fields do.

The form does not move focus to the first invalid field on submit. That is a pre-existing gap affecting
all five existing fields equally; this entry inherits the behaviour rather than changing error handling
for the whole form, and it is noted here so a reviewer does not read it as new.

## 4. The page header

`src/app/p/[projectSlug]/settings/page.tsx` — the description becomes (P28):

```text
The project's name, what the brand is, its time zone, and how new posts are approved and scheduled.
```

Two tests pin this string byte-for-byte and are updated with it:
`tests/integration/terminology/page-headers.test.tsx` and `tests/integration/notifications/ui.test.tsx`.

## 5. The activity log sentence

`src/app/p/[projectSlug]/settings/members/activity-list.tsx` and `…/members/page.tsx` (P27, FR-018):

- `LABEL["project_brand_update"] = "changed the brand"`.
- `detailSubject` also matches `project_brand_update` and returns the **unquoted** human field name from
  `details.field`: `tagline` → `tagline`, `description` → `description`, `websiteUrl` → `website`. The
  quotes it adds elsewhere are for user-chosen names; `"tagline"` in quotes would read like a literal.
- A row therefore reads: `12 Oct, 14:02   Alex changed the brand tagline`.

In passing (P27): `LABEL["llm_credential_update"] = "changed this project's model credential"` — an
existing enum value that renders as a raw identifier today — and a new test asserts every
`membershipAction.enumValues` member has a `LABEL` entry, so the next action added cannot ship as a raw
enum value on the page.

Visibility is unchanged: the list only renders for members with `audit: ["view"]` (owner, admin), and no
public API operation reads this table (FR-019).

## 6. Not changed

- `/p/new` (project creation takes no brand value), the project switcher, the left nav, the settings
  sub-nav, `loading.tsx`, any `Card`, `Alert`, `Field`, `TextareaField` or other primitive.
- No logo, avatar or image control (FR-036); no per-platform profile copy and no profile sync
  (FR-037) — `image-generation` and later entries own those.
