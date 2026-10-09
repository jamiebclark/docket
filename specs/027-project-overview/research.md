# Research: Project overview and getting started

All facts below were read from the current code (2026-10-09) or the installed packages' own docs
(`node_modules/next/dist/docs/`, Next 16.3.8). Nothing here comes from memory, and no external source was needed:
this entry adds no platform calls and no dependency. Nothing is left as NEEDS CLARIFICATION or NEEDS RESEARCH.

## R1. Where the overview's data comes from

**Decision**: One new read-only service, `getOverview(scope)` in `src/server/services/overview.ts`. It only calls
existing service functions, collects plain facts, and leaves every rule (step states, copy choices, who sees what) to a
pure module, `src/lib/overview/derive.ts`.

| Fact | Existing call | Permission it checks | Notes |
|---|---|---|---|
| Accounts (status, `providerAvailable`, `credentialsExpireAt`, names) | `accounts.listAccounts(scope)` | `account: view` (all roles) | Sorted by creation, as on Accounts |
| Slots per account | `slots.listSlots(scope, accountId)`, once per account | `slot: view` (all roles) | The audit's per-account loop; no project-wide count exists (`accounts/page.tsx:85` does the same) |
| Post counts by status | `listPosts(scope, { status: "scheduled" }).counts` | `post: view` | `counts` covers every `post_status` plus `needs_decision` (`dal/posts.ts:155-170`) |
| Coming up | the same call's `items.slice(0, 5)` | — | `scope.posts.list` orders by soonest next scheduled target, `NULLS LAST`, then newest (`dal/posts.ts:111`). `relevantAt` is the next scheduled time; `targets[].accountName` gives the names |
| Awaiting review | `countReviewQueue(scope)` | returns 0 without `post: view` | The function the nav badge uses (`layout.tsx:38`) |
| Needs your decision | `countNeedsDecision(scope)` | returns 0 without `post: view` | Counts ambiguous **targets**, as the Failures nav badge does (`layout.tsx:39`). FR-033 needs the same number, so `counts.needs_decision` (posts) is not used |
| Failed | `counts.failed + counts.partially_failed` | — | See R8 |
| AI generation configured | `getLlmStatus().configured` | none (server config) | `src/server/llm/index.ts:20` |
| Voice profiles | `voice.listVoiceProfiles(scope)` (non-archived by default) | `voice: view` | Called only when AI is configured |
| Storage configured | `media.mediaStatus(scope).enabled` | `media: view` | `getStorage() !== null` |
| Library total | `media.listMedia(scope, { limit: 1 }).total` | `media: view` | Called only when storage is configured. `total` counts every non-deleted item, images and videos, in any processing state, like the Media page |
| Owners and admins | `members.list(scope)` | `member: view` (all roles) | The service keeps only `name` and `role`; `email` never leaves it (FR-021) |
| Member count | the same list's length | — | |
| Pending invitations | `invitations.listForProject(scope)`, filtered to `status === "pending"` | `invitation: view` | Called only when the viewer can create invitations (owners, admins), the same viewers who see step 6 |
| Scheduler | `getSchedulerHealth(scope).state` | `project: view` | `"never"` or `"stale"` means "isn't running" |
| Platform apps | `connect.listConnectGroups(scope)` → groups with `configured === false` | `account: view` | Called only for owners with no accounts (R6). Each group carries its own `setupDoc` |
| Now | `clock.now()` | — | The DB clock, so tests can pin it; used for the 14-day expiry window |

**Rationale**: Constitution III and IV. Every read goes through `src/server/services/` and the scoped DAL; nothing
imports the database client. Keeping the rules in a pure module means most of SC-004/SC-005 is covered by fast unit
tests, and the integration tests only need to prove the service gathers the right facts.

**Alternatives considered**:
- *Calling services straight from `page.tsx`*: it spreads the rules across JSX and makes them hard to test without
  rendering.
- *A new project-wide slot-count or media-count query*: the spec excludes the slot service, and the media total is
  already returned by `listMedia`. Neither is worth new DAL surface for v1.
- *`getCalendar(scope, { view: "week" })` for Coming up*: it only covers one week and returns slots too.
  `listPosts({ status: "scheduled" })` already sorts soonest first across all time.

## R2. Showing the overview skeleton only on the home

