# Feature Specification: Docket Foundation — Accounts, Projects, Members, Invitations and Project Isolation

**Feature Branch**: `001-foundation-auth-projects`

**Created**: 2026-10-03

**Status**: Draft

**Input**: User description (roadmap entry `foundation`, reproduced in full because later phases rely on its technical detail):

> Build Docket's foundation. Before specifying, read docs/build-prompt.md in full (especially 'Stack', 'Deployment', 'Data model', 'Members and invitations', 'UI', 'Quality bar' and 'Owner answers'), .specify/memory/constitution.md, docs/research/better-auth.md, docs/research/tooling.md and docs/decisions.md.
>
> Must deliver:
> - Env handling: a Zod-validated env module that fails loudly at startup when a required variable is missing, and a complete .env.example documenting every variable (DATABASE_URL, DATABASE_URL_DIRECT for migrations, BETTER_AUTH_SECRET, BETTER_AUTH_URL, CREDENTIALS_ENCRYPTION_KEY, bootstrap admin vars, etc.).
> - Postgres via Drizzle ORM (drizzle-orm/node-postgres) with SQL migrations committed under drizzle/; package scripts db:generate, db:migrate, db:check (drizzle-kit check, used by CI), and a migrate step that runs on container start. Must work on local Postgres and on Neon with only the connection string changed (no session-level features).
> - docker-compose.yml with services postgres (postgres:17, healthcheck, named volume) and web (the existing Dockerfile; runs migrations then the server). A worker service is NOT added here (entry 2 adds it). `docker compose up` yields a working app at http://localhost:3000.
> - AES-256-GCM encrypt/decrypt helper for credentials at rest (key from env, versioned ciphertext format), with tests; never logs plaintext.
> - Better Auth (email + password) with the Drizzle adapter and the organization plugin, mapping one Better Auth organization to one Docket project. A Docket `projects` table (1:1 with organization) holds slug, timezone (IANA, validated), and default approval/scheduling policy columns (enums review_required|auto_approve and leave_as_draft|add_to_queue) — voice profile default is added by the generator entry.
> - Roles owner, admin, editor via createAccessControl; permissions enforced on the server in the DAL.
> - Bootstrap: if no users exist, either env vars (BOOTSTRAP_ADMIN_EMAIL/PASSWORD) seed the first user on startup, or a one-time /setup screen creates it; it then disappears. The first user can create projects; project creation is available to any logged-in user.
> - Invitations: owner/admin invites by email with role; expiry; revoke; regenerate. Docket-owned invitation_tokens table storing SHA-256 hashes of random single-use tokens mapped to the Better Auth invitation (Better Auth stores invitation ids in plain text — see research). Delivery behind an InvitationDelivery interface; the only implementation now: existing users see the invitation in-app (/invitations, plus a badge) with accept/decline; for unknown emails the inviter gets a copyable single-use URL. Sign-up is ONLY possible through a valid invitation URL (gate the Better Auth sign-up endpoint with a before hook that throws 400, per research), except the bootstrap path.
> - Members: list, change role, remove (kick), leave, transfer ownership; a project always keeps at least one owner; removal takes effect immediately for open sessions because the DAL re-checks membership on every request. Membership audit log table (actor, action, subject, project, timestamp, details) written for every invite/accept/decline/revoke/remove/leave/role change/transfer.
> - Scoped data-access layer in src/server/dal/: a forProject(session, projectSlug) entry point that resolves membership+role per call and returns repository functions that always filter by project_id; a requireRole helper. An ESLint rule (no-restricted-imports) forbids importing the raw db client outside src/server/dal/ and src/server/db/. A Vitest test harness that records SQL (Drizzle logger) and fails if any query on a project-owned table lacks a project_id predicate; register the tables created here and make the registry easy for later entries to extend.
> - Test DB setup for Vitest using DATABASE_URL (CI provides a postgres:17 service): migrate a fresh schema per run, isolate tests.
> - UI (follow the docket-ui skill): /login, /signup?token=..., /setup, /invitations, project creation, /p/[projectSlug] app shell with left nav placeholders for later screens, keyboard-accessible project switcher (Ctrl/Cmd+K) that remembers the last project, project settings (name, slug, timezone, default policies) and members & invitations screens. Root / redirects to the last project or project creation.
> - Tests required: role checks enforced server-side; a removed member loses access immediately; last owner cannot be removed or demoted or leave; expired, revoked and already-used invitation tokens fail; sign-up without a valid token fails; the scope-enforcement test itself.
> - CI: the existing workflow's db:check step activates automatically once drizzle.config.ts exists; ensure lint, typecheck, test and build all pass in CI.
> - Update README (local setup, Docker Compose) and append decisions to docs/decisions.md.
>
> Must NOT do (later entries own these): social accounts, posts, media, slots, scheduler/worker/tick (entry 2), any UI for posts/calendar/composer/media (entry 3), providers (entries 2, 4, 5), voice profiles and LLMs (entry 6), API keys, public API and webhooks (entry 7), failures view and deployment docs (entry 8).

