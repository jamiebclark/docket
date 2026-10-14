# Quickstart: Per-project LLM

**Feature**: `specs/065-per-project-llm` | Phase 1

How to run this feature and the checks that prove each user story. Every live-provider behaviour is
verified with **mocked HTTP only** (constitution II): no test in this entry opens a socket to a provider.

## 1. Prerequisites

```bash
pnpm install                       # already installed in pipeline phases; no new dependency
pnpm db:migrate                    # applies 0024 (one enum value, one table)
pnpm db:check                      # the committed SQL matches the schema
```

- `CREDENTIALS_ENCRYPTION_KEY` is already required at startup, so nothing new to set. **No new
  environment variable.**
- Integration tests need `DATABASE_URL` pointing at a database whose name ends in `_test`
  (`tests/setup/global-setup.ts` refuses anything else and clones per worker). On this machine the test
  Postgres listens on **5555**, not the 5432 in `.env.example`.
- `LLM_PROVIDER` may be set or unset for these checks; several of them deliberately run with it unset.

## 2. Running it by hand

```bash
pnpm dev
```

1. Sign in as a project **owner** or **admin** and open **Settings → Model & API key**
   (`/p/<slug>/settings/model`).
2. Choose a provider, type a model id, paste a key, **Save**.
3. Press **Check this credential** — a verdict in seconds.
4. Generate once in that project (Generate, or Voice → "Try it"): the call runs on that credential.
5. Press **Remove this project's credential** and confirm: the project is back on the install default.

Operator path, no sign-in:

```bash
pnpm llm:check                             # unchanged: the install's credential
pnpm llm:check -- --project <slug>         # that project's resolved credential
```

Sign in as an **editor** and confirm the sub-nav has no "Model & API key" item and the URL 404s.

## 3. The checks that prove each story

Run only what a task touches (constitution: checks in proportion to the change), then the full
`pnpm lint && pnpm typecheck && pnpm test` once at the end of the implement phase, plus `pnpm db:check`
(the schema changed) and `pnpm build` (routes and server/client boundaries changed).

### US1 — a project brings its own model and key (P1)

```bash
pnpm vitest run tests/integration/llm/per-project-resolution.test.ts src/server/llm/resolve.test.ts
```

| Proves | How |
|---|---|
| AS1 — env-only install unchanged | no credential row anywhere; `resolveLlmForProject` reports `source: "install"`, and the provider instance is the one `getLlm()` memoised |
| AS2 — every path uses the project's credential | `setLlmFactoryForTests` returns a different stub per `config.apiKey`; one single generation, one series plan, one regenerate, one "Try it", one job item and one public-API generation in project A and the same six in project B; each observed call carries its own project's key (L13) |
| AS3 — no restart, no stale cache | save, then generate in the same process; the new credential is used on the next call (L7) |
| AS4 — `LLM_PROVIDER` unset | `vi.stubEnv("LLM_PROVIDER", "")`; project A (with a credential) reports generation available and generates; project B reports not configured with today's `Set: …` names (FR-005, K3) |
| AS5 — removal reverts in one action | `removeProjectLlm`, then resolution reports `source: "install"`; the row's `api_key_encrypted` is null |
| AS6 — install limits apply | the stub records `timeoutMs`/`maxOutputTokens`; identical for both sources, including with `LLM_PROVIDER` unset and `LLM_TIMEOUT_SECONDS` set (FR-004, L8) |

### US2 — a key can be checked before a 500-item job (P1)

```bash
pnpm vitest run tests/integration/llm/check.test.ts scripts/llm-check.test.ts
```

| Proves | How |
|---|---|
| AS1 — success reports source, provider, model, latency, saves no post | after the check, the project has zero posts, zero drafts, zero `generation_failures` rows and zero activity events |
| AS2 — a wrong key reports one fixed sentence | the fake provider returns `auth`; the result's `message` is exactly `llmFailureMessage("auth")` and contains no provider text and no key |
| AS3 — no credential checks the install default | `source: "install"` in the result and in the CLI line |
| AS4 — one at a time | two `runLlmCheck` calls started concurrently: exactly one live call reaches the stub, the other returns `busy`; and a second call inside the cooldown returns `busy` with no call |
| AS5 — billing sets then clears the project's hold | the stub refuses on billing → `llm_credit_holds` has `project:<id>` and not `install`; then the stub answers → the row is gone |
| AS6 — the CLI | `main({ project: slug, llm, log })` prints `source=… provider=… model=… outcome=… latency_ms=…` and returns 1 on failure; `main({ llm, log })` with no project prints today's exact lines, including `job_call` and `jobs budget_ms=…` |
| SC-003 — under 30 s | the call's timeout is `min(installTimeout, LLM_CHECK_TIMEOUT_MS)`, asserted on the stub's received `timeoutMs` |

### US3 — one project running dry does not hold another's jobs (P1)

```bash
pnpm vitest run tests/integration/llm/hold-scope.test.ts tests/integration/jobs/credit-hold.test.ts
```

