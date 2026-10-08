# Implementation Plan: TikTok provider

**Branch**: `026-tiktok-provider` | **Date**: 2026-10-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/026-tiktok-provider/spec.md`

## Summary

Entry 8 of 8 in the video roadmap. TikTok becomes a seventh provider in `src/providers/tiktok/`. It connects with TikTok's web login. It publishes videos by chunked `FILE_UPLOAD`, one chunk per step, and photos by `PULL_FROM_URL`. Either way it then polls the status by `publish_id`, which becomes the external id.

TikTok's mandatory posting UI needs three generic hooks, the way G19 added the post type choice:

- **G25**, per-target posting fields;
- **G26**, live account details for the composer;
- **G27**, explicit consent per target.

Two small generic tweaks go with them:

- **G28**: `exchangeCode` receives the callback query, for TikTok's granted `scopes`;
- `accountNotes` receives `now`, for the reconnect warning.

One migration adds five nullable columns to `post_targets`. Unaudited installs (`TIKTOK_APP_AUDITED` unset) store and send `SELF_ONLY`, and show "Private on TikTok" everywhere. Code facts F1–F23 and decisions P1–P41 are in [research.md](./research.md).

**Connect and tokens (US1; FR-002–FR-006).**

- **Configuration**: `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` come together, and `TIKTOK_APP_AUDITED` defaults to false (P11).
- **Connect**: the redirect requirement is `https` on a public host. There is no PKCE and no paste fallback.
- **Granted scopes**: read from the callback's `scopes` (G28), with the token reply's `scope` as fallback (P7, P13).
- **Identity**: the account is identified by `open_id` and named from creator info (P14).
- **Tokens**: both tokens and their expiries are stored together, encrypted. The account's expiry is the refresh token's (estimated) expiry. `needsRefresh` fires 30 minutes before the access token expires. A rotated refresh token replaces the old one, and transient failures retry after 5 minutes (P15, P16).
- **Account card**: the unaudited note, the photo-domain note, and "Reconnect TikTok before <date>" within 30 days (P8).

**Posting fields and consent (US2, US6; FR-012–FR-019).**

- **G25** (P1, P9):
  - The provider declares a values schema and a pure `view()`. `view()` returns choice, toggle, text or fixed field views, with options, disabled states and reasons.
  - It also declares `targetNote()` ("Private on TikTok") and `summaryNotes()`.
  - Values are stored in `post_targets.posting_fields`. They reach `validate` and `advance` as `PostContent.posting`.
- **G26** (P2): `readAccountDetails` reads creator info on the server only. It renews credentials first through the engine's `refreshForPublish` lease, and caches answers in process for 60 seconds.
- **G27** (P3–P6):
  - The composer shows the declaration and an unticked "I agree". The tick travels with the save that every schedule path performs first.
  - The server records it only when its own fingerprint matches what the person saw. The fingerprint is a SHA-256 over the text, media ids, video edits, posting values and details shown.
  - A consent is valid only while the fingerprint still matches. The gate (queue, schedule, publish now, approval, retry) and the engine's first step refuse a target without valid consent.
  - The gate checks the creator's maximum duration against the details stored with the consent.
- **Composer**: a generic `PostingFieldsPanel` in each target's preview card (P38).
- **Status note**: "Private on TikTok" in the composer, post list, post detail and calendar (P39).

**Capabilities and validation (FR-007–FR-011).**

- **Declaration** (P18):
  - text: 2,200 UTF-16 units (custom rule `utf16`);
  - images: 1–35 JPEG or WebP, 20 MB, at most 1080 × 1920, with JPEG as the conversion target;
  - video: one MP4 or MOV, never with images; H.264, H.265, VP8 or VP9; 23–60 fps; 360–4,096 px; 4 GB; 300 s;
  - publish limit: 15 per day, approximate.
- **Adaptation**: the image planner and video formatter adapt TikTok's files from these limits alone.
- **`validateTikTok`** adds the posting-field, creator-duration and photo-`https` issues (P19, P20).

**Publishing (US3–US5; FR-020–FR-029).**

- **Steps** (P23):
  - video: `check_creator` → `start_upload` → `upload_chunk_1…N` → `check_status`;
  - photo: `check_creator` → `publish_photos` → `check_status`.
  - Only the last chunk and `publish_photos` may publish. `check_status` is after-publish (G23).
- **Creator check** (P35): re-reads creator info and fails clearly on any change against the person's choices. A posting cap waits hourly through G24 and fails at 23 hours (P29).
- **Chunks** (P24–P28, P32):
  - size: the file ÷ 30, clamped to 5,242,880–64,000,000 bytes; the final chunk absorbs the remainder;
  - each chunk is read by byte range from the stored file and sent with `Content-Range`;
  - the upload address is sealed in the state;
  - restarts (at most two) on 403, a refused repeat, an unsealable address, or an address 55 minutes old.
- **Status reads** (P30): at 15 s, then every minute until 10 minutes, then every 5 minutes, to a 60-minute ceiling that ends ambiguous.
- **Explanations** (P36): every TikTok code and fail reason gets a plain sentence.
- **Never a second publishing request** (P26, P31).

**Not built here** (FR-040–FR-043, all owned by no spec because this is the last entry):

- the audit itself;
- analytics, comments and an inbox;
- inbox (draft) upload, webhooks, and grant revocation;
- a media route on Docket's domain, and `PULL_FROM_URL` video;
- the AIGC label, cover choice and music;
- TikTok fields in the API, generator or bulk create;
- post links;
- install-wide counting against the 5-account cap;
- Terms and Privacy pages;
- a confirm-at-send flow.

Each is recorded in `docs/feature-map.md`.

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node 24 LTS.

**Primary Dependencies**: all already installed; no new runtime dependency (P41).

- **Next.js 16 / React 19.**
  - One client component is added (`PostingFieldsPanel`), and `Composer.tsx`, the posts list and detail pages, and `CalendarBoard.tsx` are edited. No new route or server action.
  - Before writing UI code, implement reads `node_modules/next/dist/docs/` for any App Router API it touches (AGENTS.md).
- **zod 4.** Env parsing, credentials, posting values, creator details, state and every TikTok reply.
- **Drizzle ORM.** Migration `0018` via `pnpm db:generate`, five nullable columns.
- **`node:crypto`.** Upload-address sealing (AES-256-GCM, HMAC-derived key) and consent fingerprints (SHA-256).
- **Vitest 5.** A fake TikTok (`tests/helpers/fake-tiktok.ts`) routes `www.tiktok.com`, `open.tiktokapis.com` and an upload host. Byte-range media comes from the existing range helper. The clock is pinned with `atTime`. UI tests use `renderToStaticMarkup`.

**Storage**: PostgreSQL.

- `post_targets` gains `posting_fields`, `consent_by_user_id`, `consent_at`, `consent_fingerprint` and `consent_details` (data-model §1).
- Publish progress is JSON in the existing `step_state` (data-model §6), with the upload address sealed.
- Video bytes are read by HTTP range from the public bucket (P32).
- Creator details are cached in process, never stored except as `consent_details`.

**Testing**: Vitest against real Postgres with run-scoped databases.

- Unit tests for every pure TikTok module.
- Integration tests through `runTick` and the services, with mocked HTTP only.
- UI markup tests for the unaudited presentation (FR-039).
- Generic inertness tests for G25–G28.

See [quickstart.md](./quickstart.md).

**Target Platform**: self-hosted Linux containers (`web` and `worker` from one image) on Docker Compose, Unraid or Neon. Publishing runs in `runTick`. Composer reads run in the web process.

**Project Type**: web application (Next.js App Router monolith with a worker process).

**Performance Goals**:

- **Bounded steps.** Each step makes at most one TikTok call plus one storage range read (one chunk). Every call is bounded by `SCHEDULER_PROVIDER_TIMEOUT_SECONDS` (10 s by default).
- **Upload duration.** A 1 GiB video is 30 chunks of about 35.8 MB at one chunk per tick (30–60 s), so it finishes inside TikTok's 1-hour upload address. About 30 Mbit/s of upload is needed at the default 10 s limit, which is an owed live check.
- **Composer cost.** Creator info is read at most about once a minute per account.

**Constraints**:

- No sleeping in a tick; every wait is `notBefore`.
- No provider call inside a held transaction. That includes the composer save, which reads details before its transaction.
- DB clock everywhere.
- Never two publishing requests for one target.
- Tokens and the upload address never reach state (unsealed), `lastError`, attempts, summaries, activity, logs, the browser or snapshots.
- No limit literals in UI code.
- Other providers' behaviour is unchanged.

**Scale/Scope**: one new provider and four generic hooks.

- **New source files (≈ 18)** in `src/providers/tiktok/`: `config.ts`, `connect-group.ts`, `oauth.ts`, `credentials.ts`, `refresh.ts`, `http.ts`, `creator.ts`, `capabilities.ts`, `posting.ts`, `validate.ts`, `state.ts`, `steps.ts`, `sealed.ts`, `errors.ts`, `publish.ts`, `settings.ts` and `index.ts`. Also `src/providers/media-range.ts` (moved, P32).
- **New server files (3)**: `src/server/services/account-details.ts`, `src/server/services/posts/consent.ts`, `src/server/services/posts/notes.ts`.
- **New UI files (2)**: `src/components/compose/PostingFieldsPanel.tsx`, `src/components/compose/posting-ui.ts`.
- **Edited files (≈ 20)**:
  - providers: `types.ts`, `registry.ts`, `requirements.ts`, `bluesky/media-range.ts` (re-export);
  - schema: `db/schema/posts.ts`, plus `drizzle/0018_*.sql` and its snapshot;
  - services: `posts/validate.ts`, `posts/index.ts`, `posts/compose.ts`, `posts/view.ts`, `posts/list.ts`, `calendar.ts`, `accounts.ts`, `connect.ts`;
  - engine: `scheduler/publishing.ts`;
  - shared: `lib/validation/scheduling.ts`, `lib/docs.ts`;
  - UI: `Composer.tsx`, `compose/[postId]/page.tsx`, `posts/page.tsx`, `posts/[postId]/page.tsx`, `CalendarBoard.tsx`, `RequirementsSummary.tsx`.
- **Tests**: about 14 unit and 14 integration files, plus two helpers.
- **Docs**: one new (`tiktok-setup.md`), 9 edited, plus `.env.example` and `mkdocs.yml`.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How this plan meets it |
|---|---|---|
| I. Verified facts over memory | PASS | Every TikTok fact comes from `docs/research/tiktok.md` (research "Research check"). UNVERIFIED facts are each decided conservatively in one named function or constant, with a fallback, and listed as owed live checks (quickstart §8). They are: the reply envelope (P12), the token reply fields (P13), the form content type, no PKCE (P17), a chunk repeat (P27), a count-of-one `chunk_size` (P24), the photo field names, and the branded declaration rule (P22). The two NEEDS RESEARCH items (post link format, policy links) are left unbuilt, as the spec decides. Code facts were read from the repository (F1–F23). |
| II. Nothing is "working" unless it ran | PASS | Every behaviour has a mocked-HTTP or markup test (quickstart §1–§7). All TikTok behaviour is reported "verified with mocks only". The live checks are owed after audit (D16). |
| III. Project isolation | PASS | The new columns are on the project-owned `post_targets`, read and written through the scoped `targets` repository. `readAccountDetails` resolves the project scope and its permission first. It reads ciphertext through the pinned scheduling repos for that same project, as the engine does. No raw DB client is imported outside the DAL. |
| IV. One service layer | PASS | One validator (`validateTargetContent` → `validateTikTok`) serves the composer, the gate and the engine. One consent implementation (`consent.ts`) serves the check, the save, the gate and the engine. One details reader serves the composer and the save. One refresh path (`refreshForPublish`) serves the composer read, publish and the scheduled section. One note helper serves every view. |
| V. Providers are plug-ins | PASS (with justified generic changes) | TikTok's behaviour lives in `src/providers/tiktok/` plus one registry line. Four generic hooks are added the way G19 was, each inert for providers that do not use them (pinned by tests) and recorded with how to reverse it. They are G25 posting fields, G26 account details, G27 consent and G28 callback query, plus the G13 `now`. The spec authorises the first three (D3–D5). G28 and `now` are minimal, explained under Complexity Tracking. `advance` keeps its five result kinds, and only the final chunk and the photo `init` may publish. |
| VI. Boring, few dependencies | PASS | No new package and no infrastructure. The cache is an in-process `Map`; the crypto is `node:crypto`. |
| VII. Secrets never leak | PASS | Tokens are encrypted at rest (existing). The upload address is sealed with AES-256-GCM, keyed from the provider's own secret variable (F18, P25), and is never logged or summarised. `scrubTikTok` cleans every message built from a reply. The composer receives details only. A no-secrets suite echoes secrets from the fake API. The new variables are validated at startup and documented in `.env.example`. |
| Engineering constraints | PASS | `runTick` stays bounded: one call and one range read per step, with waits as `notBefore`. Times are UTC on the DB clock. The UI follows `docket-ui` (labels, `aria-describedby` for reasons, keyboard use). "Other platforms" and "video" are out of scope "until a spec says otherwise"; this spec says otherwise for TikTok video and photo posts. |
| Workflow | PASS | Conventional commits with explicit paths. This phase writes `docs/decisions.md` `## 026` (spec D1–D16, plan P1–P41). Checks run in proportion: targeted tests per task, then one final pass with `lint`, `typecheck`, `test`, `db:check` (schema changes) and `build` (UI and server boundary change). |

