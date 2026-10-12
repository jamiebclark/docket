# Contract: resolution — the one named place

**Feature**: `specs/065-per-project-llm` | Phase 1

FR-006 says resolution happens "in exactly one named place that every caller uses". This file names it,
fixes its signature, and lists every caller. A reviewer checks FR-006 by checking that the table in
[research.md §3](../research.md) is complete and that nothing outside this module reads the environment
keys or the credential column.

## 1. `src/server/llm/resolve.ts`

```ts
export type ResolvedLlm =
  | {
      ok: true;
      /** Which credential this project's next call will spend. */
      source: "project" | "install";
      provider: LlmProviderName;
      model: string;
      /** The credit-hold key for this credential (L11). */
      owner: string;
      /** Install-wide, whatever the source (K2, FR-004). */
      limits: { timeoutMs: number; maxOutputTokens: number };
      /** Holds the key. Never serialised, logged, returned to a caller outside the server, or cached. */
      llm: LlmProvider;
    }
  | { ok: false; reason: "not_configured"; problems: EnvIssue[] }
  | { ok: false; reason: "key_unreadable" };

/**
 * The project's credential, or the install's. The only place that reads
 * `project_llm_settings.api_key_encrypted` or calls `getLlm()` on a project's behalf (FR-006).
 */
export function resolveLlmForProject(projectId: string): Promise<ResolvedLlm>;
```

### Algorithm

1. Read the project's row (`src/server/dal/project-llm.ts`, pinned by `project_id`).
2. A test override wins first: `setLlmForTests` (unchanged semantics, L13).
3. `provider IS NOT NULL` → decrypt with `aad: "project_llm_credential:<projectId>"`.
   - `SecretDecryptionError` → `{ ok: false, reason: "key_unreadable" }`. **Never** fall through to the
     install credential (FR-012, K9). The row is left untouched.
   - success → `{ ok: true, source: "project", owner: "project:<id>", … }`, with the provider built from
     `{ provider, model, apiKey, ...limits }` and **not cached** (L7).
4. Otherwise the install: `parseLlmConfig(process.env)`.
   - not ok → `{ ok: false, reason: "not_configured", problems }`.
   - ok → `{ ok: true, source: "install", owner: INSTALL_CREDENTIAL_OWNER, llm: getLlm(), … }`, which
     keeps `getLlm()`'s existing memoisation untouched (SC-001).
5. `limits` is always `parseLlmLimits(process.env)` (L8).

### Guarantees

- Throws nothing for a configuration problem; every outcome is a value.
- Makes no provider call.
- Writes nothing.
- Is not memoised across calls, so FR-007 ("no restart, no cached staleness") holds.

## 2. `src/server/llm/config.ts` — one addition

```ts
export interface LlmLimits { timeoutMs: number; maxOutputTokens: number }

/** The install-wide call limits, independent of whether a provider is configured (L8, FR-004). */
export function parseLlmLimits(source: Source): LlmLimits;
```

`parseLlmConfig` delegates to it, so the two limits are parsed in one place. Problems from a malformed
limit keep today's behaviour: the name and reason, never the value, and the documented default is used.

`parseLlmConfig`, `llmEnvIssues` and `LLM_VARIABLES` are otherwise unchanged, and
`src/server/llm/key-reads.test.ts` still passes: the environment key names are read only here.

## 3. `src/server/llm/index.ts` — one addition, no change in meaning

```ts
/** Test-only seam: build a provider from a config, so a test can stub per key (L13). */
export function setLlmFactoryForTests(fn: ((config: LlmConfig) => LlmProvider) | null): void;
```

Precedence: `setLlmForTests` (wins everywhere, unchanged) → `setLlmFactoryForTests` → the real providers.
`getLlm()`, `getLlmStatus()` and `missingLlmSettings()` keep their exact signatures and behaviour;
`getLlmStatus()` remains the *install's* answer and is no longer consulted by a project screen (L12).

## 4. `src/server/dal/project-llm.ts` (new)

The only module that selects `api_key_encrypted` (FR-010, enforced by the guard test in L31).

