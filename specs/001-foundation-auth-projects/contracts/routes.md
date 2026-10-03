# Contract: Routes (UI pages and HTTP endpoints)

All pages follow the docket-ui skill: per-route `<title>` (`"<Page> · Docket"`),
landmarks, skip link, visible focus, and loading/empty/error states (FR-041).

## Access legend

- **public**: no session needed
- **auth**: a session is needed. Without one: `302 /login?next=<path>`
  (proxy does an optimistic cookie check; the page re-checks with
  `auth.api.getSession`)
- **member**: auth, plus `forProject(session, slug)` succeeds. Non-member,
  unknown slug and old slug all give the identical Next `notFound()` page
  (FR-023)

## Pages

| Path | Access | Behaviour |
|---|---|---|
| `/` | auth | Redirect to the `docket_last_project` cookie slug if the user is still a member. Otherwise to the user's earliest-joined project. Otherwise to `/p/new` (FR-018) |
| `/login` | public | Email + password form (client component → `/api/auth/sign-in/email`, D5). Generic failure message. On success, go to `next` if it is a safe relative path, else `/`. A signed-in visitor is redirected to `/` |
| `/setup` | public, only while setup is available (D13) | Name, email, password form → `completeSetup` action → signed in → `/p/new`. Once unavailable: redirect to `/login` (Story 1 #3) |
| `/signup?token=…` | public | Resolves the token (D6). Shows one of: (a) **invalid**: "This invitation is no longer valid. Ask the person who invited you for a new one." (b) **unknown email, signed out**: project name, role, inviter, email shown read-only, then name + password → `signUpWithInvitation`. (c) **existing account, signed out**: "Log in to accept" → `/login?next=/signup?token=…` (d) **signed in, email matches**: Accept / Decline → `acceptInvitationByToken` / `declineInvitationByToken`. (e) **signed in, different email**: "This invitation is for another email address", with a Sign out action. Always sends `Referrer-Policy: no-referrer` |
| `/invitations` | auth | List of the user's pending, unexpired invitations (project, role, inviter, expiry) with Accept / Decline. Empty state: "You have no pending invitations." |
| `/p/new` | auth | Create project form (name, slug, time zone pre-filled from the browser, D17) → `createProject` → `/p/<slug>` |
| `/p/[projectSlug]` | member | App shell + project home (project name and time zone, links into Settings) |
| `/p/[projectSlug]/[section]` | member | `section ∈ {calendar, posts, compose, generate, jobs, review, media, accounts, voice}` → placeholder "‹Screen› is coming in a later release." Any other section → `notFound()` (FR-020) |
| `/p/[projectSlug]/settings` | member | Project settings form. Editable for owner/admin, read-only (disabled fields + note) for editor (FR-016). The auto-approve option is labelled "Auto-approve: generated posts skip review" (Story 5 #4) |
| `/p/[projectSlug]/settings/members` | member | Members table (name, email, role, joined) for all roles. Invitations table (status, role, inviter, expiry) and invite form for owner/admin. Recent membership activity (audit, newest first, last 50) for owner/admin. Actions appear by permission (FR-031); destructive ones confirm in a dialog naming the person |

### App shell (`/p/[projectSlug]/layout.tsx`)

- Top bar: **project switcher** (button showing the current project name;
  `Ctrl+K`/`⌘+K` opens it from anywhere on project pages), an invitations
  link with a pending-count badge (hidden when 0), and a user menu with
  Sign out.
- Left `<nav>`: Calendar, Posts, Compose, Generate, Jobs, Review, Media,
  Accounts, Voice, Settings (`aria-current="page"` on the active entry).
- The scheduler-health indicator is **not** in this feature (spec
  assumptions).

### Project switcher (client component, FR-019)

- `role="combobox"` input with `aria-expanded` and `aria-controls` pointing
  to a `role="listbox"`; options are `role="option"` with
  `aria-selected`.
- It opens in a modal dialog with focus in the filter input. Typing filters
  case-insensitively on name and slug. ↑/↓ move the highlight (wrapping),
  Enter opens the highlighted project, Escape closes and returns focus to
  the element that had it before.
- Its items are the user's projects (server-provided, `listMyProjects`) plus
  a final "Create project" option → `/p/new`.
- Navigating to `/p/<slug>` updates `docket_last_project` (set by the proxy).
- The keyboard listener ignores `Ctrl/⌘+K` when the event is already
  handled (`defaultPrevented`) and calls `preventDefault()` itself.

## Cookies

| Name | Set by | Value | Attributes |
|---|---|---|---|
| Better Auth session cookies | Better Auth | opaque | Better Auth defaults (HttpOnly, SameSite=Lax, Secure when `BETTER_AUTH_URL` is https) |
| `docket_last_project` | `src/proxy.ts` on `/p/<slug>` and `/p/<slug>/…` (not `/p/new`) | slug | `Path=/`, `SameSite=Lax`, `HttpOnly`, 1 year |

## HTTP endpoints

| Method + path | Access | Contract |
|---|---|---|
| `* /api/auth/[...all]` | Better Auth | `toNextJsHandler(auth)` (F11). Docket relies on: `POST /api/auth/sign-in/email` (rate-limited 3 per 10 s per IP, F5; generic `INVALID_EMAIL_OR_PASSWORD`), `POST /api/auth/sign-out`, `GET /api/auth/get-session` |
| `POST /api/auth/sign-up/email` | — | **Always `400`** `{ "message": "Sign-up requires an invitation" }`. Creates nothing (D2, FR-011) |
| `* /api/auth/organization/*` | — | **Always `404`** (D2) |
| `GET /api/health` | public | `200 {"ok":true}` when `select 1` succeeds through the DAL, else `503 {"ok":false}`. Says nothing about configuration or data. Used by the quickstart and the smoke test |

## Response semantics for project-scoped requests

- Page request by a non-member or for an unknown/renamed slug:
  `notFound()`, the same markup and status (404) in both cases.
- Server action by a non-member: `{ ok: false, error: "not_found" }`,
  nothing changed. The client shows "This project is not available" with a
  link to `/`.
- Server action without permission: `{ ok: false, error: "forbidden" }`,
  nothing changed (Story 4 #7).