**Fact** (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md:76-86`): a `loading.js`
wraps its segment's `page.js` and every nested layout and page below it in a `<Suspense>` boundary. It doesn't wrap the
`layout.js` in its own segment.

**Fact** (current tree): `settings/page.tsx` and `settings/members/page.tsx` have no `loading.tsx` of their own and use
`[projectSlug]/loading.tsx`. `settings/layout.tsx` is async (it calls `forProject`), so the outer boundary shows while
the Settings layout renders. Adding `settings/loading.tsx` alone wouldn't stop the overview skeleton flashing there.
Every other project route has its own `loading.tsx`.

**Decision**: Move the home into a route group, `src/app/p/[projectSlug]/(overview)/page.tsx`, with the overview
skeleton in `(overview)/loading.tsx`. `[projectSlug]/loading.tsx` stays as the generic loading state, unchanged, so
Settings and any future route without its own state keep it (FR-047).

**Fact** (`route-groups.md`): a group folder isn't part of the URL. Only clashing paths and multiple root layouts are
caveats, and neither applies here. `/p/{slug}` still resolves to the home. `[projectSlug]/error.tsx` and
`not-found.tsx` still cover it, because they sit in a parent segment.

**Alternatives considered**:
- *Overview skeleton in `[projectSlug]/loading.tsx` plus a generic `settings/loading.tsx`*: rejected for the async
  layout reason above.
- *A `<Suspense>` boundary inside the home page*: the page body is one server render, so the boundary would add
  nothing over `loading.tsx` and goes against the docket-ui rule "loading = loading.tsx".

## R3. Tab title

**Fact** (`src/app/layout.tsx:30`): the root title template is `"%s · Docket"`. **Fact** (`generate-metadata.md:241-287`):
a template applies to titles set in child segments, which includes the home page.

**Decision**: `generateMetadata` resolves the scope with `forProject(await getSession(), projectSlug)` and returns
`{ title: scope.project.name }`. With no session, or on `NotFoundError`, it returns `{}`. The layout already redirects
or 404s in those cases, and the slug is never used as a fallback title. `getSession` is React-`cache`d
(`src/server/auth/session.ts:2`), so this only adds the membership lookup.

## R4. Overview in the nav without breaking the pinned tests

**Facts**: `tests/integration/failures/nav.test.ts` checks positions relative to `NAV_SECTIONS` (Failures directly
after Review, Activity directly after Failures) and the strings "Failures (2)" and ">Failures<".
`review/review.test.tsx:142-143` checks ">Review (3)<". Active matching is
`pathname === href || pathname.startsWith(href + "/")` (`LeftNav.tsx:59-60`).

**Decision**: Overview isn't added to `NAV_SECTIONS`. `LeftNav` renders it as one separate item before the groups, with
no group label, href `/p/{slug}`, and active only when `pathname === "/p/{slug}"` or `"/p/{slug}/"`. The rule is
exported as a pure `isNavItemActive(pathname, href, exact)` so the three FR-051 paths can be tested directly. The
existing tests then pass unchanged (SC-007), and entry 3 can still restructure the groups. Icon: a new `overview`
icon mapped to Lucide `layout-dashboard`, added the documented way (`scripts/generate-icons.mjs` + `pnpm icons`).
`lucide-static` is already installed, so no new dependency.

**Alternatives considered**: *an `exact` flag on a `NAV_SECTIONS` entry with an empty slug*. It shifts every index,
gives the strip and sidebar a groupless item to special-case anyway, and touches the array entry 3 owns.

## R5. The slot-section link target

**Fact**: the Accounts page anchors each account card at `id="account-{id}"` (`accounts/page.tsx:109`) with
`scroll-mt-[calc(var(--sticky-top)+1rem)]`. The "Posting slots" heading (`:188`) has no id.

**Decision**: Add `id="account-{id}-slots"` and the same `scroll-mt` class to that heading. Step 2's action, the
Accounts section's slot text, and "No posting slots — add some" link to `/p/{slug}/accounts#account-{id}-slots`.
Reconnect and expiry items link to `#account-{id}`, as `ReauthBanner` already does. This is the only change to the
Accounts page; its restructure belongs to entry 4.

## R6. Server-setup row: items and links

**Facts**: `docsUrl(page, anchor)` (`src/lib/docs.ts`). `tests/integration/docs/published-docs.test.ts` fails if any
`docsUrl("page", "anchor")` call names a missing page or heading, using GitHub-style slugs. Headings in the docs:
`deployment.md:237` "## 9. Is the scheduler running?" → `9-is-the-scheduler-running`; `generator.md:5`
"## Configuring a provider" → `configuring-a-provider`; `storage.md:1` is the page itself. Connect groups declare
`setupDoc` already built with `docsUrl` (Meta and Threads → `meta-setup`, X → `x-setup`, TikTok → its `SETUP`
constant). Bluesky has no connect group and needs no server setup.

**Decision**, items in this order, each with plain words and one link:

| Item | Shown when | Label | Link |
|---|---|---|---|
| scheduler | `health.state` is `never` or `stale` | "The scheduler isn't running" | `docsUrl("deployment", "9-is-the-scheduler-running")` |
| ai | `!getLlmStatus().configured` | "AI generation isn't set up" | `docsUrl("generator", "configuring-a-provider")` |
| storage | `!mediaStatus.enabled` | "Media storage isn't set up" | `docsUrl("storage")` |
| platform:{groupKey} | no accounts, and the group isn't configured | "{group displayName} isn't set up" | `group.setupDoc`, falling back to `docsUrl("accounts")` |

The literal `docsUrl(...)` calls are kept in source so the published-docs test checks them. The row is shown only when
`scope.membership.role === "owner"` and at least one item applies. It never shows a variable name, a command, the
redirect address or a value. `ConnectGroupView.redirectUri` and `paste` are dropped in the service.

**Why "owner" by role, not by permission**: no permission statement singles out owners for server matters. The spec
and roadmap say owners only, and admins are excluded on purpose (spec Assumptions). Being an owner is a role, so the
role is checked, on the server, in the service.

## R7. Who is named, and how

**Decision**: `joinNames(names, conjunction)` in the pure module. Blank and whitespace-only names are dropped. Owners
come first, then admins, each in member-list order (by join time). The results are:

- 0 names: "an owner or admin"
- 1: "A"
- 2: "A {and|or} B"
- 3: "A, B {and|or} C"
- 4 or more: "A, B, C {and|or} n others" ("1 other" when n is 1)

"Waiting on {names}" uses **and** (US2-1: "Waiting on Robin and Sam"). "Ask {names} to …" uses **or** (US2-3: "Ask
Robin or Sam to connect one."). The spec's two examples use different conjunctions, and both read correctly in their
sentences, so the function takes the conjunction as a parameter. Emails are never read past the service.

## R8. Judgement calls the spec leaves open (go to `docs/decisions.md`)

- **D1 — Step 1 counts any account that isn't removed**, including one needing reconnecting or from an unregistered
  provider (the spec's edge case). Reconnecting is a Needs attention item, not a setup step.
- **D2 — Step 2 counts only slots on accounts whose provider is available.** Its action goes to the first such
  account, in list order, without an active slot. If every account is unavailable, it goes to the first account.
- **D3 — First post**: any post whose status is `scheduled`, `publishing`, `published` or `partially_failed`. The
  enum has no "partially published" value, and `partially_failed` means some targets published.
- **D4 — Failed = `failed` + `partially_failed`** (spec Assumptions). A partially failed post therefore counts both as
  a first post (some of it went out) and under Needs attention (part of it didn't). Both are true.
- **D5 — Expiry and reconnect don't both appear for one account.** An account that needs reconnecting is listed once,
  as a reconnect item, even if its credentials have also expired. Otherwise an expiry item is shown when
  `credentialsExpireAt <= now + 14 days`. Its copy is "Credentials expired {time}" in the past and "Credentials
  expire {time}" otherwise.
- **D6 — Accounts status badge precedence**: "Unavailable" (neutral) when the provider isn't registered. Otherwise
  "Needs reconnecting" (danger) or "Connected" (success), with the same labels and tones as Accounts.
- **D7 — The collapsed checklist is a native `<details>`/`<summary>`.** The summary reads "Setup complete". Opened,
  it shows the unfinished optional steps and the owner's server-setup row. It stays first on the page (FR-015 only
  needs that while a required step is open, and one line costs nothing).
- **D8 — Settings keeps the existing generic "Loading…" line** (`[projectSlug]/loading.tsx`, unchanged), per R2.
  Entry 2 can replace it.
- **D9 — Invite step**: shown only when `scope.can({ invitation: ["create"] })` (owners, admins). Done when the
  members list has more than one member or a pending invitation exists (spec Assumptions).
- **D10 — Platform item only while there are no accounts** (spec Assumptions).
- **D11 — Media "Upload images or videos" action** is shown to every role that has `media: edit`, which today is all
  three. It isn't a manage-only action.
- **D12 — Accounts page anchor** `#account-{id}-slots` (R5), the only Accounts page change.

## R9. Testing approach

**Facts**: Vitest runs on a real Postgres (one clone per worker). Page tests render async server pages with
`renderToStaticMarkup(await Page({ params }))` after mocking `@/server/auth/session`, `next/navigation`, `next/cache`
and `server-only` through `tests/helpers/actions.ts`, and set the user with `actAs`. `ProblemsCallout` is async and
can't be rendered by `renderToStaticMarkup`, so page tests mock it (`review.test.tsx:7-8`). The seams are
`setLlmForTests` (`llm/index.ts:46`), `setStorageForTests` (`storage/index.ts:27`), `writeHeartbeat`
(`dal/heartbeats.ts:11`) and `tests/helpers/posts-env.ts` (a project with an owner, admin and editor, plus mock
accounts with an optional Monday 09:00 slot).

**Decision**: There are three layers.

1. Pure unit tests of `derive.ts` cover every step state, the role variants, `joinNames`, the server-setup items,
   Needs attention and the collapse rules (SC-005).
2. Integration tests of `getOverview` with seeded data cover the facts, removal and re-expansion (FR-017), and the
   absence of emails.
3. Markup tests of the page, the sections, `Checklist`, `LeftNav` (with a pathname mock that can be changed per test)
   and the loading files. These run for owner and editor, with sections empty and populated (SC-004), and include
   the title test (SC-008) and the no-email / no-env-name / no-command sweep (SC-003).

The 390 px check (SC-009) is a browser walk-through in `quickstart.md`, as earlier entries did. It isn't automated.
