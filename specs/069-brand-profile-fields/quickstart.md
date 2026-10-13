# Quickstart: a project's tagline, description and website

**Feature**: `specs/069-brand-profile-fields` | Phase 1

How to run this feature and the checks that prove each user story. Nothing here makes a live provider
call: prompt composition is asserted against fixtures and snapshots only (constitution II).

## 1. Prerequisites

```bash
pnpm install                       # already installed in pipeline phases; no new dependency
pnpm db:migrate                    # applies 0027 (one enum value, three columns)
pnpm db:check                      # the committed SQL matches the schema
```

- **No new environment variable**, no new service, no operator step. An install that upgrades gets three
  empty brand values on every project and no change to any prompt.
- Integration tests need `DATABASE_URL` pointing at a database whose name ends in `_test`
  (`tests/setup/global-setup.ts` refuses anything else and clones one per worker). On this machine the
  test Postgres listens on **5555**, not the 5432 in `.env.example`.
- `LLM_PROVIDER` is irrelevant to every check below: the prompt-composition checks build prompts without
  calling a model, and the settings checks never generate.

## 2. Running it by hand

```bash
pnpm dev
```

1. Sign in as a project **owner** or **admin** and open **Settings** (`/p/<slug>/settings`).
2. Fill **Tagline**, **Description** and **Website**; press **Save settings**. Expect "Settings saved."
3. Reload: the three values come back.
4. Open **Settings → Members & invitations** and read **Recent activity**: one row per field you
   changed — "… changed the brand tagline".
5. Clear the **Website** and save: the field empties, and a new row records the previous link.
6. Type `example.com` into **Website** and save: the field shows "Enter a full http or https link",
   nothing is stored, and no new activity row appears.
7. Open **Generate**, generate one post, then open the generated post's detail: the recorded prompt
   carries a `BRAND` section before `VOICE`.
8. Sign in as an **editor** and open **Settings**: the three fields show their values, are disabled,
   the "Only owners and admins can change project settings." note is shown and there is no save button.

## 3. The checks that prove each story

Run only what you need; CI runs everything.

### Migration and schema (FR-001 – FR-003)

```bash
pnpm db:check
pnpm vitest run tests/integration/project-brand.test.ts
```

Proves: the committed SQL matches the Drizzle schema; the three columns exist and are empty for a
project created before the brand existed; the new `project_brand_update` action value is usable.

### US1 — an owner records what the brand is (P1)

```bash
pnpm vitest run src/lib/validation/brand.test.ts src/lib/validation/voice.test.ts tests/integration/project-brand.test.ts
```

Proves:

- each field at its limit (200 / 1000 / 500) accepted and one over refused, with that field's message;
- a website with no scheme, a scheme-relative URL, `javascript:`, `data:`, `file:`, `ftp:` refused; an
  uppercase scheme accepted; 500 accepted and 501 refused;
- whitespace-only input clears; set → cleared → set round-trips, with a row at each step;
- an omitted key leaves the stored value alone (FR-008); a present-but-empty key clears it;
- a tagline's line breaks collapse to single spaces; a description keeps its blank lines;
- the website is stored exactly as typed apart from trimming (FR-011);
- one audit row per changed field with the right actor, `field`, `previous` and `next`; none for an
  unchanged field; none when validation fails; none when a slug conflict aborts the save;
- two concurrent saves: the second records the first's value as `previous` (FR-017);
- `assertAuditDetailsSafe` accepts all three fields' `details` (FR-019);
- **`voice.test.ts` passes unedited** — the shared link rule changed no preferred-link behaviour
  (FR-031).

### US2 — a generated post can say what the product is (P1)

```bash
pnpm vitest run src/server/services/generation/prompt.test.ts src/server/services/generation/prompt.golden.test.ts tests/integration/generation/brand-context.test.ts
```

Proves:

- all eight set/unset combinations compose the right lines, in the order tagline → description →
  website, with no placeholder for an unset value;
- `BRAND` precedes `VOICE`; the bounding output rule appears only when the section does;
- the all-unset case is **byte-identical** to the recorded golden prompts — `pre-011-prompts.json` and
  `__fixtures__/cases.ts` are not edited, and the existing snapshot entries are not re-recorded
  (FR-027, SC-003);
- a series-plan prompt carries the same section in the same position;
- brand website plus a voice `preferredLinks` entry: both appear, in their own sections (FR-031);
- brand set with an entirely empty voice: the brand section appears and no empty `VOICE` section is
  emitted;
- a description containing `</source_material>` does not break the prompt's structure;
- every generation path carries it — single, regenerate, "Try it", a batch-job item and a series plan
  (FR-029, SC-002).

### US3 — an editor can read but not change (P2)

```bash
pnpm vitest run tests/integration/project-brand.test.ts 'src/app/p/[projectSlug]/settings/settings-form.test.tsx'
```

Proves: an editor's save is refused by the service with nothing written and no audit row; an owner's and
an admin's succeed; a save naming another project is refused; the form renders the three fields with
their values, disabled and with no save button for a member who cannot edit, and surfaces each field's
error.

### The surface and the log

```bash
pnpm vitest run tests/integration/terminology/page-headers.test.tsx tests/integration/notifications/ui.test.tsx 'src/app/p/[projectSlug]/settings/members/activity-list.test.tsx'
```

Proves: the updated page description, and that every `membership_action` value has a human sentence in
the activity list — including the new one and the `llm_credential_update` that had none.

### The API is untouched (FR-038, SC-008)

```bash
pnpm vitest run tests/integration/api
```

Proves: the generated API document and every API test are identical. Nothing under `src/server/api/`
is edited by this entry.

## 4. The final pass

Once, at the end of the implement phase (constitution's "run checks in proportion"):

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build
```

`db:check` because the schema changed; `build` because a route's component tree changed.

## 5. What this does not do

Stated here so a reviewer does not look for it: no logo or avatar field (FR-036); no per-platform
profile copy and no profile sync to any platform (FR-037); no API read or write of these values —
`setup-write-api` (roadmap entry 5) owns that (FR-038); no generated images (`image-generation`), no
standing or date-pegged series (`evergreen-series`, `dated-series`). Voice-profile `preferredLinks` are
unchanged in every respect (FR-031).
