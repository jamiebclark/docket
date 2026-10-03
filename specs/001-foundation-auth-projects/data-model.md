# Data Model: Foundation

**Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

Conventions: Postgres 17 (Neon-compatible). Table and column names are
snake_case. Ids are `uuid` defaulting to `gen_random_uuid()` (Better Auth
`generateId: "uuid"`, research F7). Timestamps are `timestamptz` and stored
in UTC (research U1 covers Better Auth tables). Drizzle definitions live in
`src/server/db/schema/`. SQL migrations are generated into `drizzle/` and
committed.

**Scope column** = the column the scope check (research D8) requires every
query on that table to pin to one project. Tables with a scope column are
listed in the project-owned registry `src/server/db/project-owned.ts`.

## Overview

```text
user 1─* account            (credential: provider_id='credential', password hash)
user 1─* session
user 1─* member *─1 organization 1─1 projects        (projects.id = organization.id)
organization 1─* invitation 1─* invitation_tokens
projects 1─* membership_audit_log
install_state (singleton, system)
verification (Better Auth internal; unused by Docket flows)
```

## Better Auth tables

These columns are exactly what Better Auth 1.7.7 expects (research F7). The
runtime schema check (F8) fails loudly on drift. Docket-added constraints are
marked **+D**.

### `user` (not project-scoped)

| Column | Type | Rules |
|---|---|---|
| id | uuid PK | |
| name | text not null | 1–100 chars (Docket validation) |
| email | text not null unique | stored `trim().toLowerCase()` |
| email_verified | boolean not null default false | always false (no email in this feature) |
| image | text null | unused |
| created_at / updated_at | timestamptz not null default now() | |

### `account` (not project-scoped)

| Column | Type | Rules |
|---|---|---|
| id | uuid PK | |
| account_id | text not null | `= user.id` for credentials (F3) |
| provider_id | text not null | `'credential'` |
| user_id | uuid not null → user.id on delete cascade | index |
| password | text null | Better Auth `hashPassword` output, never plaintext (FR-008) |
| access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope | per F7 | unused here |
| created_at / updated_at | timestamptz not null | |

### `session` (not project-scoped)

Columns as F7: `id, expires_at, token unique, created_at, updated_at, ip_address, user_agent, user_id → user (cascade), active_organization_id`.
Docket **never reads** `active_organization_id`. The URL slug is the only
source of the current project (FR-017).

### `verification` (not project-scoped)

Columns as F7. Not used by Docket flows.

### `organization`: project-owned, scope column `id`

| Column | Type | Rules |
|---|---|---|
| id | uuid PK | equals `projects.id` (D3) |
| name | text not null | mirror of `projects.name` |
| slug | text not null unique | mirror of `projects.slug` |
| logo | text null | unused |
| metadata | text null | unused |
| created_at | timestamptz not null | |

### `member`: project-owned, scope column `organization_id`

| Column | Type | Rules |
|---|---|---|
| id | uuid PK | |
| organization_id | uuid not null → organization.id cascade | index |
| user_id | uuid not null → user.id cascade | index |
| role | text not null | **+D** `check (role in ('owner','admin','editor'))` |
| created_at | timestamptz not null | = join date shown on the members screen |

**+D** unique `(organization_id, user_id)`.
Invariant (enforced in the DAL under a project row lock, D12): every project
has ≥ 1 `owner` row.

### `invitation`: project-owned, scope column `organization_id`