## Overview

Docket is a self-hosted tool used by its owner and a small number of invited
people to manage several independent projects. This feature delivers the base
everything else stands on: a self-hoster can start the app with one command,
create the first account, create projects, invite people into specific
projects with specific roles, and hop between projects quickly — while every
piece of project data is guaranteed to stay inside the project it belongs to.

No scheduling, posting, media, generation or API features are part of this
feature. The project shell shows where those screens will live.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Start Docket and create the first account (Priority: P1)

A self-hoster clones the repository, copies the example configuration, and
starts the stack with a single command. The database is prepared
automatically. If they supplied first-admin credentials in configuration, that
account exists on first start; otherwise the app shows a one-time setup screen
where they create it. Once the first account exists, the setup screen is gone
for good and the only ways in are logging in or accepting an invitation.

**Why this priority**: Nothing else can be used or tested until the app runs
and someone can log in. It also proves the deployment contract (one command,
any Postgres via connection string).

**Independent Test**: On a clean machine, copy the example configuration, run
the single start command, open the app in a browser, create the first account
(via setup screen or configured credentials), log out, and log back in.

**Acceptance Scenarios**:

1. **Given** a fresh install with no accounts and no first-admin credentials configured, **When** the operator opens the app, **Then** they are sent to the setup screen, can create an account with email and password, and land signed in on project creation.
2. **Given** a fresh install with no accounts and first-admin email and password configured, **When** the app starts, **Then** that account is created, the setup screen is never offered, and the operator can log in with those credentials.
3. **Given** at least one account exists, **When** anyone visits the setup screen, **Then** it is unavailable (they are sent to login) and no account can be created through it.
4. **Given** first-admin credentials are configured but accounts already exist, **When** the app restarts, **Then** nothing changes (no account is created, no password is reset).
5. **Given** a required configuration value is missing or malformed, **When** the app or the database-preparation step starts, **Then** it stops immediately with a message naming each offending variable and why it is invalid, without printing any secret values.
6. **Given** the same release, **When** it is pointed at a local Postgres or at a hosted serverless Postgres (Neon) by changing only the connection strings, **Then** database preparation and the app both work identically.
7. **Given** a signed-in user, **When** they sign out, **Then** their session ends and project pages require logging in again.

---

### User Story 2 - Create projects and hop between them (Priority: P1)

A signed-in user creates a project by giving it a name, a URL slug and a time
zone, and becomes its owner. They can belong to many projects. A project
switcher is always visible, opens from the keyboard, filters as they type, and
takes them to the chosen project. Visiting the app root returns them to the
last project they used.

**Why this priority**: Fast project hopping is the product's most important
property, and every later screen lives inside a project.

**Independent Test**: Sign in, create two projects, switch between them using
only the keyboard, close the browser, reopen the app root and confirm it lands
on the last project used.

**Acceptance Scenarios**:

1. **Given** a signed-in user with no projects, **When** they open the app root, **Then** they are taken to project creation.
2. **Given** a signed-in user on project creation, **When** they submit a name, a valid unique slug and a valid time zone, **Then** the project is created with them as its only owner, default policies are set to "review required" and "leave as draft", and they land on that project's home.
3. **Given** a slug that is already used, malformed, or reserved, or a time zone that is not a recognised IANA zone, **When** they submit, **Then** the project is not created and the error is shown next to the offending field.
4. **Given** a user who belongs to several projects, **When** they press Ctrl+K (or ⌘+K on macOS) anywhere in the app, **Then** the switcher opens with focus in a filter field, lists only projects they belong to, can be navigated with arrow keys, opens the highlighted project on Enter, and closes on Escape returning focus to where it was.
5. **Given** a user who last used project B, **When** they later open the app root in the same browser, **Then** they are taken to project B; if they no longer belong to B, they are taken to another project they belong to or, if none, to project creation.
6. **Given** a user inside a project, **When** the project home loads, **Then** they see the app shell: project switcher, left navigation with entries for the screens later features will add (Calendar, Posts, Compose, Generate, Jobs, Review, Media, Accounts, Voice, Settings), and a main area; navigation entries for unbuilt screens open a placeholder that says the screen is coming.

---

### User Story 3 - Invite people and let them join (Priority: P1)

An owner or admin invites someone by email with a role. If that email belongs
to an existing account, the invitee sees the invitation inside the app (with a
count badge) and accepts or declines it. If the email has no account, the
inviter gets a single-use link to copy and send themselves; the invitee opens
it and creates their account through it, joining the project in the same step.
Invitations expire and can be revoked or regenerated. Creating an account
without a valid invitation link is impossible (apart from first-run setup).

**Why this priority**: Docket is invite-only; this is the only way anyone other
than the first user gets in, and the security of sign-up depends on it.

**Independent Test**: As an owner, invite one existing user and one new email.
The existing user accepts from their invitations page; the new person signs up
through the copied link. Then confirm a revoked link, an expired link, an
already-used link and a sign-up attempt with no link all fail.

**Acceptance Scenarios**:

1. **Given** an owner or admin on the members and invitations screen, **When** they invite an email with a role they are allowed to grant, **Then** a pending invitation appears in the list with its role, inviter and expiry time.
2. **Given** the invited email has no account, **When** the invitation is created (or regenerated), **Then** the inviter is shown a single-use invitation link with a copy action, told it is shown only once, and told when it expires; the link is never shown again afterwards.
3. **Given** the invited email belongs to an existing account, **When** that user is signed in, **Then** they see a badge with their pending-invitation count and can open their invitations page listing each invitation's project, role and inviter, with Accept and Decline actions.
4. **Given** a pending invitation, **When** the invitee accepts, **Then** they become a member with the invited role, the invitation is no longer pending, and they can open the project immediately.
5. **Given** a pending invitation, **When** the invitee declines, **Then** they do not join, the invitation is no longer pending, and the inviter sees it as declined.
6. **Given** a valid invitation link for an email with no account, **When** the person opens it, **Then** they see which project and role they are invited to, the email field is fixed to the invited address, and submitting a name and password creates their account, adds them to the project, signs them in and takes them to the project.
7. **Given** an invitation link that has been revoked, regenerated, has expired, or has already been used, **When** anyone opens it or submits the sign-up form with it, **Then** no account is created, no membership is created, and they see a plain message that the invitation is no longer valid and to ask for a new one.
8. **Given** no invitation link (or a made-up one), **When** anyone attempts to create an account by any route, including calling the sign-up endpoint directly, **Then** the attempt is rejected and no account is created.
9. **Given** a pending invitation, **When** an owner or admin revokes it, **Then** its link stops working immediately and the invitee no longer sees it in-app.
10. **Given** a pending or expired invitation, **When** an owner or admin regenerates it, **Then** any previous link stops working, a fresh link (for unknown emails) is shown once, and the expiry is reset.
11. **Given** a signed-in user whose email differs from the invitation's email, **When** they open an invitation link, **Then** they are told the invitation is for a different email and offered to sign out; they cannot accept it.

---

### User Story 4 - Manage members and keep projects safe (Priority: P2)

Owners and admins see who is in the project and remove people. Owners change
roles and transfer ownership. Anyone can leave a project. A project can never
be left without an owner. Removing someone takes effect on their very next
action, even if they have the project open in another tab.

**Why this priority**: Needed to run projects safely over time, but the app is
usable for a single owner (and for invited members) before this exists.

