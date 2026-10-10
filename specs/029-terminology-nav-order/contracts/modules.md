# Module contract: shared code this entry adds or changes

Signatures and behaviour only. Bodies belong to the implement phase. The rationale for each item is in
[research.md](../research.md).

## 1. `src/lib/roles/roles.ts` (new, pure, client-safe)

```ts
import type { Role } from "@/server/auth/access"; // type-only; erased at build

export interface RoleOption {
  value: Role;
  label: string;        // "Editor" | "Admin" | "Owner"
  description: string;  // FR-051 wording, verbatim
}

/** Editor, Admin, Owner, in that order. Every role-showing screen reads from this. */
export const ROLE_OPTIONS: readonly RoleOption[];

/** Display name for a role key; an unknown key comes back with its first letter capitalised. */
export function roleLabel(role: string): string;

/** One-line summary for a role key; `undefined` for an unknown key. */
export function roleDescription(role: string): string | undefined;
```

**Rules**:

- No runtime import from `@/server/*`, `server-only` or the DB (it's imported by the client
  `invitations-panel.tsx`).
- `ROLE_OPTIONS` is structurally assignable to `ChoiceOption[]` (`SegmentedControl.tsx:6-14`), so it can go straight
  into `options` (filtered).
- The strings are the single source. No other file spells "Writes, schedules and generates posts…", and the
  docket-ui skill points here (FR-081).

**Callers**:

- `settings/members/invitations-panel.tsx`: the invite form and the table's role cell;
- `settings/members/members-panel.tsx`: replaces its local `ROLE_OPTIONS` labels (no descriptions) and the
  `capitalize` span;
- `src/app/signup/page.tsx`;
- `src/app/invitations/page.tsx`;
- `src/lib/overview/derive.ts`: `ROLE_LABEL` derived as `` `an ${roleLabel(r)}` ``, with identical output.

## 2. `src/components/ui/StatusBadge.tsx` (extended)

```ts
/** Human label for a post, target, account or job status; unknown values read as their raw name. (unchanged) */
export function statusLabel(status: string): string;

/** Tone for the same vocabulary; unknown values are "neutral". */
export function statusTone(status: string): BadgeTone;

/** unchanged API; now uses statusTone internally */
export function StatusBadge({ status }: { status: string }): JSX.Element;
```

The `STATUSES` table isn't changed. Every value of `postTargetStatus.enumValues` has an entry (the test asserts it).

## 3. `src/components/ui/PageHeader.tsx` (extended)

```ts
export function PageHeader(props: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  titleId?: string;
  /** Rendered on the title's line, after the `<h1>` and outside it (status badges). */
  aside?: ReactNode;
}): JSX.Element;
```

**Rules**:

- Without `aside`, the markup is byte-for-byte what it is today. That keeps the six existing callers and their tests
  unchanged.
- With `aside`, the `<h1>` and the aside share a `flex flex-wrap items-center gap-3` row. The `<h1>`'s text content
  is still only `title`.
- `titleId` behaviour is unchanged: `id` plus `tabIndex={-1}`.

## 4. `src/components/shell/LeftNav.tsx` (data change only)

- **`NAV_SECTIONS`**: the order and labels in [ui.md](./ui.md) §1. Activity's `group` is `"Project"`.
- **`NAV_GROUPS`**: unchanged.
- **Unchanged**: `isNavItemActive`, `NavLink` and the `LeftNav` props and markup.

## 5. `src/app/p/[projectSlug]/voice/VoiceEditor.tsx` → `Area` (internal)

- **Props**: unchanged (`hint?: string` already exists).
- **Markup**:
  - the hint `<p>` gets `id={`${id}-hint`}`;
  - the error `<p>` gets `id={`${id}-error`}`;
  - the `<textarea>` gets `aria-describedby` with the ids that are present, space-separated, or no attribute when
    neither is.
- **Voice group**: the four `Area`s pass the FR-060 hint strings.

## 6. `TimeZoneField` usage on `/p/new`

`new-project-form.tsx` passes `hint="Posting times and the calendar use this zone."`. `TimeZoneField`'s default hint
and API are unchanged.

## 7. Test helper: `tests/helpers/page-header.ts` (new)

```ts
/**
 * Asserts the page renders exactly one `<h1>`, that its text includes `title`,
 * and that `description` is the text of the `<p>` that follows the heading block.
 */
export function expectPageHeader(html: string, expected: { title: string; description: string }): void;
```

Descriptions with apostrophes are compared after unescaping `&#x27;` and `&amp;`, as `renderToStaticMarkup` emits.
Plain string checks are enough, so no HTML parser dependency is added.

## Not changed

- **Data and permissions**: services, the DAL, the schema, migrations, access rules, server actions, the public API
  (including its "Jobs" tag), env vars and `docker-compose.yml`;
- **URLs**: the `/voice` and `/jobs` paths.