| Column | Type | Rules |
|---|---|---|
| id | uuid PK | never put in URLs (Better Auth's plaintext lookup key) |
| organization_id | uuid not null → organization.id cascade | index |
| email | text not null | lowercased, trimmed |
| role | text | **+D** check in (`owner`,`admin`,`editor`); always set |
| status | text not null default 'pending' | `pending, accepted, rejected, canceled` (F7) |
| expires_at | timestamptz not null | `now() + INVITATION_TTL_DAYS`; reset on regenerate |
| created_at | timestamptz not null default now() | |
| inviter_id | uuid not null → user.id cascade | latest inviter (regenerate keeps the original) |

**+D** partial unique index `(organization_id, lower(email)) where status = 'pending'`.

**Shown status (D11)**:

| Stored | Condition | Shown as |
|---|---|---|
| pending | `expires_at > now()` | Pending |
| pending | `expires_at <= now()` | Expired |
| accepted | | Accepted |
| rejected | | Declined |
| canceled | | Revoked |

**State transitions** (all through Docket services, each writing an audit row):

```text
            invite
              │
              ▼
          ┌────────┐  accept (in-app / link / sign-up) ┌──────────┐
          │pending │ ─────────────────────────────────▶│ accepted │
          │        │  decline                          └──────────┘
          │        │ ─────────────────────────────────▶ rejected
          │        │  revoke (owner/admin)
          │        │ ─────────────────────────────────▶ canceled
          └────────┘
            ▲    │ time passes → shown as "expired" (still pending)
            └────┘ regenerate (pending or expired): new token, old token revoked,
                   expires_at reset, status stays pending
```

Accept and decline need `status='pending' AND expires_at > now()`.
Revoke and regenerate need `status='pending'` (expired allowed).

## Docket tables

### `projects`: project-owned, scope column `id`

| Column | Type | Rules |
|---|---|---|
| id | uuid PK → organization.id on delete cascade | D3 |
| name | text not null | 1–80 chars, trimmed |
| slug | text not null unique | D17 rules; mirrored to `organization.slug` in the same transaction |
| timezone | text not null | D17 IANA validation |
| default_approval_policy | enum `approval_policy` (`review_required`,`auto_approve`) not null default `review_required` | FR-015 |
| default_scheduling_policy | enum `scheduling_policy` (`leave_as_draft`,`add_to_queue`) not null default `leave_as_draft` | FR-015 |
| created_at / updated_at | timestamptz not null default now() | |

The default voice profile column is **not** added here (the generator entry
adds it). The Postgres enums `approval_policy` and `scheduling_policy` are
reused by later entries (job/API overrides).

### `invitation_tokens`: project-owned, scope column `project_id`

| Column | Type | Rules |
|---|---|---|
| id | uuid PK | |
| project_id | uuid not null → projects.id cascade | |
| invitation_id | uuid not null → invitation.id cascade | index |
| token_hash | text not null unique | hex SHA-256 of the 32-byte token (D6), 64 chars |
| created_by | uuid null → user.id set null | |
| created_at | timestamptz not null default now() | |
| used_at | timestamptz null | set when accepted, signed up or declined |
| revoked_at | timestamptz null | set on revoke, regenerate, or when the invitation is otherwise closed |

Partial unique index `(invitation_id) where used_at is null and revoked_at is null`:
at most one active token per invitation.

**Token valid** ⇔ `used_at IS NULL AND revoked_at IS NULL` and its invitation
is `pending` with `expires_at > now()`. A token is claimed by one
conditional `UPDATE … RETURNING` (D6). Closing an invitation in any way
(accept, decline, revoke) also sets `revoked_at` on remaining active tokens,
or `used_at` for the one that was used.

### `membership_audit_log`: project-owned, scope column `project_id`

| Column | Type | Rules |
|---|---|---|
| id | uuid PK | |
| project_id | uuid not null → projects.id cascade | index `(project_id, created_at desc)` |
| actor_user_id | uuid null → user.id set null | who did it (null only if a user row is ever removed) |
| action | enum `membership_action` not null | see below |
| subject_user_id | uuid null → user.id set null | the person acted on, when they have an account |
| subject_email | text null | invited email or the subject's email at that moment |
| details | jsonb not null default '{}' | e.g. `{ "role": "editor" }`, `{ "from": "editor", "to": "admin" }`, `{ "invitationId": "…" }` |
| created_at | timestamptz not null default now() | |

`membership_action` values: `invite`, `invite_regenerate`, `invite_revoke`,
`invite_accept`, `invite_decline`, `member_remove`, `member_leave`,
`role_change`, `ownership_transfer`.
The details never contain tokens, URLs or passwords (SC-009).
Rows are append-only: the DAL only has `insert` and `list` for this table
(FR-033).

### `install_state`: system table (not project data, no scope column)

| Column | Type | Rules |
|---|---|---|
| id | smallint PK `check (id = 1)` | singleton |
| first_user_id | uuid null → user.id set null | |
| completed_at | timestamptz not null default now() | |

Presence of the row means "first-run bootstrap done" (D13). `/setup` is
available only when there is no row **and** `user` is empty.

## Validation rules (shared Zod schemas in `src/lib/validation/`)

| Field | Rule | Used by |
|---|---|---|
| email | trim, lowercase, `z.email()`, ≤ 254 | login, setup, sign-up, invite, bootstrap env |
| password | 12–128 chars | setup, sign-up, bootstrap env (FR-010) |
| name (person) | trim, 1–100 | setup, sign-up |
| project name | trim, 1–80 | create, settings |
| slug | `^[a-z0-9]+(-[a-z0-9]+)*$`, 3–48, not reserved (D17) | create, settings |
| timezone | D17 | create, settings |
| role | `owner \| admin \| editor` | invite, change role |
| approval / scheduling policy | the enum values | settings |
| invitation token | base64url, exactly 43 chars (otherwise treated as invalid without a DB lookup) | `/signup` |

## Permission statements (`createAccessControl`, `src/server/auth/access.ts`)

| Resource | Actions | owner | admin | editor |
|---|---|---|---|---|
| project | view, update | view, update | view, update | view |
| member | view, remove, remove_owner, update_role, transfer_ownership | all | view, remove | view |
| invitation | view, create, create_owner, revoke, regenerate | all | view, create, revoke, regenerate | — |
| audit | view | ✓ | ✓ | — |

Rules the role table alone can't express are enforced in services:
last-owner protection, the transfer target must be a member, an admin
can't remove an owner (`remove_owner`), an admin can't grant the owner role
(`create_owner`), and leaving is allowed for everyone subject to last-owner
protection. Later features extend `statements` (accounts, slots, voice,
api_keys, posts, generation) in the same file.

## Project-owned registry (initial contents)

```text
projects.id
organization.id
member.organization_id
invitation.organization_id
invitation_tokens.project_id
membership_audit_log.project_id
```

A later feature adds one entry per new table (Story 6 #5). See
[contracts/dal.md](./contracts/dal.md).
