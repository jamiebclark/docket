# Implementation Plan: Pinterest provider

**Branch**: `072-pinterest-provider` | **Date**: 2026-10-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/072-pinterest-provider/spec.md`

## Summary

Pinterest becomes an eighth provider in `src/providers/pinterest/`, registered with one line in
`src/providers/registry.ts`. It connects through a new OAuth group — authorization code, HTTP Basic token
exchange, no PKCE — identifies the account from `GET /v5/user_account`, and publishes a single image Pin in
**one** request, `POST /v5/pins` with `media_source.image_url`, which needs no upload step, no polling and
no domain verification. The post's text becomes the pin's `description`; the pin's `title` and `link` are
per-target fields; the **board is a required per-target choice**, read live from `GET /v5/boards`.

This is the first provider that needs almost nothing new from the framework. G25 (posting fields), G26
(account details) and G13 (`accountNotes` with `now`) already exist from 026, `post_targets.posting_fields`
already exists, and `MediaItem.url` is already a public address Instagram hands to Meta. **There is no
migration, no new column, no new service and no engine, scheduler or gate edit.**

One generic hook and two corrections go with it:

- **G29** — a `choice` posting field may declare `labelKey`, so choosing a board also stores its **name**.
  `targetNote` receives values only and the posts list, post detail and calendar have no live board list,
  so FR-018 ("the chosen board's name beside the target's status") is otherwise unreachable.
- **G25's `notice` gains `docLabel`**, because the panel's link text is the literal string "Read how
  TikTok's audit works" — wrong for any other provider.
- **The panel's `text` counter uses the declared counting rule**, so Pinterest's title and link count code
  points, the units their refusals name.

Code facts F1–F27 and plan decisions K1–K38 are in [research.md](./research.md).

**Connect and tokens (US1; FR-002–FR-008, FR-028–FR-029).**

- **Configuration**: `PINTEREST_CLIENT_ID` and `PINTEREST_CLIENT_SECRET`, both or neither (K22). No third
  variable: FR-031 forbids guessing the access tier, and a deployer flag is a guess by proxy.
- **Connect**: `https` on a public host (U1), scopes `user_accounts:read,boards:read,pins:write` and
  nothing more (FR-004), no PKCE (U6), no paste fallback, no `continuous_refresh` (K24).
- **Identity**: the account is Pinterest's `id`, named from `business_name` or `username` (K25).
  `account_type` is read and discarded (U7).
- **Tokens**: both tokens and both expiries stored together, encrypted. The **account's** expiry is the
  refresh token's, which is what makes the scheduled refresh pass renew an idle account inside the 72-hour
  window of its 60-day refresh expiry and keep it alive indefinitely (K26). `needsRefresh` fires 24 hours
  before the 30-day access token expires; a transient refusal holds for 5 minutes (G11).
- **Rotation**: every refresh writes the whole blob at once, so a rotated refresh token can never be half
  stored. A reply with **no** refresh token leaves the stored one alone (U8).
- **Account card**: the Trial note, always, worded true on either tier; plus "Reconnect Pinterest before
  <date>" within 30 days, rendered with `formatLocal` (K32).

**The board, the title and the link (US2; FR-009–FR-021).**

- **Three text slots onto one** (FR-009, FR-010): text → `description` (800 code points); `title` (100) and
  `link` (2048) are per-target `text` fields; the media item's alt text → `alt_text` (500). An over-length
  value is **stored** and refused with its count, never silently dropped (K7). A non-empty link must be an
  absolute `http(s)` URL (K8, a Docket choice).
- **The board is required, per target** (FR-016, FR-017): a `choice` field, nothing pre-selected, options
  read live from `GET /v5/boards?privacy=PUBLIC&page_size=250`, paging `bookmark` to at most 10 pages
  (2,500 boards covers the documented 2,000 ceiling) — all inside one bounded `accountDetails` read (K20).
- **Five picker states, five distinct outcomes** (FR-019, FR-020, SC-008): loading and a failed read both
  disable the control and keep the stored choice visible as its own option; an account with no boards
  disables it with "create one on Pinterest" and refuses the target; a stored board that is gone stays
  selected, disabled and labelled, with `board_not_found`; a good list just lists (K16).
- **Outside the composer there are no live details** (F11), so `board_required` is the gate's check and
  Pinterest's own 404 is the publish-time one (K18, FR-021).
- **FR-018** is satisfied by G29: the board's name is stored beside its id and `targetNote` renders
  "Board: <name>" in the four existing views.

**Capabilities and validation (FR-011–FR-015, FR-030).**

- One image, JPEG/PNG/WebP (the three the media library can hold), 20,000,000 bytes, alt text 500, media
  required, no text-only pin, no video, `postTypes: ["image"]`, publish limit 100 per 60 s (K10).
- **No dimension or aspect bounds**: the planner *refuses* on those, which would reject a pin Pinterest
  would have accepted and merely cropped. Instead `validatePinterest` emits a **warning** outside
  `[0.5, 1.0]` that still publishes (K12, FR-014).
- Five generic messages are re-worded in Pinterest's own voice (K11) so the requirements summary reads as
  Pinterest rather than as "this account".

**Publishing (US3; FR-022–FR-027).**

- **One step**, `create_pin`, `mayPublish: true`, no state at all (K3). A lost lease is therefore
  `ambiguous` by construction — the safe side.
- **The outcome table** is contracts/pinterest-publishing.md §4. The two decisions that matter: a **5xx is
  `ambiguous`, not retryable** (with one step there is no "before the create call", and a gateway error can
  follow a request Pinterest processed — K29, a judgement call against a loose reading of FR-025); and
  outcomes are decided on **HTTP status only**, never on a numeric `code` in the body (FR-024, U2).
- **404 names the board** and is not retried (FR-021). **429** waits for `x-ratelimit-reset`, clamped to
  1 s–1 h, and falls back to the engine's backoff with no readable reset (K30).
- The pin's link is `https://www.pinterest.com/pin/<id>/`, built in one function and labelled best-effort;
  the reply's `link` field (the pin's outbound click-through URL) is never confused with it (U5, FR-027).

