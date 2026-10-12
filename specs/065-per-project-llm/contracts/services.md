# Contract: services, actions and permissions

**Feature**: `specs/065-per-project-llm` | Phase 1

Every caller goes through these functions (constitution IV). Resolution itself is in
[resolution.md](./resolution.md); the screen is in [ui.md](./ui.md); the command line is in
[cli.md](./cli.md).

## 1. Permission

`src/server/auth/access.ts` gains one statement and grants it to two roles (L14, K11, FR-014).

```ts
statements.llm_credential = ["manage"];
owner:  llm_credential: ["manage"]
admin:  llm_credential: ["manage"]
editor: (absent)
```

No API key permission grants it: `KEY_GRANTS` in `src/server/dal/scope.ts` is unchanged, so no key can
read, change or check a credential. A public-API caller's *generation* still resolves normally, because
resolution asks nothing about permission (FR-002, and the spec's assumption that the public API contract
does not change).

The one question every entry point asks:

```ts
function need(scope: ProjectScope): void {
  if (!scope.can({ llm_credential: ["manage"] })) throw new ForbiddenError();
}
```

Re-checked inside the transaction (`need(tx)`), the way `webhooks/endpoints.ts` already does it, so a
demotion mid-request is refused.

## 2. `src/server/services/generation/credential.ts` (new)

```ts
export interface ProjectLlmView {
  /** What the next call in this project will use. */
  inUse:
    | { source: "project"; provider: LlmProviderName; model: string }
    | { source: "install"; provider: LlmProviderName; model: string }
    | { source: "install"; configured: false; missingSettings: string[] }
    | { source: "project"; unreadable: true };
  /** A key is stored for this project. Never any part of it (FR-013, K7). */
  hasKey: boolean;
  /** Who last set, changed or removed the override, and when. Null before the first save. */
  lastChange: { by: { id: string; name: string } | null; at: Date } | null;
  /** The cap the key input enforces, so the screen and the server agree. */
  keyMaxLength: number;
}

/** FR-013. Owner and admin only. */
export function getProjectLlm(scope: ProjectScope): Promise<ProjectLlmView>;

/** FR-001, FR-016, FR-018, FR-027. Owner and admin only. */
export function saveProjectLlm(
  scope: ProjectScope,
  input: unknown,
): Promise<ProjectLlmView>;

/** FR-017, FR-018, FR-027. Owner and admin only. */
export function removeProjectLlm(scope: ProjectScope): Promise<ProjectLlmView>;
```

### `saveProjectLlm`

1. `projectLlmCredentialSchema.parse(input)` (§4). Field-level issues quote no submitted value (FR-016).
2. `need(scope)`.
3. Read the current status. Decide the key:
   - a non-empty key → encrypt it with the project AAD; `keyChanged = true`;
   - blank key and the provider is unchanged and a key is stored → keep the stored ciphertext
     (`apiKeyEncrypted: null` in the patch); `keyChanged = false` (FR-015, K8);
   - blank key and the provider changed → `ValidationIssuesError` on `apiKey`: a key belongs to one
     provider (K8);
   - blank key and nothing stored → `ValidationIssuesError` on `apiKey`.
4. In **one** `scope.transaction({ lockProject: true })`: `need(tx)`, `tx.projectLlm.save(...)`,
   `recordAudit(tx, …)` with the before/after details, and `clearCreditHold("project:<id>", tx)` — plus
   `clearCreditHold(INSTALL_CREDENTIAL_OWNER, …)` **not** called: the install's hold belongs to every
   other project and must not be lifted by one project's save.
5. Return the fresh view.

`lockProject: true` is what makes the "two admins save at once" edge case honest: the writes serialise,
last write wins as a whole credential, both are audited, and no row ever mixes one admin's provider with
another's key.

### `removeProjectLlm`

`need`, then one transaction: `tx.projectLlm.clear(...)`, the audit row with `toProvider`/`toModel` null,
and `clearCreditHold("project:<id>", tx)` (FR-027 — a removal is a credential change). The row survives
with its check bookkeeping (L2). Returns the view, which now reports the install default.

### Never

Neither function returns, logs or includes any part of a key, and neither reads one back for display:
`getProjectLlm` uses `scope.projectLlm.status()`, which cannot return a ciphertext (FR-010, FR-015, K7).