**Independent Test**: With an owner, an admin and an editor in a project,
exercise each action and confirm role limits, last-owner protection, and that a
removed member's open browser tab loses access on its next request.

**Acceptance Scenarios**:

1. **Given** any member, **When** they open the members screen, **Then** they see every member's name, email, role and join date.
2. **Given** an owner, **When** they change a member's role, **Then** the change applies immediately and the member's next action is checked against the new role.
3. **Given** an owner or admin, **When** they remove a member they are allowed to remove (after confirming in a dialog that names the person), **Then** that person's very next request to the project — including from a tab already open — is refused as if the project did not exist, and the project disappears from their switcher.
4. **Given** a member who is not the only owner, **When** they choose to leave the project and confirm, **Then** they are no longer a member and are taken to another of their projects or project creation.
5. **Given** a project with exactly one owner, **When** anyone tries to remove that owner, demote that owner, or that owner tries to leave, **Then** the action is refused with a message explaining a project must keep at least one owner (and suggesting transferring ownership first).
6. **Given** an owner, **When** they transfer ownership to another member and confirm, **Then** the other member becomes an owner and the transferring owner becomes an admin.
7. **Given** an editor (or an admin attempting an owner-only action), **When** they attempt a management action by any means, including crafting the request directly rather than using the UI, **Then** the server refuses it and nothing changes.
8. **Given** any invite, accept, decline, revoke, regenerate, remove, leave, role change or ownership transfer, **When** it succeeds, **Then** an audit entry records who did it, what was done, to whom, in which project, when, and relevant details (e.g. old and new role).
9. **Given** an owner or admin, **When** they open the members screen, **Then** they can see the project's recent membership activity from the audit log, newest first.

---

### User Story 5 - Configure project settings (Priority: P2)

Owners and admins edit a project's name, slug, time zone and default approval
and scheduling policies. Editors can see the settings but not change them.

**Why this priority**: Defaults matter for later features (generation and
queueing read them), but sensible defaults are set at creation.

**Independent Test**: As an owner, change each setting and confirm it persists;
change the slug and confirm the project is reachable at the new address; as an
editor confirm the form is read-only and direct submissions are refused.

**Acceptance Scenarios**:

1. **Given** an owner or admin on project settings, **When** they change the name, time zone, default approval policy (review required / auto-approve) or default scheduling policy (leave as draft / add to queue) with valid values, **Then** the change is saved and shown.
2. **Given** an owner or admin, **When** they change the slug to a valid unused value, **Then** the project moves to the new address, they are taken there, and the switcher and last-project memory use the new slug.
3. **Given** an editor, **When** they view settings, **Then** the values are visible but not editable, and a direct attempt to save is refused by the server.
4. **Given** the auto-approve option, **When** it is shown, **Then** it is clearly labelled as letting generated posts skip review.

---

### User Story 6 - Guaranteed project isolation (Priority: P1, developer-facing)

Developers building later features get one sanctioned way to read and write
project data. It confirms on every call that the current user is still a member
of the project named in the address, with the role the operation needs, and
every query it issues is limited to that project. Automated checks fail the
build if code bypasses it or if any query touches project-owned data without
being limited to one project.

**Why this priority**: Project isolation is a core promise and a constitution
principle; retrofitting it later is far costlier than building it first.

**Independent Test**: Run the automated test suite and lint: a deliberately
unscoped query against a registered project-owned table makes the scope test
fail; a deliberately added direct database import outside the sanctioned area
makes lint fail.

**Acceptance Scenarios**:

1. **Given** a user who is not a member of project X (or project X does not exist), **When** they request any page or action of project X, **Then** they get the same "not found" response either way, revealing nothing about X.
2. **Given** project-scoped server code, **When** it performs an operation needing a role the user lacks, **Then** the operation is refused before any data changes.
3. **Given** the automated test suite, **When** any test causes a query on a registered project-owned table that is not limited to a single project, **Then** the suite fails and names the offending query.
4. **Given** code outside the sanctioned data-access area, **When** it imports the raw database client, **Then** lint fails.
5. **Given** a later feature adding a new project-owned table, **When** a developer registers it, **Then** the scope check covers it with a one-line addition.

---

### Edge Cases