| Proves | How |
|---|---|
| AS1 — isolation | queue jobs in A (own credential, refusing on billing) and B (install default, funded); run ticks; B's items are claimed and completed at the usual rate, A's stay `queued` with `attempt_count` unchanged and `status != 'failed'` |
| AS2 — install-default projects are held together | three projects on the install default, one refusal; all three are skipped, and a fourth with its own working credential is not |
| AS3 — independent probe schedules | two held owners; each gets exactly one probe per `CREDIT_PROBE_INTERVAL_MS`, and one owner's probe does not consume the other's (`next_probe_at` per row) |
| AS4 — a save clears the hold at once | hold A, save a new key, run one tick: A's items are claimed with no probe wait and no retry action, and A's hold row is gone (FR-027) |
| AS5 — the notice names whose account | render the Batch jobs list and a job page in A: the notice carries `CREDIT_HOLD_ACCOUNT_PROJECT`; the same screens for a held install-default project carry `CREDIT_HOLD_ACTION` |
| AS6 — no notice elsewhere | the same screens in funded B render no notice |
| AS7 — deletion leaves nothing | delete the project row directly; the credential row is gone by cascade and `pruneOrphanCreditHolds()` removes the `project:<id>` hold (FR-029) |
| SC-006 — throughput | B's completed-item count per tick is identical to a run with no hold anywhere |
| regression | the whole of entry 1's suite passes unchanged: probe single-flight, rewind, kill-recovery, no-retry-on-ambiguous, nothing failed while held |

### US4 — a key never leaks, and only owners and admins can touch it (P1)

```bash
pnpm vitest run tests/integration/security/secret-scan.test.ts tests/integration/no-plaintext.test.ts \
  tests/integration/llm/credential-authz.test.ts src/server/llm/key-reads.test.ts
```

| Proves | How |
|---|---|
| AS1 — the surface renders no character of the key | the rendered page for owner and for admin contains neither the key nor any 4-character substring of it, and does contain "A key is stored" and the last-change line |
| AS2 — an editor sees nothing and is refused | the editor's sub-nav has no item, the page 404s, and `saveProjectLlm` / `removeProjectLlm` / `checkProjectLlm` each throw `ForbiddenError` with nothing changed in the database (SC-005) |
| AS3 — an echoing provider error leaks nowhere | the fake provider's error body embeds the **stored** key; the log line, the action result, the `generation_failures` row, the API response and the rendered screen are all scanned, and the user-facing text is the one fixed sentence |
| AS4 — the whole scanned run | the secret-scan section of L32: set, change, remove through the real actions; the page for owner, admin and editor; a check; a tick that generates; a billing refusal echoing the key — scanned in raw, base64, base64url, URL-encoded and hex, with nothing exempted; the file's deliberate-leak test still fails on a planted leak |
| AS5 — ciphertext only | `project_llm_settings` is dumped as text and the plaintext key is not a substring of any column of any table in either database |
| AS6 — a moved ciphertext | copy A's `api_key_encrypted` into B's row; generation in B reports unavailable and makes **no** provider call (`fetch` spy sees nothing) |
| AS7 — a rotated encryption key | re-stub `CREDENTIALS_ENCRYPTION_KEY`; the project reports `LLM_KEY_UNREADABLE`, the install's credential is **not** used (zero calls on it), and the row is unchanged afterwards (SC-008) |

### Install-wide invariance (SC-001)

```bash
pnpm test
```

The whole existing suite must pass **unchanged** — not adjusted, not re-snapshotted. In particular:
`src/server/llm/*.test.ts`, `src/server/llm/key-reads.test.ts`, `src/server/llm/messages.test.ts`,
`scripts/llm-check.test.ts`, every `tests/integration/jobs/*` file and every generation golden/snapshot
file. A changed expectation in any of them is a defect in this plan, not a test to update.

### Docs

```bash
pnpm vitest run tests/integration/docs/security-findings.test.ts tests/lint/env-coverage.test.ts \
  tests/lint/date-format.test.ts tests/lint/ui-limit-literals.test.ts
```

- `security-findings.test.ts` requires every `docs/security.md` row to name tests that exist — so the new
  row and the four updated rows must name real files (FR-031).
- `env-coverage.test.ts` must still pass with **no** new variable documented, because none is added.
- `date-format.test.ts` covers the new sentences and the `LocalTime` usage.
- `ui-limit-literals.test.ts`'s convention: the key length cap reaches the component from the server
  view, never as a literal.

## 4. Manual walk-through (the last task)

Done in a real browser against `pnpm dev`, after everything automated (the roadmap's rule, and the
pipeline-deadlock note in `docs/decisions.md`):

1. Owner sets a credential, checks it, generates, removes it, checks again.
2. Admin does the same; editor confirms the section is absent and the URL 404s.
3. Keyboard only: tab to every control, operate the `SegmentedControl` with arrows, open and confirm the
   remove dialog with Enter and dismiss it with Escape, confirm focus returns.
4. With client JavaScript disabled: save, check and remove all still work.
5. Confirm no screen, no toast and no page source contains any part of the key.

## 5. What this does not do

- **No spend, cost or token reporting anywhere** — roadmap entry 3, `llm-cost-visibility`.
- **No provider beyond `openai` and `anthropic`** — closed by the roadmap.
- **No non-admin access of any kind** to seeing, changing or checking a key.
- **No budgets, caps or throttling**; **no per-project timeout or output-token limit** (K2); **no
  per-user credential** — none is owned by any roadmap entry.
- **No change to entry 1's hold mechanics** — probe interval, single-flight probing, "nothing failed
  while held", no give-up timeout, no operator control to lift a hold. Only the owner's identity widens.
- **No notification or email** when a credential fails — the notifications roadmap owns attention events.
- **No image-generation credential**, and **no model-id validation against a provider catalogue** — the
  live check is the validation.