## 3. `src/server/services/generation/check.ts` (new)

```ts
export const LLM_CHECK_COOLDOWN_MS = 30_000;
export const LLM_CHECK_LEASE_MS = 60_000;
export const LLM_CHECK_TIMEOUT_MS = 30_000;

export type LlmCheckResult =
  | { ok: true;  source: "project" | "install"; provider: LlmProviderName; model: string; latencyMs: number }
  | { ok: false; reason: "failed"; source: "project" | "install"; provider: LlmProviderName; model: string;
      kind: LlmFailureKind; message: string; latencyMs: number }
  | { ok: false; reason: "not_configured"; missingSettings: string[] }
  | { ok: false; reason: "key_unreadable"; message: string }
  | { ok: false; reason: "busy"; message: string };

/** The whole check. Takes a project id and a pinned repo, so the command line needs no session (cli.md §4). */
export function runLlmCheck(projectId: string, repo: ProjectLlmRepo): Promise<LlmCheckResult>;

/** FR-019 – FR-023. The screen's entry point: permission, then `runLlmCheck`. */
export function checkProjectLlm(scope: ProjectScope): Promise<LlmCheckResult>;
```

`checkProjectLlm` is `need(scope)` followed by `runLlmCheck(scope.project.id, scope.projectLlm)`.
`runLlmCheck` then:

1. (no permission check — it has no actor; see [cli.md §4](./cli.md))
2. `resolveLlmForProject(projectId)`.
   - `not_configured` → that branch, with `missingLlmSettings(problems)`. **No claim, no call.**
   - `key_unreadable` → that branch with the fixed sentence. **No claim, no call.**
3. `repo.claimCheck(now, LLM_CHECK_LEASE_MS, LLM_CHECK_COOLDOWN_MS)`. `false` → `busy` with
   the fixed "wait a moment" sentence and **no live call** (FR-021, AS 2.4).
4. One call through `withCreditHold(resolved.llm, resolved.owner)` (FR-023, K15) with
   `timeoutMs: Math.min(resolved.limits.timeoutMs, LLM_CHECK_TIMEOUT_MS)` (L23), the existing `llm.check`
   label and the existing one-field `check_output` schema. Nothing is saved: no post, no draft, no
   failure row, no activity event.
5. `repo.releaseCheck(now)` in a `finally`, so a thrown error still frees the lease.
6. Map the outcome: `ok` → success with `source`, `provider`, `model`, `latencyMs`; otherwise `failed`
   with `llmFailureMessage(kind)` — the existing fixed sentence and nothing else (FR-011, FR-020, K10).

A check run while the project is held is **allowed** and is the cheapest honest probe: a billing refusal
refreshes the hold, any other outcome clears it, because `withCreditHold` does exactly that (AS 2.5).

## 4. `src/lib/validation/generation.ts` — one schema

```ts
export const LLM_API_KEY_MAX = 500;

export const llmModelIdSchema = z
  .string()
  .trim()
  .min(1, { error: "Enter a model id" })
  .max(200, { error: "A model id can be at most 200 characters" })
  .refine((v) => !/\s/.test(v), { error: "A model id cannot contain spaces" });

export const projectLlmCredentialSchema = z.object({
  provider: z.enum(["openai", "anthropic"], { error: "Choose a provider" }),
  model: llmModelIdSchema,
  /** Write-only. Blank means "leave the stored key alone" (FR-015). */
  apiKey: z
    .string()
    .trim()
    .max(LLM_API_KEY_MAX, { error: `An API key can be at most ${LLM_API_KEY_MAX} characters` })
    .default(""),
});
```

The model rule is `parseLlmConfig`'s own rule, so the install and a project are checked identically
(L17). No message quotes a submitted value (FR-016). An unknown provider is refused by the enum. A key
over the cap is refused with the limit named and no part of the value — in particular, a very long or
binary-ish paste is bounded before anything touches the cipher.

## 5. Changed service signatures

