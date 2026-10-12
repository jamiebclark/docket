# Contract — Routes and pages

One new page, one new route handler, one changed page. **No new API route, no public-API operation, no
webhook event type.**

---

## 1. `GET /email/unsubscribe?t=<token>` — the landing page

`src/app/email/unsubscribe/page.tsx`. **Session-less** (FR-039), `export const dynamic = "force-dynamic"`,
`export const metadata = { title: "Unsubscribe", robots: { index: false, follow: false } }`. Uses
`AuthShell`, like every other signed-out page.

**It writes nothing** (N57, FR-027). Mail clients, security scanners and corporate gateways fetch links in
mail without being asked; a GET that unsubscribes people silently unsubscribes them.

| Case | Response |
|---|---|
| a valid token | 200, the page: one clearly labelled primary submit, plus the three finer options and the state in words |
| tampered, truncated, re-signed, expired, unknown, rotated key, deleted person | 200, **the one neutral page** — same sentence, same status, nothing written (FR-029, E23) |
| no `t` parameter at all | the same neutral page |

The four submits are server actions in `src/app/email/unsubscribe/actions.ts`, each a plain `<form method="post">`
with the token in a hidden input and no client JavaScript anywhere on the page:

| Submit | Action | Writes | Then |
|---|---|---|---|
| "Stop all problem emails" (primary) | `all_off` | `cadence = 'off'` | the page re-renders saying exactly what stopped and what is still on (FR-027, FR-028) |
| "Stop only {Project}" | `project_off` | `email_project_state.excluded = true` | names the project; other projects still are emailed (US4 §4) |
| "Send one email a day instead" | `digest` | `cadence = 'digest'` at the stored hour | names the hour and the zone |
| "Turn problem emails back on" | `back_on` | `cadence = 'immediate'` | shown once email is off, so there is a way back (FR-028) |

Every action is **idempotent**: using a valid token twice succeeds and still says what the state is
(FR-029, US4 §7). Every action resolves the person's **current** memberships, so a project they have left
writes nothing and gives the neutral page without revealing that the project exists (FR-029, US4 §6).
No action touches `notification_states`, `notification_preferences` or `notification_event_marks`
(FR-030).

---

## 2. `POST /api/email/unsubscribe?t=<token>` — the mail client's one-click path

`src/app/api/email/unsubscribe/route.ts`. `export const runtime = "nodejs"`,
`export const dynamic = "force-dynamic"`. **POST only** — a GET on this path is 405, because the page above
is the human-facing target.

- No session, no CSRF token, no body requirement. The grant is the token in the query string; the body is
  read and **ignored entirely**.
- A valid token → `cadence = 'off'` immediately, with no page (FR-027, US4 §8). `204 No Content`.
- Any refusal → also `204 No Content`, having written nothing: a mail client has no user to show a
  difference to, and a different status code would be a probe (FR-029, E23).
- No response body in either case, so nothing can leak.

**`NEEDS RESEARCH: SMTP`** — the header name or names that point a mail client at this route, the header
that declares one-click support, and the exact body such a client posts are all deferred to
`docs/research/smtp.md` (FR-026, E21). This route is written to act on the query-string token and ignore
the body, so whatever that research says the client sends, the route already handles it; the task that
writes the research adds the header lines to `MailMessage.headers` and asserts the names it found.

---

## 3. `/notifications` — the changed page

`src/app/notifications/page.tsx`, unchanged in route, auth and everything it renders today. It gains one
`Card` between the problems list and the per-project preference grid (FR-037); see
[ui.md](./ui.md) §1.

Two new server actions in the existing `src/app/notifications/actions.ts`:

```ts
export async function saveEmailSettings(formData: FormData): Promise<void>;  // redirects with ?email=saved
export async function resumeEmail(formData: FormData): Promise<void>;       // redirects with ?email=resumed
```

Both follow the file's existing shape: resolve the session or `redirect("/login?next=/notifications")`,
call the service, `revalidatePath("/notifications")`, then `redirect` with a confirmation code the page
parses with a pure function (043's Q20 shape). An unparseable code renders a generic confirmation rather
than erroring.

The existing count and panel routes — `GET /api/me/notifications` and
`GET /api/me/notifications/recent` — are **not touched**: not a field, not a meaning. Email changes what
leaves the building, never what the bell counts (FR-009, N46).

---

## 4. What is deliberately absent

| Not added | Why |
|---|---|
| any public-API operation for email settings or the delivery log | FR-035 and US8 §7 say there is none; adding nothing is the cheapest way to have nothing to protect (E31) |
| a `GET /api/me/email` or similar session route | the page renders server-side; a route would be a second caller of the same service for no gain |
| a webhook event type for a sent or failed email | webhooks remain the automation path for *project* events (`docs/n8n.md`); a person's inbox is not one |
| an operator or administrator view of anyone's delivery log | FR-035, N63: a person sees their own outcome and nobody else's |
| an inbound route of any kind (bounces, delivery reports, replies) | out of scope, N62: Docket receives no mail, and the docs say so plainly |
| a route that sends a test email | no requirement asks for one, and it would be a way to make Docket mail an arbitrary address |

---

## 5. Authorization, in one table

| Path | Who | How it is enforced |
|---|---|---|
| `/notifications` email card (read) | the session's own person, any member role | the page resolves `getSession()` and passes it to `myEmailSettings(session)`, which takes no user id (FR-010, FR-044) |
| `saveEmailSettings`, `resumeEmail` | the session's own person | same; no code path accepts a user id from input |
| an API key instead of a session | refused | both are server actions on a session-only page; there is no API surface to present a key to (US8 §7) |
| another person's settings | unreachable | there is no parameter that could name one |
| `/email/unsubscribe` (GET and the four submits) | whoever holds the token | the user id comes out of the decrypted ciphertext, never from input; a bad token is one neutral page (FR-029) |
| `POST /api/email/unsubscribe` | whoever holds the token | as above; `204` either way |
| the per-project submit naming a foreign or non-existent project | refused identically | the person's own project set is resolved first, so both give the same answer (FR-044, N41) |
| the tick's cross-project reads | the scheduler | inside `runCrossProject("scheduler: …")`, every statement pinned to one project id resolved from that person's `member` rows, joining `member` in the same statement (FR-043) |