**Post-design re-check (after Phase 1)**: PASS.

- **Inertness is testable.** `posting`, `accountDetails` and `consent` are optional on `SocialProvider`. `PostContent.posting` is absent for other providers. The new columns are null for every existing row. `TargetCheck.posting` and `note` are null for other providers. `callbackParams` and `now` are extra inputs that existing implementations ignore. A dedicated test pins each.
- **No second publishing path.** The engine's only edit is the first-step consent refusal, before credentials, next to `validateResolvedContent`. It also adds `posting` to `PostContent`. Outcome handling, G23 and G24 are unchanged.
- **Three judgement calls against the letter of the spec**, each recorded in decisions:
  - *P29:* the posting-cap wait fails at the refusal 23 hours after the first, not 24, because the engine's 24-hour ceiling from the first step would always fire first (F13, as Bluesky P9).
  - *P4:* "consent captured when the post is scheduled" is recorded on the save that every schedule path performs immediately before scheduling (F4). The gate then refuses scheduling without it.
  - *P24:* a one-chunk upload declares `chunk_size` = `video_size`, which satisfies D9's "one chunk of its whole size" and TikTok's floor rule.

## Project Structure

### Documentation (this feature)

```text
specs/026-tiktok-provider/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0: research check, code facts F1–F23, decisions P1–P41
├── data-model.md        # Phase 1: columns, credentials, posting values, details, consent, state, chunk plan, limits rows
├── quickstart.md        # Phase 1: validation runs and owed live checks
├── contracts/
│   ├── generic-hooks.md        # G25 posting fields, G26 account details, G27 consent, G28 callback query, G13 now
│   ├── tiktok-connect.md       # env, connect group, OAuth requests, refresh, account card, tests
│   ├── tiktok-publishing.md    # capabilities, validateTikTok, creator info, steps and exact requests, outcomes, messages, secrets, tests
│   └── composer-ui.md          # check and save input, check response, panel rendering, save, target notes, summary notes, UI tests
├── checklists/
└── tasks.md             # Phase 2 (/speckit-tasks), not created here
```