- **Email case**: invitation, login and sign-up email comparisons ignore letter case and surrounding whitespace.
- **Duplicate invite**: inviting an email that already has a pending invitation to the same project is refused with a pointer to regenerate the existing one; inviting an email that is already a member is refused.
- **Invitee already has an account but opens a link**: if signed in as that email they see an accept/decline page; if signed out they are asked to log in, then return to the accept/decline page. They are never offered sign-up for an existing email.
- **Invitation link raced**: two submissions of the same link (double-click, two tabs) — at most one succeeds; the other sees "no longer valid".
- **Token invalidated between page load and submit**: no account is created.
- **Role granting limits**: admins may invite or manage only editors and admins; only owners may invite owners, change roles, or transfer ownership. An admin cannot remove an owner.
- **Self-actions**: an owner demoting themselves is allowed only if another owner remains; the transfer target must already be a member.
- **Removed while mid-form**: a removed member submitting a form gets the "not found" response and the submission has no effect.
- **Expired session**: requests are sent to login and return to the original page afterwards.
- **Project time zone**: only recognised IANA zone names are accepted (e.g. `Europe/London`, `America/New_York`); free text and offsets like `+02:00` are rejected.
- **Slug rules**: lowercase letters, digits and single hyphens, 3–48 characters, not starting or ending with a hyphen, unique across the install, and not a reserved word used by the app's own routes (e.g. `new`, `settings`, `api`, `setup`, `login`, `signup`, `invitations`).
- **Old slug after rename**: the old address stops working (treated as not found); no redirect is kept.
- **Last-project memory points at a project the user left or was removed from**: falls back as in Story 2, scenario 5.
- **Setup race**: two people submitting the setup screen at once — exactly one account is created; the other is told setup is already complete.
- **Bootstrap credentials invalid** (bad email or password too short): startup fails loudly naming the variable.
- **Encryption key missing, wrong length, or changed**: startup fails if the key is missing or malformed; decrypting data written under an unknown key version fails with an error that contains no plaintext or key material.
- **Hosted database pooler**: nothing relies on a database connection keeping state between statements, so a transaction-mode connection pooler works.

## Requirements *(mandatory)*

### Functional Requirements

**Configuration and startup**

- **FR-001**: The system MUST validate all configuration at startup and refuse to start, listing every missing or malformed variable by name and reason, without echoing secret values.
- **FR-002**: The repository MUST include an example configuration file documenting every variable the app reads in this feature — at least the database connection string, a separate direct (non-pooled) connection string for schema migrations that falls back to the main one, the authentication secret, the app's public base URL, the credentials encryption key, the optional first-admin email and password, and the invitation lifetime — each with purpose, whether required, format, and a safe example or generation command.
- **FR-003**: Database schema changes MUST be committed to the repository as versioned SQL migrations; commands MUST exist to generate a migration from schema changes, apply migrations, and check that committed migrations match the schema (the check runs in CI).
- **FR-004**: The container image MUST apply pending migrations before starting the web server, and MUST NOT serve requests if migration fails.
- **FR-005**: The system MUST run unchanged against a local Postgres and a hosted Neon Postgres, differing only in connection strings, and MUST NOT depend on database-session state (advisory locks, LISTEN/NOTIFY, session variables) so it works through a transaction-mode pooler.
- **FR-006**: The repository MUST provide a Compose definition with a Postgres 17 service (health check, named persistent volume) and a web service built from the existing image that waits for the database to be healthy; a single `docker compose up` MUST yield a working app at `http://localhost:3000`. No worker service is added in this feature.

**Secrets at rest**

- **FR-007**: The system MUST provide a reusable facility to encrypt and decrypt secrets at rest with authenticated encryption (AES-256-GCM) using a 256-bit key from configuration, producing self-describing ciphertext that records a format/key version so keys can be rotated later; tampered or wrong-key ciphertext MUST fail to decrypt. It MUST never log or include plaintext or key material in errors.
- **FR-008**: Passwords and invitation tokens MUST never be stored in plain text, logged, or sent to the browser after the moment they are first shown.

**Accounts and sessions**

