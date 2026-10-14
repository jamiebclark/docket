# Phase 1: Quickstart — validating the Pinterest provider

How to prove this entry works, end to end, without ever calling Pinterest. Details live in
[data-model.md](./data-model.md) and [contracts/](./contracts/); this file is the run guide.

## 0. Prerequisites

- **Node 24 LTS and pnpm.** This is a git worktree with **no `node_modules` of its own** (research F23):
  run `pnpm install --frozen-lockfile` here once before anything else. Node's upward resolution finds the
  main checkout's install for plain imports, but the binaries (`vitest`, `eslint`, `next`) and
  `scripts/generate-icons.mjs`'s own path resolution do not.
- **Postgres**, reachable through `DATABASE_URL`. Integration tests create run-scoped databases.
  On the maintainer's machine the test instance listens on **5555**, not the 5432 in `.env.example`.
- **No Pinterest credentials, no Pinterest app, no network.** Every Pinterest endpoint is a fake
  (`tests/helpers/fake-pinterest.ts`). A test that reaches the real `api.pinterest.com` is a bug.
- `PINTEREST_CLIENT_ID` and `PINTEREST_CLIENT_SECRET` are **not** needed in the shell: the tests set them
  per case, including the unset case.

## 1. The quickest proof the provider is wired up

```bash
pnpm vitest run src/providers/registry.test.ts src/providers/pinterest
```

Proves: the registry loads with Pinterest in it (which also runs `mediaConstraintsOf` and
`assertVideoCapabilities` over the declaration), providers still import nothing from `src/server/**`, and
every pure Pinterest module behaves (config, http, oauth, credentials, refresh, boards, capabilities,
posting, validate, errors, steps, publish).

## 2. Connecting (US1, FR-002–FR-008)

```bash
pnpm vitest run tests/integration/pinterest/connect.test.ts \
                tests/integration/pinterest/availability.test.ts
```

Expected:

- with both variables set and an `https` public `BETTER_AUTH_URL`, the authorization URL carries
  `client_id`, the exact `redirect_uri`, `response_type=code`,
  `scope=user_accounts:read,boards:read,pins:write` and `state` — and **no** `code_challenge`;
- the callback exchanges the code with HTTP Basic and the form body, reads `GET /v5/user_account`, and the
  project gains one account: Pinterest's `id` as the external id, the business name (or the username) as
  the display name, `{}` settings, the refresh token's expiry as the account expiry, and a card that says
  pins are visible only to the account's owner while the app has Trial access;
- with neither variable set, Pinterest is listed as **not configured on this server** with a link to
  `docs/pinterest-setup.md` and no connect action, and a hand-made POST to start the flow is refused
  server-side;
- with `BETTER_AUTH_URL=http://localhost:3000`, Pinterest is **unavailable** with its own reason and the
  callback-address anchor;
- a cancelled callback shows "Connecting was cancelled. Nothing changed." and nothing from the query.

## 3. The board picker (US2, FR-016–FR-020, SC-008)

```bash
pnpm vitest run tests/integration/compose/pinterest-check.test.ts
```

Drive each of the five states (data-model.md §5) and expect exactly one outcome each:

| Fake `GET /v5/boards` | Expect |
|---|---|
| two pages, 300 boards | all 300 options, Pinterest's order, nothing pre-selected |
| `{ items: [] }` | disabled control, "create one on Pinterest", `no_boards`, cannot be scheduled |
| 500, then 200 on Retry | `details: "error"` with a message and Retry; the stored board still shown; Retry sends `refreshDetails: true` and is not served from the cache |
| boards that do not include the stored id | the stored board still selected, disabled, labelled "no longer on Pinterest", `board_not_found` |
| boards including the stored id | no issues, `canSchedule: true` |

Also: a target with no board cannot be approved or scheduled (`posting.boardId` issue); two Pinterest
accounts on one post keep separate boards; `Board: <name>` appears in the composer card, the posts list,
the post detail page and the calendar.

## 4. Publishing one pin (US2, FR-022–FR-023, FR-027, SC-003)

```bash
pnpm vitest run tests/integration/pinterest/publish-e2e.test.ts
```

Expected, with the clock pinned by `atTime` and the tick driven by `runTick`:

- **exactly one** outbound request, `POST /v5/pins`, carrying `board_id`, `media_source.image_url`,
  `description`, `alt_text`, `title` and `link`;
- blank text, blank alt text, an empty title and an empty link each omit their key entirely;
- the target becomes `published` with Pinterest's pin id as the external id and
  `https://www.pinterest.com/pin/<id>/` as the link;
- a second tick sends nothing.