### Source Code (repository root)

```text
src/
├── providers/
│   ├── types.ts                    # G25 PostingDeclaration/PostingFieldView, PostContent.posting, issue fields; G26 AccountDetailsReader; G27 ConsentDeclaration; G28 callbackParams; G13 now
│   ├── registry.ts                 # + tiktokProvider (one line)
│   ├── requirements.ts             # RequirementsSummary.notes? (ctx.notes)
│   ├── media-range.ts              # MOVED from bluesky/ (P32)
│   ├── bluesky/media-range.ts      # one-line re-export
│   └── tiktok/                     # NEW
│       ├── index.ts                # SocialProvider: capabilities, limit, connect, posting, accountDetails, consent, refresh, validate, stepFor, advance, accountNotes
│       ├── config.ts               # parseTikTokEnv, tiktokAudited, endpoints, constants
│       ├── connect-group.ts        # OAuthConnectGroup (G10, G12, G18, G28)
│       ├── oauth.ts                # token exchange and refresh calls
│       ├── credentials.ts          # schema, accountExpiry, needsRefresh
│       ├── refresh.ts              # refreshTikTok
│       ├── http.ts                 # tiktokRequest, readEnvelope (P12), scrubTikTok
│       ├── creator.ts              # readCreatorInfo, creatorDetailsSchema
│       ├── capabilities.ts         # declaration, utf16 rule, publish limit
│       ├── posting.ts              # values schema, view, heading, notice, targetNote, summaryNotes, declaration, privacy labels
│       ├── validate.ts             # validateTikTok
│       ├── state.ts                # state schema, chunkPlan, fitState, nextReadAt, constants
│       ├── steps.ts                # tiktokStepFor
│       ├── sealed.ts               # sealUploadUrl / openUploadUrl
│       ├── errors.ts               # explainTikTok (D13)
│       ├── publish.ts              # advanceTikTok: check_creator, start_upload, upload_chunk_k, publish_photos, check_status
│       └── settings.ts             # settings schema, account notes
├── server/
│   ├── db/schema/posts.ts          # five post_targets columns + check
│   ├── scheduler/publishing.ts     # PostContent.posting; first-step consent refusal
│   └── services/
│       ├── account-details.ts      # NEW: readAccountDetails + 60 s cache (G26)
│       ├── accounts.ts             # notesFor passes now (G13)
│       ├── calendar.ts             # CalendarItem.note
│       ├── connect.ts              # exchangeCode gets callbackParams (G28)
│       └── posts/
│           ├── consent.ts          # NEW: fingerprint, status, record, issue, engine refusal (G27)
│           ├── notes.ts            # NEW: targetNoteFor
│           ├── validate.ts         # TargetContent.posting/consent; consent issue; FIELD_RANK
│           ├── index.ts            # createDraft/updatePost store posting values and consent; targetView note
│           ├── compose.ts          # TargetCheck.posting, note, summary notes; details read
│           ├── view.ts             # PostViewTarget.note
│           └── list.ts             # targets[].note
├── lib/
│   ├── validation/scheduling.ts    # postTargetInputSchema.posting, .consent
│   └── docs.ts                     # DocPage "tiktok-setup"
├── components/compose/
│   ├── PostingFieldsPanel.tsx      # NEW (client)
│   ├── posting-ui.ts               # NEW pure helpers (+ test)
│   └── RequirementsSummary.tsx     # renders notes
└── app/p/[projectSlug]/
    ├── compose/Composer.tsx        # posting state, consent state, panel, note badge
    ├── compose/[postId]/page.tsx   # initial posting values and valid consent fingerprint
    ├── posts/page.tsx              # note badge
    ├── posts/[postId]/page.tsx     # note badge; "Published on TikTok" with no link
    └── calendar/CalendarBoard.tsx  # note

drizzle/0018_*.sql (+ meta snapshot)

tests/
├── helpers/fake-tiktok.ts          # NEW: scripted TikTok (OAuth, creator info, init, PUT, status) recording requests with secrets redacted
├── helpers/tiktok-publish.ts       # NEW: account, post and target setup with posting values and consent
└── integration/
    ├── tiktok/{connect,refresh,video,photo,failures,unaudited,no-secrets}.test.ts, unaudited-ui.test.tsx   # NEW
    ├── compose/{tiktok-check,posting-hooks-inert}.test.ts                                                  # NEW
    ├── posts/consent.test.ts                                                                               # NEW
    └── docs/tiktok-docs.test.ts                                                                            # NEW

docs/tiktok-setup.md (NEW); docs/{limits,adding-a-provider,feature-map,accounts,decisions,index}.md; README.md; .env.example; mkdocs.yml
```

