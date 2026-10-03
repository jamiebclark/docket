# Contract: Server actions and services

Server actions (`"use server"`, colocated `actions.ts` next to the route)
are thin. Each one: get the session, parse input with the shared Zod schema,
call one service function in `src/server/services/`, map the result to the UI
result type, and `revalidatePath`/`redirect` as needed. **Services hold all
rules and are what tests call.** Later callers (jobs, the public API) reuse
the same services (constitution IV).

## Result type (docket-ui)

```ts
type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ErrorCode; message: string; fieldErrors?: Record<string, string> };

type ErrorCode =
  | "validation"        // fieldErrors populated
  | "not_found"         // not a member / no such project / invitation gone (FR-023)
  | "forbidden"         // member without permission (FR-022)
  | "last_owner"        // FR-024; message suggests transferring ownership first
  | "conflict"          // slug taken, duplicate pending invite, already a member
  | "invitation_invalid"// used / revoked / regenerated / expired / unknown token
  | "email_mismatch"    // signed-in email ≠ invitation email
  | "setup_unavailable" // an account already exists
  | "unauthenticated";
```

Messages are fixed, plain-language strings. They never contain tokens,
emails other than the invitation's, or internal errors.

## Actions

Every service runs in one DB transaction. The ones marked **🔒** lock the
project row first (D12). The ones marked **📝** write a `membership_audit_log`
row in the same transaction.

| Action → service | Input (Zod) | Who | Effect / errors |
|---|---|---|---|
| `completeSetup` → `setup.createFirstUser` | `{ name, email, password }` | public, only while setup is available | Inserts `install_state`, `user`, `account` (D4, D13), then signs in. Errors: `setup_unavailable` (also for the loser of a race), `validation` |
| `signOut` | — | auth | `auth.api.signOut({ headers })` → `/login` |
| `createProject` → `projects.create` | `{ name, slug, timezone }` | any signed-in user | Inserts `organization`, `projects` (same id, defaults `review_required`/`leave_as_draft`) and `member(owner)` → redirect `/p/<slug>`. Errors: `validation` (field-level slug/timezone/name), `conflict` on `slug` |
| `updateProjectSettings` → `projects.updateSettings` | `{ slug(current), name, newSlug, timezone, defaultApprovalPolicy, defaultSchedulingPolicy }` | `project:update` | Updates `projects` + mirrors to `organization`. If the slug changed, redirect to `/p/<newSlug>/settings`. Errors: `forbidden`, `validation`, `conflict` |
| `inviteMember` 🔒📝 → `invitations.create` | `{ slug, email, role }` | `invitation:create` (+`create_owner` for role owner) | Inserts `invitation(pending, expires_at)` and `invitation_tokens`, then `InvitationDelivery.deliver`. Returns `{ invitationId, delivery: { kind: "in_app" } \| { kind: "manual_link", url, expiresAt } }`. **The URL appears only in this response** (FR-026). Errors: `conflict` (already a member, or a pending invite exists → "Regenerate the existing invitation instead"), `forbidden` |
| `regenerateInvitation` 🔒📝 → `invitations.regenerate` | `{ slug, invitationId }` | `invitation:regenerate` (+`create_owner` if role owner) | Only `pending` (incl. expired). Revokes the active token, inserts a new one, resets `expires_at`. Returns the same delivery shape. Errors: `not_found`, `forbidden`, `conflict` (not pending) |
| `revokeInvitation` 🔒📝 → `invitations.revoke` | `{ slug, invitationId }` | `invitation:revoke` (admins can't revoke owner-role invitations) | `status='canceled'`, tokens revoked |
| `acceptInvitation` 🔒📝 → `invitations.acceptById` | `{ invitationId }` | auth; email must match | `/invitations` page. Pending + unexpired → `member(role)`, `status='accepted'`, tokens used/revoked → redirect `/p/<slug>`. Errors: `invitation_invalid`, `email_mismatch`, `conflict` (already a member) |
| `declineInvitation` 🔒📝 → `invitations.declineById` | `{ invitationId }` | auth; email must match | `status='rejected'`, tokens closed |
| `acceptInvitationByToken` / `declineInvitationByToken` 🔒📝 | `{ token }` | auth; email must match | Same as the two above, but claims the token with the conditional UPDATE (D6) |
| `signUpWithInvitation` 🔒📝 → `invitations.signUp` | `{ token, name, password }` (email comes from the invitation, never from input) | public | One transaction: claim token → check invitation pending/unexpired and that no `user` has that email → insert `user`, `account`, `member` → `status='accepted'` → audit `invite_accept` with `details.newAccount=true`. Then sign in and redirect `/p/<slug>`. Errors: `invitation_invalid` (any token problem, a lost race, or an email that now has an account → "log in to accept") |
| `changeMemberRole` 🔒📝 → `members.changeRole` | `{ slug, memberId, role }` | `member:update_role` (owner) | FR-024 if demoting the last owner (incl. self). No-op if the role is unchanged. Audit `{from,to}` |
| `removeMember` 🔒📝 → `members.remove` | `{ slug, memberId }` | `member:remove`; target owner needs `member:remove_owner` | Not self (use leave). FR-024. Deletes the `member` row; takes effect on the target's next request (SC-005) |
| `leaveProject` 🔒📝 → `members.leave` | `{ slug }` | any member | FR-024 for the only owner. Redirect `/` |
| `transferOwnership` 🔒📝 → `members.transferOwnership` | `{ slug, toMemberId }` | `member:transfer_ownership` (owner) | Target must be another member. Target → owner, actor → admin, in one transaction (FR-032). If the target is already an owner, only the actor is demoted (still ≥ 1 owner). Audit `{ fromUserId, toUserId, targetPreviousRole }` |

## Read-side service functions used by pages

| Function | Scope | Returns |
|---|---|---|
| `projects.listMine(session)` | cross-project (user) | `{ slug, name }[]` ordered by name, for the switcher and `/` |
| `projects.get(scope)` | project | project settings + `canEdit` |
| `members.list(scope)` | project | members with `name, email, role, joinedAt` and per-row allowed actions |
| `invitations.listForProject(scope)` | project, `invitation:view` | invitations with shown status (D11), role, inviter name, expiry |
| `invitations.listMine(session)` | cross-project (user) | pending, unexpired invitations for the session email |
| `invitations.countMine(session)` | cross-project (user) | number for the badge |
| `invitations.resolveToken(token, session?)` | cross-project (token) | `{ state: "invalid" } \| { state: "signup", … } \| { state: "login_required", … } \| { state: "accept", … } \| { state: "email_mismatch" }`. Never reveals which reason made it invalid |
| `audit.list(scope, { limit })` | project, `audit:view` | newest first |
| `setup.isAvailable()` | system | boolean |