- **FR-009**: Users MUST be able to log in with email and password and log out. Failed logins MUST show a generic message that does not reveal whether the email exists, and repeated failures MUST be rate-limited.
- **FR-010**: Passwords MUST be at least 12 characters (maximum 128); the same rule applies to the setup screen, invitation sign-up and configured first-admin password.
- **FR-011**: Account creation MUST be possible only (a) through a valid invitation link whose email matches the account being created, or (b) through first-run bootstrap while zero accounts exist. Every other path — including direct calls to the sign-up endpoint — MUST be rejected with a client error and create nothing.
- **FR-012**: Bootstrap: when zero accounts exist and first-admin credentials are configured, the system MUST create that account at startup; when zero accounts exist and none are configured, a one-time setup screen MUST allow creating the first account. Once any account exists, the setup screen MUST be unavailable and bootstrap configuration MUST be ignored. Creating the first account MUST be safe against concurrent attempts (exactly one succeeds).
- **FR-013**: Unauthenticated requests to any page other than login, setup (while available) and invitation sign-up MUST be redirected to login and returned to the requested page after logging in.

**Projects**

- **FR-014**: Any signed-in user MUST be able to create a project with a name, slug and IANA time zone, becoming its sole owner. Each project MUST correspond one-to-one with an organization in the authentication system.
- **FR-015**: A project MUST store name, slug (unique, rules in Edge Cases), time zone (validated IANA name), default approval policy (`review_required` | `auto_approve`, default `review_required`) and default scheduling policy (`leave_as_draft` | `add_to_queue`, default `leave_as_draft`). A default voice profile is NOT part of this feature.
- **FR-016**: Owners and admins MUST be able to edit all project settings; editors MUST be able to view them only.
- **FR-017**: All project-scoped pages MUST live under `/p/<project-slug>/…`, and the project in the address MUST be the sole source of "current project" for every request.
- **FR-018**: The root address MUST send a signed-in user to their last-used project (remembered per browser) if they are still a member, otherwise to another project they belong to, otherwise to project creation.
- **FR-019**: A project switcher MUST be visible on every project page, open via a button and via Ctrl+K / ⌘+K, support type-to-filter, arrow-key navigation, Enter to open and Escape to close, list only the user's projects, include a "Create project" action, and update the last-used project when used.
- **FR-020**: The project shell MUST show left navigation entries for Calendar, Posts, Compose, Generate, Jobs, Review, Media, Accounts, Voice and Settings; entries whose screens do not exist yet MUST open a placeholder page stating the screen is coming in a later release. Settings MUST contain project settings and members & invitations.

**Roles and permissions**

- **FR-021**: The system MUST support exactly three project roles — owner, admin, editor — with these management permissions in this feature:

  | Action | Owner | Admin | Editor |
  |---|---|---|---|
  | View project, members list | ✓ | ✓ | ✓ |
  | View/edit project settings | edit | edit | view |
  | Invite, revoke, regenerate invitations (editor/admin roles) | ✓ | ✓ | ✗ |
  | Invite with owner role | ✓ | ✗ | ✗ |
  | Remove editors/admins | ✓ | ✓ | ✗ |
  | Remove owners | ✓ | ✗ | ✗ |
  | Change roles, transfer ownership | ✓ | ✗ | ✗ |
  | View membership audit log | ✓ | ✓ | ✗ |
  | Leave project | ✓ (if another owner remains) | ✓ | ✓ |

  Permissions for later features (accounts, slots, voice, API keys for owner/admin; posts and generation for all roles) are defined by those features using the same mechanism.
- **FR-022**: Every project-scoped operation MUST, on the server and on every request, re-verify that the user is currently a member of the project named in the address and holds a role permitting the operation; UI hiding is never the enforcement.
- **FR-023**: Requests by non-members for a project, and requests for a non-existent project, MUST receive an identical "not found" response.
- **FR-024**: A project MUST always have at least one owner: removing, demoting, or leaving as the last owner MUST be refused with an explanatory message.

**Invitations**