**Structure Decision**: the existing single Next.js app, with code beside its peers.

- **TikTok's logic is pure where it can be**, split like X's and Bluesky's folders, so each request, state and step is unit-tested without a DB.
- **Generic edits are confined to the hook points** that G19–G24 already use: the types, the validation path, the compose check, the save, the engine's first-step check, and the target views.

## Implementation order (for /speckit-tasks)

1. **Schema and types.**
   - Migration `0018` and the `posts.ts` columns; `pnpm db:check`.
   - `types.ts` additions (G25–G28, G13 `now`), `ValidationIssue.field`, `FIELD_RANK`.
   - Confirm every existing suite still passes.
2. **G28 and G13.** `connect.ts` passes `callbackParams`; `accounts.ts` passes `now`. Inertness tests.
3. **G25 core.** `postTargetInputSchema.posting`; storing in `createDraft` and `updatePost`; `TargetContent.posting` in `loadTargetContent`; `PostContent.posting` in the engine; `notes.ts`; `note` in the four views; `RequirementsSummary.notes`. Then `posting-hooks-inert.test.ts`.
4. **G26.** `account-details.ts` with its cache and refresh through `refreshForPublish`. Unit and integration tests with a throwaway provider that declares a reader.
5. **G27.** `consent.ts`; the save records it; the gate adds the issue; the engine's first-step refusal. Then `consent.test.ts`, using a throwaway provider first, then TikTok.
6. **TikTok configuration and connect (US1).**
   - `config.ts`, `credentials.ts`, `http.ts`, `oauth.ts`, `creator.ts`, `connect-group.ts`, `refresh.ts`, `settings.ts`.
   - `index.ts` with stub publish steps that fail before any call, and the registry line.
   - `.env.example`. Then the connect and refresh tests.
