# Quickstart: validating Facebook Pages and Instagram

**Feature**: `005-meta-facebook-instagram` | **Plan**: [plan.md](./plan.md)

Everything in §1–§7 runs with mocked HTTP only and needs no Meta app. §8 is the owner's live check after merge. Until it is done, live connect and publishing are reported as **verified with mocks only** (constitution II).

## 0. Prerequisites

- Node 24, pnpm, and the test Postgres from earlier entries (`postgres://docket:docket@127.0.0.1:5433/docket_test` locally, see decision #21, or CI's service).
- `.env` as in 001–004. For the UI walk only (§7), also set fake Meta values:
  ```bash
  META_APP_ID=1234567890
  META_APP_SECRET=0123456789abcdef0123456789abcdef
  # META_GRAPH_VERSION=v26.0          # default
  # META_LOGIN_CONFIG_ID=             # optional (R4)
  ```
- No dependency installs: nothing new is needed (decision #19).

## 1. Framework fixes (G5–G8) with a throwaway provider

```bash
pnpm vitest run src/providers/registry.test.ts \
  tests/integration/connect/oauth-flow.test.ts \
  tests/integration/connect/state-security.test.ts \
  tests/integration/connect/paste.test.ts \
  tests/integration/scheduler/credentials-invalid.test.ts \
  src/server/startup/startup.test.ts
```

Expected:

- Registry invariants hold (one group object per key; no `connectAccount` on oauth providers; env vars present in `.env.example`).
- A throwaway two-provider group connects through start → callback → chooser, with no Meta code involved.
- Every refused-state case (missing, unknown, expired, reused, foreign session, lost role) makes **no** exchange call and changes no account (SC-002).
- A paste creates the same chooser.
- G7 flips the account to `needs_reauth`, with no retry and no ambiguity.
- Startup reports a half-set group env in the same error block as the core env.

## 2. Shared Meta module

```bash
pnpm vitest run src/providers/meta
```

Expected:

- `parseMetaEnv` all-or-none and version rules.
- Dialog URL with `scope` or `config_id`.
- Code → long-lived exchange.
- Pages → candidates (with and without a linked Instagram account, malformed entries, paging cap, no Pages).
- `graphStepError` covers every row of the research D12 table.
- `scrub` removes tokens, secrets and codes.

## 3. Facebook provider

```bash
pnpm vitest run src/providers/facebook tests/integration/facebook
```

Expected:

- Validation edges.
- Text post with the first URL as `link`.
- One photo.
- Three photos: 3 × `upload_photo` then `publish_feed` with `attached_media` in order (**mocks only, U1**).
- Retryable, fatal, ambiguous (timeout after send, reset, 5xx, unparseable 2xx, 2xx without id) and 190 paths.
- `scheduled_publish_time` is never sent.
- The end-to-end `runTick` test publishes text in one tick and N photos in N + 1 ticks (SC-004).

## 4. Instagram provider

```bash
pnpm vitest run src/providers/instagram tests/integration/instagram
```

Expected:

- Validation edges (no media, 10/11 images, aspect 0.8/1.91, alt 1,000/1,001, PNG → convert note, 8 MB).
- `IN_PROGRESS` → `FINISHED` across separate ticks, with `next_attempt_at` ≈ +10 s then +20 s, and no sleep.
- `ERROR` fails with no publish request.
- `EXPIRED` recreates twice, then fails.
- `PUBLISHED` before publish is `ambiguous`.
- The 60-minute cap fails.
- A carousel of 4 takes 8 ticks (N + 4).
- Quota full → retry +1 h, with no publish request. Quota unreadable → publish proceeds.
- Publish ambiguous (timeout, reset, 5xx, unparseable) and publish rejected as expired (fatal, no recreation).
- 190 → `needs_reauth`.
- The JPEG variant URL is used, never the original.

## 5. Limits, the unchanged engine and secrets

```bash
pnpm vitest run tests/integration/instagram/limits.test.ts tests/integration/meta/no-secrets.test.ts tests/integration/meta/engine-unchanged.test.ts
```

Expected:

- With 150 queued Instagram targets on one account and the clock advanced through 48 h, at most 100 publish requests go out in any rolling 24 h (SC-006). The 101st start waits without a provider call.
- No fake token, app secret or code appears in attempts, step state, `last_error`, account or attempt rows outside the ciphertext, action results, rendered chooser HTML or captured console output (SC-007).
- Both providers publish end to end through the real `runTick`, with only `fetch` stubbed (FR-003).

## 6. Authorization and UI behaviour

```bash
pnpm vitest run tests/integration/actions-authz.test.ts tests/integration/accounts-ui.test.ts tests/integration/connect/chooser-ui.test.ts
```

Expected:

- Editors see no connect, paste or reconnect controls, and every direct call is refused.
- The "not configured" state shows `docs/meta-setup.md` and the redirect address.
- The chooser lists Pages with nested Instagram accounts, "already connected", "needs reconnecting" and "not found for this login".

## 7. Manual UI walk (fake Meta values, no live calls)

1. `pnpm dev`, then sign in as an owner and open `/p/<slug>/accounts`.
2. Check that the "Connect Facebook Pages and Instagram" section appears and that the paste form is present.
3. Without the Meta env vars, the section says Meta is not configured and shows `http://localhost:3000/connect/callback` with a copy button.
4. Click **Connect**. The browser goes to `https://www.facebook.com/v26.0/dialog/oauth?...`. With fake ids this is where the walk stops. Check that the URL has `state`, `redirect_uri` and the five scopes (or `config_id`), and no secret.
5. Open `/connect/callback?state=bogus&code=x`. You land on "This connection attempt has expired or is not valid. Start again."

## 8. Owner's live check (after merge; not run by the build)

Follow `docs/meta-setup.md`, then check each item:

- [ ] Connect through Facebook Login. Check that every managed Page and each linked Instagram account is listed, then tick one of each.
- [ ] Try the localhost redirect in development mode (U2). Record whether it worked in `docs/decisions.md`.
- [ ] Paste a Graph API Explorer user token, with the five permissions ticked. The same chooser appears.
- [ ] Publish to the Page: a text post with a link, one photo, and a three-photo post (U1). Record the result.
- [ ] Publish to Instagram: one image, and a three-image carousel with alt text.
- [ ] Remove the app in Facebook settings and publish again. The account shows "Needs reconnecting". Reconnect, then retry the failed target.
- [ ] Update `docs/decisions.md`: change "verified with mocks only" to "verified live on <date>" for each item that passed.