- **FR-025**: Owners and admins MUST be able to invite an email address with a role (subject to FR-021); invitations MUST expire after a configurable lifetime (default 7 days) and MUST be revocable and regenerable while not accepted or declined.
- **FR-026**: Each invitation MUST have a random, unguessable (at least 256-bit) single-use token; only a one-way hash of it is stored. A token MUST stop working when used (accepted, signed up, or declined), revoked, regenerated, or expired. The plaintext link MUST be shown only once to the inviter.
- **FR-027**: Invitation delivery MUST sit behind a replaceable delivery interface. The only delivery in this feature: invitations to existing accounts appear in-app; invitations to unknown emails produce a copyable single-use link for the inviter. No email is sent.
- **FR-028**: Signed-in users MUST see a count badge of their pending invitations and an invitations page with Accept and Decline for each; accepting requires the signed-in email to match the invitation.
- **FR-029**: Opening a valid invitation link MUST show the project name, role and inviter; for an unknown email it MUST allow creating the account (email fixed to the invited address) and joining the project as one all-or-nothing step, then sign the user in.
- **FR-030**: Owners and admins MUST see the project's invitations with status (pending, accepted, declined, revoked, expired), role, inviter and expiry.

**Members**

- **FR-031**: The members screen MUST list members with name, email, role and join date, and offer change role, remove, transfer ownership and leave according to FR-021, each destructive action confirmed in a dialog naming the person.
- **FR-032**: Transferring ownership MUST make the target member an owner and the transferring owner an admin, as one step.
- **FR-033**: Every invite, accept, decline, revoke, regenerate, remove, leave, role change and ownership transfer MUST append an audit entry with actor, action, subject (person or email), project, timestamp and details (e.g. previous/new role); entries are never edited or deleted by the app.

**Project isolation (developer-facing)**

- **FR-034**: All reads and writes of project-owned data MUST go through a single scoped data-access entry point that takes the current session and project slug, resolves membership and role on each call, and exposes only operations that limit every query to that project. A role-check helper MUST be available to all project-scoped operations.
- **FR-035**: Lint MUST fail if the raw database client is imported outside the data-access and database-setup areas.
- **FR-036**: The automated test suite MUST record every query issued during tests and fail, naming the query, if any query on a registered project-owned table is not limited to a single project; the registry of project-owned tables MUST cover the tables introduced here and be extendable by later features with a single entry per table.
- **FR-037**: Automated tests MUST run against a real Postgres given by connection string (CI provides Postgres 17), start from a freshly migrated schema each run, and isolate tests so they do not depend on one another's data.

**Quality and documentation**

- **FR-038**: Automated tests MUST cover at minimum: server-side role enforcement; immediate loss of access after removal; last-owner protection for remove, demote and leave; failure of expired, revoked, regenerated-away and already-used invitation tokens; rejection of sign-up without a valid token; the encryption facility (round trip, tamper detection, wrong key, unknown version); configuration validation failures; and the scope check itself (it must fail on a deliberately unscoped query).
- **FR-039**: CI MUST pass lint, typecheck, tests, migration check and build for this feature.
- **FR-040**: The README MUST cover local development setup and running with Docker Compose (including first-run bootstrap and the security note below); judgement calls made in this feature MUST be appended to the decisions log.
- **FR-041**: All screens in this feature MUST follow Docket's UI conventions: full keyboard operation, visible focus, labelled fields with inline announced errors, loading/empty/error states, and a per-route page title.

### Key Entities