## 5. Failures, limits and ambiguity (US3, FR-024–FR-026, FR-030, SC-004)

```bash
pnpm vitest run tests/integration/pinterest/failures.test.ts
```

Walk the whole outcome table (contracts/pinterest-publishing.md §4) and assert the recorded outcome, the
next-attempt time and the message for each: connection refused, a lost connection after send, an
unparseable 2xx, a 2xx with no id, 401 → refresh → retry, 429 with a readable `x-ratelimit-reset`, 429
with none, 400, 403, 404 (naming the stored board, not retried), another 4xx, and a 5xx.

The two that matter most:

- **no automatic retry ever sends a second create request.** Every ambiguous case stays `ambiguous`
  across later ticks and its `lastError` tells the person to check the board on Pinterest first.
- **a target over 100 pins in 60 seconds is deferred, not failed.**

## 6. Validation edges (FR-009–FR-015, SC-005)

```bash
pnpm vitest run src/providers/pinterest/validate.test.ts \
                tests/integration/limits/enforcement.test.ts
```

Every refusal names the field and the limit: 800 (description), 100 (title), 2048 (link), 500 (alt text),
20,000,000 bytes, one image, media required, no video. Text at exactly 800 publishes. A 1000×3000 image
produces the aspect **warning** and still publishes. The generated enforcement suite covers each declared
capability with Pinterest's own numbers.

## 7. Secrets (FR-008, constitution VII)

```bash
pnpm vitest run tests/integration/pinterest/no-secrets.test.ts tests/integration/no-plaintext.test.ts
```

The fake echoes the client secret, the access token and the refresh token back in every reply; nothing
appears in `lastError`, `publish_attempts`, the attempt summary, activity, the rendered page or a
snapshot, and the stored credentials are ciphertext.

## 8. Docs and the deployer's path (US4, FR-033–FR-036)

```bash
pnpm vitest run tests/integration/docs
```

- `pinterest-docs.test.ts` checks that `docs/pinterest-setup.md` leads with the business-account
  requirement, names both variables, gives the callback address and the "matched exactly" rule, states the
  Trial visibility rule and the demo video for Standard, names the Trial rate limits, says the
  `api-sandbox` host is never called, says the provider is verified against mocked responses only, and
  lists the owed live checks; and that every anchor `docsUrl("pinterest-setup", …)` points at a heading
  that exists.
- `limits-inventory.test.ts` checks the new `## Pinterest` section against the declaration.
- `published-docs.test.ts` checks the `mkdocs.yml` nav entry and the `DocPage` union.
- `provider-guide.test.ts` checks the new `docs/adding-a-provider.md` section and hooks-index row.

## 9. The generic hooks stay inert (G29 and the two corrections)

```bash
pnpm vitest run tests/integration/compose/posting-hooks-inert.test.ts \
                src/components/compose/posting-ui.test.ts \
                tests/integration/tiktok
```

TikTok's panel markup, counts and behaviour are unchanged; a provider that declares no `labelKey` and no
`docLabel` renders as it did.

## 10. The platform mark (FR-035)

```bash
pnpm install --frozen-lockfile   # if not already done
pnpm icons
git diff --stat src/components/ui/icons.generated.ts
```

`icons.generated.ts` gains `pinterest` (and `tiktok`, which 026 missed). Commit the generated file.

## 11. The final pass, once

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

`pnpm db:check` is **not** needed: this entry changes no schema. `pnpm build` is needed because the
posting panel and `posting-ui.ts` change.

## 12. Owed live checks (cannot be run by any phase)

Listed in `docs/pinterest-setup.md` and parked in a final human-owned phase. A real Pinterest business
account, a registered app and Trial approval are prerequisites for all of them.

1. **U1** — does Pinterest accept a non-https or localhost redirect URI?
2. **U2** — the error body for 400, 401, 403, 404, 429 and 5xx.
3. **U3** — is 20 MB enforced? Any pixel bounds? Is an out-of-range aspect refused or just cropped?
4. **U4** — how `title`, `description` and `alt_text` are counted.
5. **U5** — the real permalink of a created pin.
6. **U6** — whether PKCE is accepted at all.
7. **U7** — the `account_type` values a business account returns.
8. **U8** — whether a legacy 365-day refresh token rotates.
9. **U9** — whether a revoked grant surfaces as anything other than a 401.
10. **U10** — whether the organic Pins API is region-restricted.
11. **The one thing no mock can show:** that a pin created by a Trial app is invisible to anyone but the
    connected account's owner — and that it becomes visible after Standard access is granted.

Until these are done, the documentation says plainly that the Pinterest provider has been verified with
mocked responses only (FR-037, constitution II).