```ts
export interface ProjectLlmRow {
  projectId: string;
  provider: LlmProviderName | null;
  model: string | null;
  /** Ciphertext. Never returned to a service that is not resolution. */
  apiKeyEncrypted: string | null;
  updatedAt: Date;
  updatedByUserId: string | null;
  lastCheckAt: Date | null;
  checkLeaseUntil: Date | null;
}

/** For the surface: everything except the ciphertext, plus whether one is stored. */
export interface ProjectLlmStatusRow {
  provider: LlmProviderName | null;
  model: string | null;
  hasKey: boolean;
  updatedAt: Date;
  updatedByUserId: string | null;
}

export interface ProjectLlmRepo {
  /** Resolution's read. The ciphertext is in the result; nothing else calls this. */
  read(): Promise<ProjectLlmRow | null>;
  /** The surface's read. Cannot return a ciphertext. */
  status(): Promise<ProjectLlmStatusRow | null>;
  /** Set or replace. `apiKeyEncrypted: null` keeps the stored ciphertext (FR-015, K8). */
  save(patch: {
    provider: LlmProviderName;
    model: string;
    apiKeyEncrypted: string | null;
    updatedByUserId: string | null;
  }): Promise<ProjectLlmStatusRow>;
  /** Nulls provider, model and the ciphertext; keeps the row (FR-017, L2). */
  clear(updatedByUserId: string | null): Promise<void>;
  /** The check gate (L22). `false` means refused: in flight, or inside the cooldown. */
  claimCheck(now: Date, leaseMs: number, cooldownMs: number): Promise<boolean>;
  releaseCheck(now: Date): Promise<void>;
}

export function createProjectLlmRepo(exec: Database, projectId: string): ProjectLlmRepo;

/** Once per tick, for the runner's gate (L27). Cross-project by design. */
export function anyProjectHasCredential(exec?: Database): Promise<boolean>;
```

`createProjectLlmRepo` is wired into `ProjectScope` as `scope.projectLlm`, like every other repository, so
every statement is pinned to one project id (constitution III).

## 5. `src/server/dal/credential-owners.ts` — the widening

```ts
export const INSTALL_CREDENTIAL_OWNER = "install";            // unchanged value

/** The owner of the credential a call for this project would spend (FR-024). */
export function credentialOwnerFor(projectId: string): Promise<string>;

/** The same question for many projects, in one statement (L10). */
export function credentialOwnersFor(
  projectIds: readonly string[],
  exec?: Database,
): Promise<Map<string, string>>;

/** Unchanged. */
export function jobsExcludingProjects(projectIds: readonly string[]): SQL | undefined;
```

`resolveBlockedProjectIds` (`src/server/dal/job-claims.ts`) switches to `credentialOwnersFor`, so the
number of statements inside the claim transaction stops growing with the number of projects that have
active jobs. Everything else about the claim — `gateCreditHolds`, the `FOR UPDATE SKIP LOCKED` probe, the
in-memory cap of one item per probing owner, `jobsExcludingProjects` — is **unchanged**, and with an empty
hold table the claim's SQL stays byte-identical to today's (H10, SC-001).

## 6. `src/server/dal/credit-holds.ts` — one signature change

```ts
export function clearCreditHold(owner: string, exec?: Database): Promise<void>;
```

So a save can clear the hold inside its own transaction (L25, FR-027), the way `rewindCreditProbe`
already takes an `exec`. `holdCredit`, `gateCreditHolds`, `rewindCreditProbe`, `readCreditHold`,
`readCreditHolds` and `CREDIT_PROBE_INTERVAL_MS` are unchanged.

## 7. Housekeeping

```ts
export const ORPHAN_HOLD_BATCH = 100;

/** Removes `project:<uuid>` hold rows whose project no longer exists (L28, FR-029). */
export function pruneOrphanCreditHolds(): Promise<number>;
```

Added to `HousekeepingCounts` as `orphanHoldsPruned`, through the named `crossProject` hatch the other
purges already use, one bounded batch per tick.

## 8. Invariants a reviewer can check mechanically

1. `grep -rn 'getLlm()' src scripts` finds it only in `src/server/llm/resolve.ts`,
   `src/server/llm/index.ts` and `scripts/llm-check.ts`'s no-argument path.
2. `grep -rn 'getLlmStatus()' src` finds it only in `src/server/llm/index.ts`,
   `src/server/llm/resolve.ts` and `scripts/llm-check.ts`'s no-argument path.
3. `apiKeyEncrypted` appears only in `src/server/db/schema/generation.ts`,
   `src/server/dal/project-llm.ts` and `src/server/llm/resolve.ts` — asserted by the guard test (L31).
4. `credentialOwnerFor` is no longer called from `generation/core.ts` or `series.ts`: the owner arrives on
   the resolved credential (L11).
5. `src/server/llm/key-reads.test.ts` still passes unchanged.