- **User**: a person who can log in (name, email, password credential). Not project-scoped. Belongs to zero or more projects via memberships.
- **Session**: a signed-in browser session for a user. Does not carry the current project; the address does.
- **Project**: a self-contained workspace (name, slug, time zone, default approval policy, default scheduling policy). Corresponds one-to-one with an organization in the authentication system. Every other piece of project data in later features belongs to exactly one project.
- **Membership**: a user's place in a project with one role (owner, admin, editor) and a join date.
- **Invitation**: an offer for an email address to join a project with a role; has inviter, status (pending, accepted, declined, revoked, expired) and expiry.
- **Invitation token**: the single-use secret behind an invitation link; stored only as a hash, linked to one invitation, with used/revoked state. Regenerating creates a new token and invalidates the old one.
- **Membership audit entry**: an append-only record of a membership change — actor, action, subject, project, timestamp, details.
- **Encrypted secret** (facility, not a table here): versioned ciphertext produced by the encryption facility, used by later features for social-account credentials.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new self-hoster can go from a fresh clone to logged in as the first user in under 10 minutes using only the README, with one start command.
- **SC-002**: Starting with any one required configuration value missing or malformed fails within 5 seconds with a message naming that variable, in 100% of tested cases, and no secret value appears in the output.
- **SC-003**: An owner can invite a new person and that person can be a working member of the project in under 3 minutes end to end.
- **SC-004**: 0 accounts can be created without a valid invitation link once the first account exists, across all tested routes (form, direct endpoint call, reused/expired/revoked/regenerated links).
- **SC-005**: After a member is removed, 0 subsequent requests from any of their open sessions succeed against that project.
- **SC-006**: 0 tested sequences of member actions leave a project without an owner.
- **SC-007**: A user can switch to any of their projects from the keyboard in no more than 4 keystrokes after the shortcut (shortcut, a few filter characters, Enter), and the new project's home is visible within 2 seconds on a local install.
- **SC-008**: 100% of queries on registered project-owned tables issued by the test suite are limited to a single project, and the check demonstrably fails when an unscoped query is introduced.
- **SC-009**: 0 plaintext invitation tokens, passwords or encryption keys are found in the database, application logs, or audit entries after running the full test suite.
- **SC-010**: 100% of membership changes performed in tests produce a matching audit entry.
- **SC-011**: The same build passes its database preparation and smoke test against both a local Postgres and a Neon database with only connection strings changed. If no Neon database is available to the build, the Neon half is reported as "not verified" rather than claimed (constitution principle II).

## Assumptions

- **Stack is fixed by the constitution** (Next.js App Router, TypeScript strict, Tailwind 4, Postgres via Drizzle with committed SQL migrations, Better Auth with its organization plugin, Zod, Vitest, Node 24, pnpm). Operator-facing names in this spec (configuration variables, routes, commands) are part of the self-hoster's contract, not implementation choices.
- **Better Auth facts come from `docs/research/better-auth.md`**: it stores invitation ids in plain text (hence Docket's hashed token table), removal does not end sessions (hence per-request membership checks), `disableSignUp` also blocks server-side sign-up (hence a sign-up hook that throws 400 rather than 403, because 403 can be turned into a fake success), and last-owner protection exists in its source but Docket tests it itself. Server-side organization creation for an explicit user id is UNVERIFIED in the research; the plan must check the installed types.
- **Organization tables vs `project_id`**: the authentication library's own membership and invitation tables are keyed by organization rather than `project_id`; because project and organization are one-to-one, those tables are scoped through that mapping. Docket-owned tables carry `project_id` directly. The plan decides exactly how the scope check treats the library's tables.
- **Invitation lifetime defaults to 7 days** (configurable) rather than the library's 48-hour default, because links are delivered by hand.
- **Transfer ownership demotes the transferring owner to admin**; multiple owners are allowed (an owner can also simply promote someone to owner).
- **Only owners can change roles** (per the brief: "Owners can change roles and transfer ownership"); admins can invite and remove editors and admins.
- **Editors can view the members list and settings** (read-only); they cannot see invitations or the audit log.
- **Non-members get "not found"**, not "forbidden", to avoid revealing which projects exist.
- **Setup-screen exposure**: until the first account exists, whoever reaches `/setup` first claims the install. The README recommends configuring first-admin credentials for any deployment reachable from the internet. No extra setup token is added.
- **Last-used project is remembered per browser** (a cookie), not per account.
- **Time zone on project creation is pre-filled from the browser's zone** and editable.
- **Session lifetime and login rate limiting use the authentication library's defaults**, documented in the README.
- **Out of scope for this feature**: password reset or change and email verification (no email delivery exists), profile editing beyond name at sign-up, project deletion or archiving, keeping redirects for renamed slugs, the scheduler-health indicator in the top bar (added with the scheduler), and everything the roadmap assigns to later entries — social accounts, posts, media, slots, scheduler/worker/tick, posts/calendar/composer/media UI, providers, voice profiles and LLMs, API keys, public API, webhooks, failures view, deployment docs.
- **Dependencies**: the existing Dockerfile and CI workflow (whose migration-check step turns on automatically once the Drizzle configuration exists); Postgres 17 for Compose and CI (decision 15).