7. **Capabilities, posting and validation (US2 rules).** `capabilities.ts`, `posting.ts`, `validate.ts`, their unit tests, and the `docs/limits.md` rows, so the inventory and enforcement tests pass.
8. **Composer (US2, US6 UI).**
   - `compose.ts` fills `TargetCheck.posting` and `note`.
   - `PostingFieldsPanel`, `posting-ui.ts` and `Composer.tsx` state; `[postId]/page.tsx` initial values.
   - The note in the posts, detail and calendar views.
   - Tests: `tiktok-check.test.ts`, `posting-ui.test.ts`, `unaudited-ui.test.tsx`.
9. **State and steps.** `state.ts` (chunk plan, fit, pace), `steps.ts`, `sealed.ts`, `errors.ts`, and their unit tests (SC-006 figures).
10. **Video end to end (US3).** `media-range.ts` move; `publish.ts` (creator check, start, chunks, status); `fake-tiktok.ts`; `video.test.ts`. Confirm the Bluesky suites pass untouched.
11. **Photos (US4).** `publish_photos`; `photo.test.ts`.
12. **Failures and unaudited (US5, US6).** `failures.test.ts`, `unaudited.test.ts`, `no-secrets.test.ts`.
13. **Docs.**
    - `docs/tiktok-setup.md` (FR-034) and `src/lib/docs.ts` and `mkdocs.yml`.
    - `docs/adding-a-provider.md` §18 and the hooks index (FR-031).
    - `docs/feature-map.md` (FR-032), `docs/accounts.md` (FR-033), `README.md`, `docs/index.md`.
    - `docs/decisions.md` implementation outcome. `tiktok-docs.test.ts`.
    - FR-036: `.env.example` gains the three variables; `docker-compose.yml` is unchanged.
