# Quickstart & validation guide: Foundation

This guide shows the feature works end to end. Every scenario lists the
commands to run and the expected result. Behaviour details are in
[contracts/](./contracts/) and [data-model.md](./data-model.md). They are
not repeated here.

## Prerequisites

- Node 24 (`.nvmrc`), `corepack enable` (pnpm), Docker with Compose v2.
- Behind a TLS-intercepting proxy, build the image with the CA secret first
  (README, decision 12): `docker build --secret id=extra_ca,src=/tmp/extra-ca.pem -t docket:local .`
  Compose then reuses the `docket:local` image.

## 1. Automated gates (FR-038, FR-039)

```sh
pnpm install
docker compose up -d postgres                       # local Postgres 17
export DATABASE_URL=postgres://docket:docket@localhost:5432/docket_test   # name must end in _test
pnpm lint && pnpm typecheck && pnpm db:check && pnpm test && pnpm build
```

Expected: all five pass. The test run creates `docket_test` if it's
missing, resets and migrates it, and ends with a scope summary (number of
checked queries, number of `crossProject` queries by reason). There must be
no unscoped-query failures.

The suite must include, and pass, tests for:

| Area | Spec | Where |
|---|---|---|
| Env validation lists every bad variable and never prints values | FR-001, SC-002 | `src/server/env.test.ts` |
| Encryption round trip / tamper / wrong key / unknown version / no leakage | FR-007 | `src/server/crypto/secrets.test.ts` |
| Slug, time zone, password and email rules | D17 | `src/lib/validation/*.test.ts` |
| Server-side role enforcement for every action in FR-021 (editor and admin attempts refused, nothing changed) | Story 4 #7 | `tests/integration/permissions.test.ts` |
| Removed member's next request → not found (page resolver and action) | SC-005 | `tests/integration/members.test.ts` |
| Last owner can't be removed, demoted or leave, incl. two owners demoting each other at once | FR-024, SC-006 | `tests/integration/members.test.ts` |
| Expired, revoked, regenerated-away and used tokens fail. A double submit gives exactly one success | FR-026 | `tests/integration/invitations.test.ts` |
| `POST /api/auth/sign-up/email` → 400 and no user. `/api/auth/organization/*` → 404 | FR-011, SC-004 | `tests/integration/auth-endpoints.test.ts` |
| Sign-in rate limit: the 4th attempt within 10 s → 429 | FR-009 | `tests/integration/auth-endpoints.test.ts` |
| Setup/bootstrap: only while empty, concurrent attempts → exactly one, env bootstrap ignored when accounts exist | FR-012 | `tests/integration/bootstrap.test.ts` (throwaway DB) |
| An audit row for every membership change | FR-033, SC-010 | `tests/integration/audit.test.ts` |
| Scope check fails on a deliberately unscoped query. Registry covers every schema table | FR-036, SC-008 | `tests/integration/scope-check.test.ts`, `src/server/db/project-owned.test.ts` |
| Lint rejects a raw db import outside the DAL | FR-035 | `tests/lint/db-import.test.ts` |
| No plaintext token, password or key in DB rows, audit details or captured logs after the flows | SC-009 | `tests/integration/no-plaintext.test.ts` |

## 2. One-command stack (Story 1, FR-006, SC-001)

```sh
cp .env.example .env
# fill BETTER_AUTH_SECRET and CREDENTIALS_ENCRYPTION_KEY with: openssl rand -base64 32
docker compose up --build
curl -fsS http://localhost:3000/api/health          # → {"ok":true}
```

Expected: `postgres` becomes healthy, then `web` logs migrations applied and
starts. <http://localhost:3000> redirects to `/setup` (no bootstrap vars set).

- **Setup**: create an account (password ≥ 12 chars). You land signed in on
  `/p/new`. Revisit `/setup`: you're redirected to `/login`.
- **Sign out / in**: use the user menu to sign out. `/p/...` now requires login.
  Log back in.
