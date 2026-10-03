# Better Auth — verified facts

Checked 2026-10-02. Latest **better-auth v1.7.7** (2026-09-30). Some findings
come from reading source on GitHub where docs were silent (noted).

## Organization plugin → one organization per Docket project
https://www.better-auth.com/docs/plugins/organization
- Covered: invite by email with role (multi-role supported), accept, reject,
  cancel; `invitationExpiresIn` (seconds, default 48 h); list org invitations,
  get invitation, `listUserInvitations` (current user's pending);
  `removeMember`, `leaveOrganization`, `updateMemberRole`; custom roles via
  `createAccessControl` + `ac.newRole` and `hasPermission`;
  `activeOrganizationId` on the session + `setActive`; `organizationHooks`
  before/after for create/update org, add/remove member, update role,
  create/accept/reject/cancel invitation (throwing in a before hook blocks).
- Accept requires a logged-in session whose email matches the invitation;
  status and expiry are checked.
- **Last-owner protection exists in source** (not documented): leaving/removing
  as the only owner → `YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER`;
  demoting the last owner → `..._WITHOUT_AN_OWNER`.
  https://raw.githubusercontent.com/better-auth/better-auth/main/packages/better-auth/src/plugins/organization/routes/crud-members.ts
  (issue #3651 / PR #3955). Docket still tests this itself.
- **Email not required**: if `sendInvitationEmail` is absent, sending is
  skipped; create returns the invitation (with `id`).
  https://raw.githubusercontent.com/better-auth/better-auth/main/packages/better-auth/src/plugins/organization/routes/crud-invites.ts

### Gaps Docket must fill
1. **Invitation tokens are not hashed** — the invitation `id` is the lookup key,
   stored in plain text. Docket keeps its own `invitation_tokens` table:
   random 32-byte token shown once in the URL, SHA-256 hash stored, mapped to
   the Better Auth invitation id; single-use; revocable; regenerate = new token.
2. **Removal does not end sessions** — only the self-removal path clears
   `activeOrganizationId`. Docket's DAL checks membership on every request
   (by project slug), so removal is immediate.
3. **Invite-only sign-up** — `emailAndPassword.disableSignUp` also blocks
   server-side `auth.api.signUpEmail`, so do not use it. Gate sign-up in
   `hooks.before` for `/sign-up/email` (and/or `databaseHooks.user.create.before`)
   requiring a valid invitation token, except for the bootstrap path.
   **Throw a 400, not 403**: a 403 is turned into a fake success when
   `requireEmailVerification` is on or `autoSignIn: false` (anti-enumeration).
   No official recipe; pattern from community projects.
   https://raw.githubusercontent.com/better-auth/better-auth/main/packages/better-auth/src/api/routes/sign-up.ts
4. Docket uses the URL slug (`/p/[projectSlug]`), not `activeOrganizationId`,
   as the source of the current project.

## API key plugin
https://www.better-auth.com/docs/plugins/api-key
- Separate package **`@better-auth/api-key`**.
- User-owned or organization-owned keys (`references`, `organizationId`),
  permissions checked at verify time, **hashed by default**, per-key rate
  limiting, expiry, remaining uses/refill, metadata, prefix; optional sessions
  from keys (`enableSessionForAPIKeys` — Docket does not need it).
- **UNVERIFIED**: that the plaintext key is returned only on create (implied
  by hashing — confirm in a test). Interaction between org-owned keys and org
  roles not verified — Docket maps key permissions to its own permission set.

## Drizzle + CLI
https://www.better-auth.com/docs/adapters/drizzle , https://www.better-auth.com/docs/concepts/cli
- Adapter `@better-auth/drizzle-adapter`: `drizzleAdapter(db, { provider: "pg", schema })`.
- CLI is now `npx auth@latest generate --adapter drizzle --dialect postgresql`
  (old `@better-auth/cli` superseded). It writes a Drizzle schema file; then
  run `drizzle-kit generate`. `auth migrate` only works with the Kysely adapter.
- 1.7.3 rolled back an account-table change — read release notes on upgrade.

## Bootstrap first user
https://www.better-auth.com/docs/plugins/admin
- `auth.api.createUser` (admin plugin) can be called server-side with no
  session when no request headers are passed (source; docs say "requires
  session"). Or `npx auth@latest create-admin`. Docket: a one-time setup
  screen / env-driven seed that creates the first user if none exist, then
  lets them create projects. Server-side `createOrganization` with an explicit
  `userId` is **UNVERIFIED** — check types.
