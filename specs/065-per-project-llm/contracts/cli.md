# Contract: the command line

**Feature**: `specs/065-per-project-llm` | Phase 1 | FR-022, K14, L24

`scripts/llm-check.ts` grows **one optional argument** and nothing else. The no-argument behaviour is
byte-identical to today, which is how SC-001 survives this file.

## 1. Invocation

```text
pnpm llm:check                             # unchanged in every respect
pnpm llm:check -- --project <slug>         # this entry
```

The argument is parsed from `process.argv` after the existing entry-point guard. `--project` without a
value, an unknown flag, or more than one `--project` is a usage error: one line to stderr and exit 2.

The `--` is documented and used everywhere, because the script is
`esbuild … && node node_modules/.cache/llm-check.mjs` and anything after `--` is appended to that last
command verbatim rather than being read by pnpm. No change to `package.json` is needed; `docs/generator.md`
shows the `--` form so nobody has to discover this.

## 2. `pnpm llm:check` (no argument) — unchanged

| Aspect | Value |
|---|---|
| Needs a database | **No.** It must keep working on an install with no `DATABASE_URL`, because hold writes are swallowed (H12/H13). |
| Unconfigured | prints `UNMEASURED_LINE` and exits **0** — an unconfigured install is not a failure |
| Configured | `provider=… model=… outcome=ok latency_ms=…`, then `job_call kind=text …`, `job_call kind=image …`, then `jobs budget_ms=… reserve_ms=… max_items_per_tick=…` |
| Owner | `withCreditHold(getLlm(), INSTALL_CREDENTIAL_OWNER)` |
| Exit | 0 on success, 1 on any failed call |

Not one character of this output changes, and `main({ llm, log })`'s test seam keeps its signature so
`scripts/llm-check.test.ts` passes untouched.

## 3. `pnpm llm:check --project <slug>`

| Aspect | Value |
|---|---|
| Needs a database | **Yes.** Without `DATABASE_URL` it prints one line naming the variable and exits 2. |
| Needs a session | **No.** The project is resolved by slug through a named `crossProject("llm:check: resolve project", …)` read — no membership, no role, no user (FR-022). |
| Unknown slug | one line, `project not found`, exit 2. No project data, no hint about other projects. |
| Work done | the **same** `checkProjectLlm` the screen calls (K14, constitution IV) — one bounded live call, nothing saved |
| Hold | through `withCreditHold(resolved.owner)`, so a billing refusal sets *that project's* hold and any other outcome clears it (FR-023) |
| `job_call` lines | **not printed**: they judge the install's tick budget, which is not a per-project fact (L24) |

### Output

One line, the existing `key=value` shape with one new field first:

```text
source=project provider=anthropic model=<model> outcome=ok latency_ms=842
source=install provider=openai   model=<model> outcome=ok latency_ms=1310
source=project provider=anthropic model=<model> outcome=auth latency_ms=210
source=install outcome=not_configured missing=LLM_PROVIDER,LLM_MODEL,OPENAI_API_KEY
source=project outcome=key_unreadable
source=project outcome=busy
```

- `source=install` when the project has no credential, which is AS 2.3's "says that is what it checked".
- `outcome` is `ok` or the `LlmFailureKind`, the same vocabulary the no-argument path prints.
- `missing=` carries setting **names** only, never values — the `EnvIssue` rule.
- **No key, no part of a key, no provider error text, no HTTP status.**

### Exit codes

| Code | When |
|---|---|
| 0 | `outcome=ok` |
| 1 | any model-call failure, `key_unreadable`, `busy` |
| 2 | usage error, missing `DATABASE_URL`, unknown slug |

FR-022's "exits non-zero on failure" is codes 1 and 2.

## 4. Scoping — one implementation, no new privilege

`checkProjectLlm(scope)` exists for the screen and asks `llm_credential: ["manage"]`. The command line has
no session, so it must **not** be given a scope at all: inventing a session-less owner-privileged scope
would create a privilege surface nothing else needs, and the lint that keeps `src/app` away from it would
be a new thing to maintain.

Instead the check is split once, and the split is the only new structure (constitution IV — one
implementation, two callers):

```ts
/** The whole check: resolve, gate, one call, release, map. Takes a project id and a pinned repo. */
export function runLlmCheck(
  projectId: string,
  repo: ProjectLlmRepo,
): Promise<LlmCheckResult>;

/** The screen's entry point: permission, then `runLlmCheck`. */
export function checkProjectLlm(scope: ProjectScope): Promise<LlmCheckResult>;
```

- The screen calls `checkProjectLlm(scope)`, which does `need(scope)` and then
  `runLlmCheck(scope.project.id, scope.projectLlm)`.
- The command line resolves the slug to an id with one named
  `crossProject("llm:check: resolve project", …)` read, then calls
  `runLlmCheck(id, createProjectLlmRepo(getDb(), id))`. Every statement is pinned to that id, so the
  scope harness passes (constitution III), and no role is asserted for a caller that has none.
- `runLlmCheck` performs **no** permission check — it is not exported from a route-reachable module and
  its only web caller is `checkProjectLlm`, which does. The guard test in L31 asserts that
  `runLlmCheck` is imported only by `check.ts`'s own sibling and `scripts/llm-check.ts`.

A check made this way writes **no audit row**: it is not a credential change (FR-018 lists set, change and
removal), and there is no actor to record.

## 5. Not added

- No flag to set, print, test or rotate a key from the command line beyond the check.
- No flag to list projects, lift a hold, or show spend.
- No new `package.json` script: `llm:check` already bundles `scripts/llm-check.ts` and passes arguments
  through `node node_modules/.cache/llm-check.mjs`.
