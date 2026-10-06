# Quickstart: validating the X provider (014)

X is verified **with mocked HTTP only**. There is no live check, and none is owed: the owner does not use X. Every scenario below runs offline against `tests/helpers/fake-x.ts`. Details are in [contracts/](./contracts/) and [data-model.md](./data-model.md); this file only says how to run and what to expect.

## 0. Prerequisites

- Node 24 LTS and pnpm. Postgres for the integration tests, through the existing run-scoped test databases (`tests/helpers/db.ts`).
- This worktree has no `node_modules` (research F14). Install from the local pnpm store, with no network and no new package:

  ```bash
  pnpm install --offline --frozen-lockfile < /dev/null
  ```

  If that fails because the store lacks a package, stop and report it. Do not add or substitute a package (constitution VI, decision #19).
- No X variables are needed. Tests set `X_CLIENT_ID=test-client-id` and `X_CLIENT_SECRET=test-client-secret-…` through `vi.stubEnv` where required.

## 1. Unit: counting, validation, steps, refresh (no database)

```bash
pnpm vitest run src/providers/x
```

Expected: all of these pass.

- `text.test.ts`, the corpus of at least 30 strings (SC-003):
  - ASCII 280 → ok, 281 → too long;
  - `"é"` decomposed counts as 1 after NFC;
  - CJK and Cyrillic: Cyrillic `"д"` (U+0434) is 1, `"日"` is 2;
  - range edges: U+10FF → 1, U+1100 → 2, U+2000 → 1, U+200E → 2, U+2010 → 1, U+2018 → 1, U+2027 → 2, U+2032 → 1, U+2037 → 1, U+2038 → 2;
  - emoji: `👨‍👩‍👧‍👦`, `🇬🇧`, `1️⃣` and `👍🏽` → 2 each;
  - URLs: `https://example.com/a/very/long/path` → 23, `example.com` → 23, `www.example.org/path?q=1#f` → 23, `see example.com.` counts the trailing dot as 1, `file.txt` is not a URL;
  - mixed text.
- `validate.test.ts`: the shared refusals at the declared capability edges, the `x_count_may_differ` warning above 270 with a URL or emoji, and no warning without one.
- `steps.test.ts`: `stepFor` for every row of data-model §5, including unreadable state, a `mediaCount` mismatch, pending processing, an undescribed image, and NaN or negative `mediaCount`.
- `pkce.test.ts`: the verifier is 43 characters in the RFC 7636 alphabet, deterministic per state and secret, and different for another state or secret. The challenge equals base64url(SHA-256(verifier)).
- `config.test.ts`: env with none, one or both variables set, and malformed values. Issues never contain a value.
- `refresh.test.ts`:
  - `needsRefresh` at 5 min + 1 ms (false), 5 min − 1 ms (true), expired (true) and with unreadable credentials (false);
  - every row of the refresh table in contracts/providers.md;
  - two refreshes in a row, where the second sends the refresh token returned by the first (SC-005).
- `publish.test.ts`: every row of the outcome table in contracts/providers.md for upload, check, describe and create. It also covers the expiry guard, the usage-cap 429 (`notBefore ≥ now + 1 h`), the post URL with and without a username, and that only the chunked endpoints are called.

## 2. Integration: connect, publish end to end, no secrets

```bash
pnpm vitest run tests/integration/x tests/integration/connect
```

Expected:

- **`x/connect.test.ts`** (US1, SC-001):
  - start → an authorize URL with the exact scopes, `S256` and a challenge that matches the `code_verifier` sent on the token call;
  - callback → Basic auth carrying the client id, the form fields per contracts/x-api.md, then `GET /2/users/me`;
  - one candidate `@dockettest` → save → an encrypted row with `credentials_expires_at` ≈ now + 180 d and the card note "X name: Docket Test";
  - `access_denied` → cancelled, nothing saved;
  - a token refusal, a transient failure, a missing refresh token, a profile failure → `exchange_failed`, nothing saved;
  - scope missing `tweet.write` and/or `media.write` → notes;
  - reconnect of a `needs_reauth` account → `active`.
- **`x/availability.test.ts`** (US5):
  - variables absent → the group is `configured: false` and start is refused;
  - one variable set → a startup issue naming the missing variable;
  - `BETTER_AUTH_URL=http://localhost:3000` → unavailable with the G10 reason and an `x-setup#callback-address` link, and start is refused;
  - other groups are unchanged.
- **`connect/state-to-exchange.test.ts`** (G17): a recording throwaway group receives the attempt's raw state. A foreign or replayed state never reaches `exchangeCode`. Meta and Threads connect tests still pass unchanged.
- **`x/publish-e2e.test.ts`** (US2, US3, SC-002, SC-004), driven by `runTick` with the DB clock:
  - a text post publishes in exactly one step;
  - a two-image post with alt text runs `upload_image_1` → `describe_image_1` → `upload_image_2` → `describe_image_2` → `create_post`, sending `media_ids` in order;
  - a pending finalize adds `check_image_k` steps after `check_after_secs`;
  - `create_post` timeout, reset, 5xx or unreadable 2xx → `ambiguous`, never retried on later ticks;
  - 401 → refresh then publish on the next tick;
  - expired media ids → re-upload before create.
- **`x/refresh.test.ts`** (US4): the scheduled refresh renews an idle account inside the 72 h window before the 180-day estimate; `invalid_grant` → `needs_reauth`; 5xx or 429 → `active` with the refresh lease held until `retryAt`.
- **`x/no-secrets.test.ts`** (FR-033, SC-008): after connect, refresh and every advance path, no fake token, client secret, code, state or verifier appears in any plaintext column, attempt summary, `step_state`, `last_error`, logged line or error message.

## 3. Framework and docs suites still pass

```bash
pnpm vitest run src/providers/registry.test.ts src/server/services/generation/prompt.test.ts \
  tests/integration/docs tests/integration/limits tests/lint
```

Expected:

- the registry lists `x` in its own connect group with `X_CLIENT_ID` and `X_CLIENT_SECRET`;
- the prompt test shows X's platform rules (contracts/providers.md, "Generator");
- `limits-inventory` passes with the new `## X` section, and the generated `x: <category>` enforcement rows pass;
- `provider-guide` covers G17;
- the README, deployment (Unraid template), published-docs and env-coverage checks pass;
- the import-boundary lint passes for `src/providers/x`.

## 4. Platform mark

```bash
pnpm icons && git diff --stat src/components/ui/icons.generated.ts
```

Expected: one added `x:` line in `PROVIDER_MARKS` (title `X`, hex `#000000`), and no other change. The Accounts screen, composer and account picker render it through `ProviderIcon` (covered by `tests/integration/accounts-ui.test.ts` with an X account).

## 5. Final pass (once, at the end of implement)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

`pnpm db:check` should report no migration (there is no schema change). `pnpm build` is needed because `src/lib/docs.ts` and the accounts screen's data change.

## 6. What is not verified

- The live X API in any form. This is said in the first paragraph of `docs/x-setup.md`, and in `docs/accounts.md` and `docs/decisions.md`.
- The UNVERIFIED items U1–U9 (spec), each listed in `docs/x-setup.md`.
- No owner live check is planned or owed.