- **Bootstrap variant**: `docker compose down -v`, set `BOOTSTRAP_ADMIN_EMAIL`
  and `BOOTSTRAP_ADMIN_PASSWORD` in `.env`, then `docker compose up`. The log says
  the bootstrap account was created, `/setup` is never offered, and logging
  in with those credentials works. Restart: the log says bootstrap was skipped.
- **Config failure (SC-002)**: blank `CREDENTIALS_ENCRYPTION_KEY` in `.env`, then
  `docker compose up web`. Within 5 s, `web` exits 1 with a message naming
  `CREDENTIALS_ENCRYPTION_KEY`, and no secret values appear in the output.
  Restore the value.
- **Migration failure (FR-004)**: point `DATABASE_URL_DIRECT` at an
  unreachable host. `web` exits before listening, so `curl` fails.

## 3. Projects and switching (Story 2, SC-007)

1. On `/p/new`, try slug `Settings`, then `ab`, then `new`: each gives a
   field error. Try time zone `+02:00`: field error. Create "Alpha"
   (`alpha`, `Europe/London`) and "Beta" (`beta`, browser default).
2. On `/p/beta`, press `Ctrl+K` / `⌘+K`, type `alp`, press Enter: you land
   on `/p/alpha` (≤ 4 keystrokes after the shortcut, visible in < 2 s).
   Escape closes the switcher and returns focus.
3. Visit each left-nav entry: a placeholder for each unbuilt screen,
   Settings works.
4. Close the browser, reopen `/`: you land on `/p/alpha`.

## 4. Invitations (Story 3, SC-003, SC-004)

1. As owner of `alpha`, open Settings → Members, invite `new@example.com`
   as editor. A link is shown once with its expiry. Copy it. Reload: the
   link is gone and the invitation is listed as Pending.
2. In a private window, open the link: you see project, role and inviter,
   with the email fixed. Submit a name and password: you are signed in on
   `/p/alpha` as editor.
3. Open the same link again: "no longer valid".
4. Invite a second address, revoke it, open its link: "no longer valid".
   Invite a third, regenerate it: the old link is invalid and the new one
   works.
5. `curl -i -X POST localhost:3000/api/auth/sign-up/email -H 'content-type: application/json' -d '{"email":"x@example.com","password":"aaaaaaaaaaaa","name":"x"}'`:
   `400`, and the user can't log in.
6. Invite the editor's email to `beta`. Signed in as the editor, the badge
   shows 1 and `/invitations` lists it. Accept: `beta` is in the switcher.

## 5. Members and isolation (Story 4, Story 6)

1. With owner, admin and editor in `alpha`, try each action as each role
   (UI and a replayed server-action request). The outcomes match FR-021, and
   refused attempts change nothing.
2. Open `/p/alpha` as the editor in tab A. As owner, remove the editor. In
   tab A, click any nav entry: you get not found, and `alpha` is gone from
   the switcher.
3. As the only owner, try to leave or demote yourself: refused with the
   "transfer ownership first" message. Transfer to the admin: they become
   owner and you become admin.
4. As owner/admin, check the activity list shows each action above, newest
   first.
5. As a user who isn't a member, open `/p/alpha` and then `/p/does-not-exist`:
   the same not-found page.

## 6. Settings (Story 5)

As owner, change the name, time zone and both policies, then reload: they
persist. Change the slug to `alpha-2`: you're redirected and the switcher
shows the new slug. `/p/alpha` is now not found. As editor, the fields are
read-only, and a replayed save returns `forbidden`.

## 7. Neon (SC-011)

Only if a Neon database is available:

```sh
docker run --rm -p 3000:3000 --env-file .env \
  -e DATABASE_URL='postgres://…-pooler…/neondb?sslmode=require' \
  -e DATABASE_URL_DIRECT='postgres://…/neondb?sslmode=require' \
  docket:local
curl -fsS http://localhost:3000/api/health
```

Repeat section 2's setup check. If no Neon database is available, report
SC-011's Neon half as **not verified** (principle II). Don't claim it.