**Honesty about access tiers (FR-031, FR-032).** The Trial line appears in three places before anything is
scheduled — the account card, the requirements summary and the posting panel's notice — and in the setup
guide. Docket neither detects nor asserts the tier, does not pretend to enforce the shared 300-per-day cap,
and never calls a published pin publicly visible (K32, K33).

**Not built here** (spec's "What this entry does not do"), each recorded in `docs/feature-map.md`:

- video pins (a later `pinterest-video` entry) and carousel pins (a later `pinterest-carousel` entry);
- creating, renaming or deleting boards; secret and protected boards;
- pin analytics, product and rich pins, catalogs, ads, Business Access, AI-disclosure labels;
- the `api-sandbox` host; automatic Trial-versus-Standard detection; enforcing the shared Trial daily cap;
- any live verification — registering a real app and connecting a real account are human-owned tasks,
  parked in a final phase (quickstart.md §12).

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS.

**Primary Dependencies**: all already installed; **no new runtime dependency** (constitution VI).

- **Next.js 16 / React 19.** No new route, no new server action, no new page. One existing client component
  is edited (`PostingFieldsPanel`) and one pure client helper module (`posting-ui.ts`). Before touching any
  App Router API, implement reads `node_modules/next/dist/docs/` (AGENTS.md) — resolved from the main
  checkout, since this worktree has no `node_modules` of its own (F23).
- **zod 4.** Environment parsing, credentials, posting values, board details and every Pinterest reply.
- **Drizzle ORM.** Not touched. **No migration**, so `pnpm db:check` must still pass unchanged.
- **`node:crypto`.** Not needed: there is no step state to seal (unlike TikTok's upload address).
- **Vitest 5.** A fake Pinterest (`tests/helpers/fake-pinterest.ts`) routes `api.pinterest.com`
  (`/v5/oauth/token`, `/v5/user_account`, `/v5/boards`, `/v5/pins`) and records every request with secrets
  redacted. The clock is pinned with `atTime`; UI assertions use `renderToStaticMarkup`.
- **Dev-only.** `simple-icons` and `lucide-static` through `pnpm icons`; both already installed, and
  `simple-icons` ships `pinterest.svg` (F22).

**Storage**: PostgreSQL. Nothing new.

- The account row, its encrypted credentials blob, and `post_targets.posting_fields` (added by 026) hold
  everything (data-model.md §1).
- `post_targets.step_state` stays **null** for every Pinterest target: one step, no state.
- The board list is never stored — read live and cached in process for 60 s by the existing
  `account-details.ts`.
- The image is fetched by Pinterest from the media item's existing public URL; no storage or domain work.

**Testing**: Vitest against real Postgres with run-scoped databases.

- Unit tests beside every pure Pinterest module.
- Integration tests through `runTick` and the services, **mocked HTTP only** — no test may make a live
  Pinterest call (FR-037).
- Generated suites that gain Pinterest automatically the moment it is registered:
  `tests/integration/limits/enforcement.test.ts` and `tests/integration/docs/limits-inventory.test.ts`
  (F21), so `docs/limits.md` must be written in the same task as the capabilities.
- Inertness tests for G29 and the two panel corrections.

See [quickstart.md](./quickstart.md).

**Target Platform**: self-hosted Linux containers (`web` and `worker` from one image) on Docker Compose,
Unraid or Neon. Publishing runs in `runTick`; the board read runs in the web process.

**Project Type**: web application (Next.js App Router monolith with a worker process).

**Performance Goals**:

- **One bounded step.** A publish is exactly one Pinterest call, inside
  `SCHEDULER_PROVIDER_TIMEOUT_SECONDS` (10 s by default). No chunking, no polling, no byte reads — the
  simplest step machine of any real provider Docket has.
- **The board read is the only loop,** at most 10 sequential pages of 250 under one `AbortSignal`; a
  typical account is one page. Cached 60 s per account, so the composer costs about one call a minute per
  Pinterest target.
- **Composer cost unchanged** for every other provider: the details read only happens for a provider that
  declares `accountDetails`.

**Constraints**:

- No sleeping in a tick; there is nothing to wait for, and a 429 wait is `notBefore`.
- No provider call inside a held transaction — the details read precedes the save's transaction (existing).
- The DB clock everywhere; `formatLocal` for any date in a note.
- **Never two create requests for one target**: every uncertainty after the request is sent is `ambiguous`
  and never retried automatically (FR-026, SC-004).
- Tokens and the client secret never reach `error`, `summary`, `lastError`, activity, logs, the browser or
  a snapshot. There is no `state` for them to leak into.
- No limit literal in UI code: 800, 100, 2048 and 500 reach the browser only through the declaration.
- Other providers' behaviour is unchanged, pinned by tests (G29 and `docLabel` are opt-in).

**Scale/Scope**: one new provider, one new generic hook, two corrections.

- **New provider files (15)** in `src/providers/pinterest/`: `index.ts`, `config.ts`, `http.ts`,
  `oauth.ts`, `credentials.ts`, `refresh.ts`, `account.ts`, `boards.ts`, `capabilities.ts`, `posting.ts`,
  `validate.ts`, `errors.ts`, `steps.ts`, `publish.ts`, `settings.ts`.
- **New server files: none.** **New UI files: none.** **New migrations: none.**
- **Edited files (≈ 18)**:
  - providers: `types.ts` (G29 `labelKey`, `notice.docLabel`), `registry.ts` (one line),
    `tiktok/posting.ts` (its own `docLabel`);
  - UI: `components/compose/PostingFieldsPanel.tsx`, `components/compose/posting-ui.ts`;
  - shared: `lib/docs.ts` (`DocPage` gains `pinterest-setup`);
  - build: `scripts/generate-icons.mjs` (the `pinterest` and missing `tiktok` marks, and a worktree-safe
    `pkgDir`), `src/components/ui/icons.generated.ts` (regenerated);
  - deployment: `.env.example`, `unraid/docket.xml` (two Pinterest variables, and TikTok's three that 026
    missed), `mkdocs.yml`;
  - docs: `docs/limits.md`, `docs/accounts.md`, `docs/feature-map.md`, `docs/adding-a-provider.md`,
    `docs/decisions.md`, `docs/index.md`, `README.md`.
- **New docs (1)**: `docs/pinterest-setup.md`.
- **Tests**: about 13 unit files beside the provider, 7 integration files under
  `tests/integration/pinterest/`, one composer check, one docs test, two helpers
  (`fake-pinterest.ts`, `pinterest-publish.ts`), and three extended files
  (`posting-hooks-inert.test.ts`, `posting-ui.test.ts`, the TikTok panel markup test).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How this plan meets it |
|---|---|---|
| I. Verified facts over memory | PASS | Every Pinterest fact comes from `docs/research/pinterest.md` (research.md §1 lists each one and its source). The ten UNVERIFIED items are each decided conservatively in **one named constant or function with a fallback** (research.md §2) and listed as owed live checks (quickstart.md §12). Where the spec's request and the research disagreed, the research won and the spec recorded it. No fact came from memory; no phase fetched the web. Code facts F1–F27 were read from this repository. |
| II. Nothing is "working" unless it ran | PASS | Every behaviour has a mocked-HTTP, unit or markup test (quickstart.md §1–§10). All Pinterest behaviour is reported **"verified with mocks only"** in `docs/pinterest-setup.md`, `docs/feature-map.md` and `docs/decisions.md`. No test makes a live call; the live checks are owed and parked. |
| III. Project isolation | PASS | No new table, no new query. The board read goes through `readAccountDetails`, which resolves project scope and `post:view` before anything else and reads ciphertext through the pinned scheduling repositories for that same project (F9). `src/providers/**` imports nothing from `src/server/**` (F27, pinned by the existing lint test). The provider never touches storage. |
| IV. One service layer | PASS | One validator (`validateTargetContent` → `validatePinterest`) serves the composer, the gate and the engine, so all three word a refusal identically. One details reader serves the composer. One refresh path (`refreshForPublish`) serves the composer read, the publish and the scheduled pass. One note helper (`targetNoteFor`) serves all four target views. Nothing is duplicated per caller. |
| V. Providers are plug-ins | PASS (with one justified generic hook) | All Pinterest behaviour is in `src/providers/pinterest/` plus one registry line. No scheduler, composer-logic, gate, engine or schema change. `advance` keeps its five result kinds, and the single step is the only thing that may publish. The one generic addition, **G29**, is made the way G19–G28 were: optional, inert for providers that do not declare it, pinned by an inertness test, and recorded with how to reverse it. The two corrections fix existing generic code that named TikTok (`docLabel`) or ignored a declared rule (the counter); neither adds provider-specific code. Justified under Complexity Tracking. |
| VI. Boring, few dependencies | PASS | No new package, no infrastructure, no queue, no cache server. The board cache is the existing in-process `Map`. No `node:crypto` needed. |
| VII. Secrets never leak | PASS | Credentials are encrypted at rest by the existing path and never reach the browser. `scrubPinterest` cleans every message built from a reply, drops links and control characters and truncates to 200 characters. No `code` or raw body is ever shown. There is no step state, so nothing can leak into plain jsonb. The two new variables are validated at startup through the group's own `environment` (G8) — no provider variable goes into `src/server/env.ts` — and are documented in `.env.example`. A no-secrets suite echoes every secret from the fake and asserts its absence. |
| Engineering constraints | PASS | `runTick` stays bounded: one call per publish, waits expressed as `notBefore`, no provider call in a transaction. Times are UTC on the DB clock; the one date in a note goes through `formatLocal`. The UI follows `docket-ui`: native labelled controls, `aria-describedby` for reasons and help, a disabled control rather than an empty list while loading, `role="alert"` plus Retry for a failed read, full keyboard use. "Other platforms" are out of scope "until a spec says otherwise" — **this spec says otherwise for Pinterest only**, exactly as 014 and 026 did, and the constitution is not amended. |
| Workflow | PASS | Conventional Commits with explicit paths, one commit per task or tight group. This phase writes the artifacts in `specs/072-pinterest-provider/`; the implement phase writes `docs/decisions.md` `## 072` (spec decisions, generic changes G29 + the G25 amendment, plan decisions K1–K38, hook reversal notes, implementation outcome). Checks run in proportion: targeted tests per task, then one final pass of `lint && typecheck && test && build`. `db:check` is not run — nothing changes the schema. |

**Post-design re-check (after Phase 1)**: PASS.

- **Inertness is testable.** `labelKey` and `docLabel` are optional members; a provider that declares
  neither produces the panel's current behaviour byte for byte, and `countPostingText` falls back to
  `value.length` for a custom rule that lost its function to JSON, which is exactly today's output for
  TikTok. One test pins each (contracts/generic-hooks.md).
- **No second publishing path and no engine edit.** `stepFor` has one answer, `advance` sends one request,
  and the engine's existing first-step re-validation (G15) is what makes FR-016's second board check free.
- **No schema change.** `post_targets.posting_fields` and the encrypted credentials blob carry everything;
  `step_state` stays null. `pnpm db:check` is untouched.
- **Three judgement calls against the letter of the spec**, each recorded in `docs/decisions.md`:
  - **K29** — FR-025 makes a server error "before the creating request is sent" retryable. With one step
    there is no such moment: a 5xx is a reply to the create request and is therefore `ambiguous`. Only a
    pre-send network failure (DNS, connection refused) is retryable. X decides the same way, and
    constitution V prefers a missed post to a duplicate.
  - **K18** — FR-021's "a publish whose board no longer exists fails without a retry" is enforced by
    Pinterest's 404, not by a Docket-side board check, because the gate and the engine have no live board
    list (F11) and adding one would mean a second provider call before the create call.
  - **K32** — FR-031 wants the Trial facts "where someone will see them before scheduling anything".
    Docket cannot know the tier, so the note is shown **unconditionally and worded conditionally**
    ("while this server's Pinterest app has Trial access…"), which is true on either tier. No third
    environment variable is added.
- **One scope addition, deliberate and small.** Two pre-existing gaps are fixed in passing because FR-035
  cannot be met honestly otherwise: TikTok's missing platform mark (F22) and `generate-icons.mjs`'s
  inability to resolve packages from a git worktree (F23). Both are one-line changes in the same file
  Pinterest's mark is added to; TikTok's Unraid variables (F24) are the same class of omission, in the file
  FR-035 names.

## Project Structure

### Documentation (this feature)

```text
specs/072-pinterest-provider/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0: research check, UNVERIFIED choices, code facts F1–F27, decisions K1–K38
├── data-model.md        # Phase 1: storage map, account, credentials, posting values, board details, G29, the request, limits rows
├── quickstart.md        # Phase 1: validation runs and owed live checks
├── contracts/
│   ├── pinterest-connect.md     # env, connect group, OAuth requests, refresh, HTTP plumbing, tests
│   ├── pinterest-publishing.md  # capabilities, validatePinterest, the one step and its exact request, outcomes, messages, secrets, tests
│   ├── composer-ui.md           # the board picker, the five states, the target note, accessibility, tests
│   └── generic-hooks.md         # G29 labelKey, the G25 notice docLabel, the counting-rule correction
├── checklists/
└── tasks.md             # Phase 2 (/speckit-tasks), not created here
```

### Source Code (repository root)

```text
src/
├── providers/
│   ├── types.ts                      # G29: labelKey on a choice field view; notice gains docLabel
│   ├── registry.ts                   # + pinterestProvider (one line)
│   ├── tiktok/posting.ts             # declares its own docLabel, so its rendered link text is unchanged
│   └── pinterest/                    # NEW
│       ├── index.ts                  # SocialProvider: capabilities, limit, connect, posting, accountDetails, refresh, validate, stepFor, advance, accountNotes
│       ├── config.ts                 # parsePinterestEnv, requirePinterestConfig, hosts, scopes, every constant
│       ├── http.ts                   # pinterestRequest, PinterestOutcome, rate headers, readPinterestMessage (U2), scrubPinterest
│       ├── oauth.ts                  # Basic-auth token calls: exchangeCode, refreshTokens, expiry arithmetic
│       ├── credentials.ts            # schema, accountExpiry, needsRefresh
│       ├── refresh.ts                # refreshPinterest (rotation, refusal, transient)
│       ├── account.ts                # readUserAccount → id, username, business_name
│       ├── boards.ts                 # readBoards (paged), pinterestDetailsSchema, pinterestAccountDetails (G26)
│       ├── capabilities.ts           # the declaration and PINTEREST_DEFAULT_PUBLISH_LIMIT
│       ├── posting.ts                # values schema, view (the five picker states), notice, targetNote, summaryNotes, afterPreview
│       ├── validate.ts               # validatePinterest (re-wordings + the nine Pinterest issues)
│       ├── errors.ts                 # explainPinterest (status-driven sentences)
│       ├── steps.ts                  # pinterestStepFor → create_pin, mayPublish
│       ├── publish.ts                # advancePinterest: guards, the one request, the outcome table, pinUrl
│       └── settings.ts               # z.object({}).strip() and pinterestAccountNotes (G13)
├── components/compose/
│   ├── PostingFieldsPanel.tsx        # labelKey, notice docLabel, counter uses the declared rule
│   └── posting-ui.ts                 # + countPostingText
├── components/ui/icons.generated.ts  # regenerated: + pinterest, + tiktok
└── lib/docs.ts                       # DocPage + "pinterest-setup"

scripts/generate-icons.mjs            # PROVIDERS + pinterest and tiktok; pkgDir resolves from a worktree

tests/
├── helpers/
│   ├── fake-pinterest.ts             # NEW: scripted api.pinterest.com (token, user_account, boards, pins), requests recorded with secrets redacted
│   └── pinterest-publish.ts          # NEW: account, post and target setup with posting values
└── integration/
    ├── pinterest/{connect,refresh,availability,boards,publish-e2e,failures,no-secrets}.test.ts   # NEW
    ├── compose/pinterest-check.test.ts                                                           # NEW
    ├── compose/posting-hooks-inert.test.ts                                                       # extended for G29
    └── docs/pinterest-docs.test.ts                                                               # NEW

docs/pinterest-setup.md (NEW)
docs/{limits,accounts,feature-map,adding-a-provider,decisions,index}.md; README.md; .env.example; mkdocs.yml; unraid/docket.xml
```

**Structure Decision**: the existing single Next.js app, with the provider beside its peers and no new
layer.

- **Pinterest's logic is pure where it can be**, split like X's and TikTok's folders, so the request shape,
  every validation rule, the five picker states and every outcome are unit-tested without a database.
- **The only generic edits are at hook points G19–G28 already use**: the types, the posting panel and the
  client-side helpers. Nothing in the composer, the gate, the engine or the schema names Pinterest.
- **There is no `state.ts`**, which is the point: with one request, the whole step machine is a constant.

## Implementation order (for /speckit-tasks)

1. **Worktree setup.** `pnpm install --frozen-lockfile` here, confirm `pnpm vitest run src/providers`
   passes untouched. Nothing else can run before this (F23).
2. **G29 and the two corrections.** `types.ts` (`labelKey`, `notice.docLabel`); `posting-ui.ts`
   (`countPostingText` + its test); `PostingFieldsPanel.tsx` (the second `onChange`, `docLabel`, the
   counter); `tiktok/posting.ts` gains its own `docLabel`. Then the inertness tests and the existing
   TikTok suites, which must be unchanged.
3. **Configuration, HTTP and OAuth.** `config.ts`, `http.ts`, `oauth.ts`, `credentials.ts`, `account.ts`,
   `refresh.ts` with their unit tests. `.env.example` gains the two variables.
4. **Connect group.** `connect-group.ts`; `lib/docs.ts` gains `pinterest-setup`; a stub `index.ts` whose
   `advance` fails before any call, plus the registry line. Then
   `tests/integration/pinterest/{connect,availability,refresh}.test.ts` with `fake-pinterest.ts`.
   *The registry line makes the generated limits suites fail from here on — step 5 fixes that.*
5. **Capabilities and `docs/limits.md`.** `capabilities.ts` and the new `## Pinterest` section, together,
   so `limits-inventory.test.ts` and `enforcement.test.ts` go green in the same commit (F21).
6. **Boards and account details.** `boards.ts` with paging and the ten-page cap; its unit tests and
   `tests/integration/pinterest/boards.test.ts`.
7. **Posting fields and validation.** `posting.ts` (the five picker states, `notice`, `targetNote`,
   `summaryNotes`), `settings.ts` (account notes), `validate.ts`, and their unit tests. Add the
   `note:` rows to `docs/limits.md`.
8. **Composer behaviour.** `tests/integration/compose/pinterest-check.test.ts` across all five board
   states, required-ness, the target note in the four views, and the Trial line in three places. No
   composer source change is expected here; any that proves necessary is a finding, not a licence.
9. **Publishing.** `errors.ts`, `steps.ts`, `publish.ts` and their unit tests; then
   `tests/integration/pinterest/{publish-e2e,failures}.test.ts` across the whole outcome table, and
   `no-secrets.test.ts`.
10. **The platform mark.** `scripts/generate-icons.mjs` (`pinterest`, the missing `tiktok`, the
    worktree-safe `pkgDir`), then `pnpm icons` and commit `icons.generated.ts`.
11. **Deployment surfaces.** `unraid/docket.xml` gains the two Pinterest variables and TikTok's three.
    `docker-compose*.yml` are **not** touched (F26).
12. **Docs.** `docs/pinterest-setup.md` (FR-033) and the `mkdocs.yml` nav entry; `docs/accounts.md`,
    `docs/feature-map.md` (FR-034), plus a Pinterest row in the setup tables of `docs/index.md` and
    `README.md` — the same place TikTok sits, not the lead platform sentence, which lists only the
    constitution's four plus X; `docs/adding-a-provider.md` §19 and the
    hooks-index row for G29 (FR-034); `docs/decisions.md` `## 072` with the spec decisions, the generic
    changes, K1–K38, the reversal notes and the implementation outcome (FR-036). Then
    `tests/integration/docs/pinterest-docs.test.ts` and the rest of `tests/integration/docs`.
13. **Final pass, once.** `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. Not `pnpm db:check`:
    no schema change.
14. **Parked, human-owned, last** (memory: a judgement or browser task in an early phase starves the
    implement loop). Register a real Pinterest app, request Trial access, connect a real account and work
    through the owed live checks in quickstart.md §12. Nothing in this entry depends on it, and the docs
    say so plainly.

## Operator impact

- `.env.example` gains a `--- Pinterest ---` block with `PINTEREST_CLIENT_ID=` and
  `PINTEREST_CLIENT_SECRET=`, both empty, both optional, pointing at `docs/pinterest-setup.md` and noting
  the https-public-host callback rule (FR-008, FR-035).
- `unraid/docket.xml` gains two optional, empty Pinterest fields — and the three TikTok fields 026 missed,
  so the template really does list every provider (FR-035).
- `docker-compose.yml` and `docker-compose.build.yml` do **not** change: both pass `.env` through
  `env_file`, so a deployer running a copied compose file only adds the variables to `.env` (F26).
- **No migration runs.** Nothing about the database changes.
- A deployer who sets neither variable sees Pinterest listed as not configured, with a link to the guide —
  no error, no broken screen.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Constitution V: one generic hook (G29, `labelKey`) and a panel edit for a provider | FR-018 requires the chosen board's **name** beside the target's status in the composer, the posts list, the post detail page and the calendar. `targetNote` receives values only (F12) and those three views have no live board list to resolve an id with (F11), so the name must be stored with the id — and the only thing that knows the name at choice time is the panel. | A composite `"<id>|<name>"` option value: a board renamed on Pinterest then matches no option and the picker silently falls back to the placeholder, losing the stored choice (F13) — against FR-019. A hidden `fixed` companion field: `withFixedValues` would submit it, but `fixed` renders a visible redundant read-only row. A server-side read per list row: a Pinterest call for every row of the posts list. Showing the board **id** instead of its name: unreadable, and FR-018 asks for the name. |
| `notice.docLabel` on G25, beyond what the spec asks for | The panel's notice link text is the literal "Read how TikTok's audit works" (F15). Pinterest's notice links to its own Trial section, and any future provider hits the same wall. | Omitting `doc` from Pinterest's notice and burying the URL in prose: the one place a person reads before scheduling would have no link, and the defect stays for the next provider. Hard-coding a second provider name: worse. |
| The posting counter reading the declared rule | Pinterest's title and link are `code_points`; the panel counts UTF-16 units (F16). A title with one emoji would be shown as 2 and refused as 1, or the reverse — a count that contradicts its own refusal breaks SC-005's "names the field at fault and the limit". | Declaring a custom UTF-16 rule for Pinterest to match the panel: it would make the *refusal* wrong instead, and U4 says Pinterest documents no rule, so code points is the honest default. |
| Two pre-existing gaps fixed in passing (TikTok's platform mark; `generate-icons.mjs` in a worktree) | FR-035 requires Pinterest's own mark "wherever other platform marks are shown", which means editing `PROVIDERS` and running `pnpm icons` — which cannot run in this worktree as written (F23), and which sits next to the obvious `tiktok` omission (F22). The Unraid template's missing TikTok block (F24) is the same omission in the file FR-035 names. | Leaving the generator broken for worktrees: the mark cannot be regenerated at all, so FR-035 fails. Hand-editing `icons.generated.ts`: the file says not to, and the next `pnpm icons` would revert it. Leaving TikTok out while adding Pinterest beside it: knowingly shipping a half-filled list in the same two lines. |