| Function | Change |
|---|---|
| `getGenerationReadiness(scope)` | `ai` becomes `{ configured, source, provider, model, missingSettings, keyUnreadable }`; its answer now comes from `resolveLlmForProject` (L12, FR-005). `missingSettings` stays owner-only. |
| `getOverview(scope)` | the LLM facts come from resolution; an install-unconfigured project with a credential now reports generation available (FR-005, K3). |
| `createJob(scope, …)` | resolves; `not_configured` throws `LlmNotConfiguredError` as today, `key_unreadable` throws it with the re-enter-the-key sentence (L29). |
| `getJobView(scope, id)` | `generationConfigured` keeps its name and becomes per project; `creditHold` becomes `{ since, scope: "project" \| "install" } \| null` (L26, FR-028). |
| `generationCreditHold(scope)` | returns `{ since, scope }`; still `canView`-gated, still one read keyed by this project's owner (FR-028, AS 3.6). |
| `runGenerationStep(scope, req, llm, opts)` | `withCreditHold(llm, resolved.owner)` — the owner comes from resolution instead of a second call (L11). |
| `runGeneration` / `planSeries` defaults | `await resolveLlmForProject(scope.project.id)` instead of `getLlm()`; a non-`ok` resolution throws `LlmNotConfiguredError` with the right sentence. |
| `clearCreditHold(owner, exec?)` | optional `exec` (L25). |

Everything else in `src/server/services/` is untouched. Slot allocation, approval policy, saving,
grouping, snapshots, retries, cancel and "Retry failed items" are not in this change.

## 6. The job runner

`src/server/services/jobs/runner.ts`:

- `llmTimeoutMs()` uses `parseLlmLimits(process.env)` (L8), so the install's configured timeout applies
  even with `LLM_PROVIDER` unset.
- `logLine()` redacts the **resolved** key as well as the environment's (L30, FR-010).
- `ctx.llm ?? (await resolveLlmForProject(job.projectId))`. A non-`ok` resolution calls the existing
  `release()`: the item returns to `queued`, **no attempt counted, nothing failed**, and a new
  `notConfigured` per-item counter is incremented (L27). This is the spec's "a key removed while a job is
  queued" and "the install has no configuration" behaviour.
- `withCreditHold` is applied by `runGenerationStep` as it is today; the runner does not wrap anything
  itself.

`src/server/scheduler/generation.ts`: the early return becomes
`if (!getLlmStatus().configured && !(await anyProjectHasCredential()))` (L27). With no credential rows
anywhere, the behaviour and the counter are exactly today's.

## 7. Errors and codes

| Situation | Server | UI | Public API |
|---|---|---|---|
| Editor invokes any of the three actions | `ForbiddenError` | the generic refusal the shell already renders | n/a (no key permission) |
| Validation | `ValidationIssuesError` / Zod | field-level messages | n/a |
| Project not configured and install not configured | `LlmNotConfiguredError` | the existing "Set: …" list | existing `generation_not_configured` (400-family mapping unchanged) |
| Stored key cannot be decrypted | `LlmNotConfiguredError` carrying the re-enter sentence | the fixed sentence on the screen and in the job notice | existing `generation_not_configured` (L29) |
| Billing refusal | unchanged | unchanged | existing 503 `generation_unavailable` (H18) |
| Check refused for the cooldown | `LlmCheckResult.busy` | the fixed wait sentence | n/a |

**No new API error code, no new failure kind, no new pgEnum value except the audit action.**

## 8. Fixed sentences

`src/lib/generation/llm-source.ts` (new), beside `src/lib/jobs/credit-hold.ts`:

```ts
export const LLM_KEY_UNREADABLE =
  "This project's stored API key cannot be read. An owner or admin must enter it again in Settings → Model.";
export const LLM_CHECK_BUSY =
  "A check is already running for this project. Wait a few seconds and try again.";
export const LLM_SOURCE_INSTALL =
  "This project uses the model and API key configured for this Docket.";
export const LLM_SOURCE_PROJECT =
  "This project uses its own model and API key, and spends its own provider credit.";
```

`src/lib/jobs/credit-hold.ts` gains exactly one constant and keeps its five (L26):

```ts
export const CREDIT_HOLD_ACCOUNT_PROJECT = "Add credit to this project's own provider account.";
// CREDIT_HOLD_ACTION ("Add credit to the provider account.") stays, used for the install's credential.
```

Every one of these is covered by `tests/lint/date-format.test.ts`'s sibling conventions: no instant is
formatted inside a sentence; instants go through `LocalTime`.