14. **Final pass.** `pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm build`, once.

## Operator impact (FR-036)

- `.env.example` gains `TIKTOK_CLIENT_KEY=`, `TIKTOK_CLIENT_SECRET=` and `TIKTOK_APP_AUDITED=false` (contracts/tiktok-connect.md §1).
- `docker-compose.yml` does **not** change: the containers read `.env` through `env_file`, so an operator running a copied compose file adds the variables to `.env` only.
- One database migration (`0018`) runs on start, as every migration does. It adds nullable columns only.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Constitution V: composer, schema and engine edits for a provider (G25–G27) | TikTok's audit requires per-target fields, a live creator read and express consent for every post (research "Required UX"). No existing hook can carry them. The spec authorises these three generic hooks (D3–D5), made the way G19 added `chosen_post_type`. | Provider-specific composer code breaks the plug-in rule outright. Storing values in `step_state` cannot work, because it is null until publishing starts. A per-provider table is the same schema change with more joins. |
| G28 (`callbackParams`) beyond the spec's three hooks | D2 refuses a callback whose granted `scopes` lack `video.publish`, and TikTok reports them only in the callback query (research). `exchangeCode` does not receive it (F14). | Relying on the token reply's `scope` field, whose presence is UNVERIFIED (research). It is kept as a fallback. |
| G13 `now` | D15's "Reconnect before <date>" appears only within 30 days, which needs a clock. `accountNotes` is pure and receives none (F15). | `Date.now()` inside the hook breaks its purity and the DB-clock rule. Always showing the date gives a misleading warning a year early. |
| Upload address sealed by the provider with its own key | FR-005 treats the address as a secret, and it must survive between ticks. Providers may not import the server's crypto (F18). | Keeping it out of state would restart every chunk. Putting it in credentials would make the refresh path write upload state. |
