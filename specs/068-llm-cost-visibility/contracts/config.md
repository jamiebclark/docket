# Contract: rate configuration

**Feature**: `068-llm-cost-visibility` | Covers **FR-009** – **FR-013**, **M8** – **M11**,
**P8** – **P12**.

Docket ships with **no rates**. It contains no provider's prices, infers none, and fetches none.
Every number here is the operator's.

---

## 1. The two variables

Added to `.env.example` under the existing `# --- Generator (LLM) ---` group (the group order test
in `tests/lint/env-coverage.test.ts` requires it stays in that group), and to a new
`LLM_RATE_VARIABLES` array in `src/server/llm/config.ts` — **not** to `LLM_VARIABLES` (**P9**).

### `LLM_RATES`

```
# Optional. Per-token prices you believe you are paying, so the Usage screen can show an estimated
# upper bound. Docket ships no prices and never fetches any: whatever you put here is what it shows.
# One entry per model, separated by spaces or commas:
#   <provider>:<model>=<input price>/<output price>
# Prices are per million tokens, in LLM_RATE_CURRENCY, up to 6 decimal places. 0 is allowed and
# means zero. A model you do not list keeps showing calls and tokens, with no money at all.
# Any problem anywhere in this value is logged by name and the whole value is ignored.
# No default. Estimated spend is off when unset.
# LLM_RATES=openai:your-model-id=0.25/2.00 anthropic:another-model-id=3.00/15.00
```

### `LLM_RATE_CURRENCY`

```
# Optional. Required when LLM_RATES is set. A three-letter currency code, shown verbatim beside
# every estimate. Docket does no conversion and has no exchange-rate source, so one code covers the
# whole install.
# No default.
# LLM_RATE_CURRENCY=USD
```

Both must carry a `Required.`/`Optional.` marker, a ≥20-character description and a
`Default …`/`No default.` line, or `tests/lint/env-coverage.test.ts` fails.

## 2. Grammar

```
LLM_RATES      := entry ( separator+ entry )*
separator      := " " | "\t" | ","
entry          := provider ":" model "=" price "/" price
provider       := "openai" | "anthropic"
model          := 1..200 characters, no whitespace          -- split at the FIRST ":"
price          := digits [ "." digits{1,6} ]                -- no sign, no exponent; prices split at the LAST "="
LLM_RATE_CURRENCY := [A-Za-z]{3}                            -- upper-cased on parse, displayed verbatim
```

Splitting at the first `:` and the last `=` keeps a model id containing either character parseable.
Whitespace is a safe separator because no model string may contain one — `parseLlmConfig` and the
`project_llm_settings_model_shape` CHECK both forbid it (**P10**).

## 3. `parseLlmRates(source): LlmRates`

Pure, in `src/server/llm/rates.ts`. Never throws. Returns `{ entries, currency, problems }`.

| Input | `entries` | `currency` | `problems` |
|---|---|---|---|
| neither variable set | `[]` | `null` | `[]` |
| `LLM_RATES` valid, currency valid | parsed | the code | `[]` |
| `LLM_RATES` valid, currency **absent** | `[]` | `null` | `LLM_RATE_CURRENCY: required when LLM_RATES is set` |
| `LLM_RATES` valid, currency malformed | `[]` | `null` | `LLM_RATE_CURRENCY: must be three letters` |
| any entry malformed | `[]` | `null` | `LLM_RATES: <reason>` |
| duplicate `(provider, model)` | `[]` | `null` | `LLM_RATES: names the same provider and model twice` |
| negative / non-numeric / >6 decimals | `[]` | `null` | `LLM_RATES: prices must be numbers with at most 6 decimal places` |
| unknown provider | `[]` | `null` | `LLM_RATES: provider must be openai or anthropic` |
| currency set, rates absent, currency malformed | `[]` | `null` | `LLM_RATE_CURRENCY: must be three letters` |
| currency set, rates absent, currency valid | `[]` | `null` | `[]` |

**Rejection is total** (**FR-011**): one bad entry discards the whole table. A half-applied rate
table is worse than none.

**Reasons never carry a value** — the existing `EnvIssue` discipline. A price is not a secret, but
one rule with no exceptions is easier to keep than a rule with one.

`getLlmRates()` memoises `parseLlmRates(process.env)` the way `getEnv()` memoises the env, and is
never evaluated at import (`next build` must work without configuration).

## 4. Startup behaviour (FR-011, P8)

`ConfigValidation` gains `warnings: EnvIssue[]`. `validateConfiguration` puts
`parseLlmRates(source).problems` there and **never** in `issues`.

```
runStartup:
  for each warning:   log  "Docket: <name>: <reason>"
  if no rates usable: disabled line  "estimated spend is off (LLM_RATES not set or not usable)"
```

The process **does not exit**. Generation, jobs, the scheduler tick and every other screen are
untouched — a malformed price must never stop an install from publishing (**US2 scenario 5**).

`tests/lint/env-coverage.test.ts`'s "the validator reports a malformed value of every checked
variable by name" probe is extended to accept a name in `issues` **or** `warnings`, and
`CONFIGURABLE` gains `LLM_RATE_VARIABLES`. The rate variables are **not** added to that test's
`ACCEPTED_AS_IS` set: a malformed value must still be named (**FR-032**'s spirit — extend, never
exempt).

## 5. Lookup and arithmetic

```ts
/** Exact, case-sensitive match on both. Never matches by provider alone (FR-010). */
function rateFor(rates: LlmRates, provider: string, model: string): ModelRate | null;

/** Exact integers; BigInt because tokens × price overflows a double at real volumes (P12). */
function estimateMicros(tokens: number, microsPerMillion: number): number;

/** "12.34 USD"; "under 0.01 USD" when non-zero but rounding to zero; "0.00 USD" for a zero rate. */
function formatMoney(micros: number, currency: string): string;
```

- Null token counts contribute nothing — they are excluded before the arithmetic, never zeroed
  (**M3**, **FR-017**).
- A model with no rate contributes nothing to any total and is named in it (**FR-021**,
  **FR-022**).
- `Intl.NumberFormat` with `style: "currency"` is **not** used: a shaped-but-unassigned code throws
  (**P11**). The amount is grouped with `toLocaleString("en-US")`, the house convention, and the
  code follows it as plain text.
- Nothing computed here is ever written to a usage row (**FR-013**, **M10**). Correcting
  `LLM_RATES` and reloading changes every past period's estimate with no migration and no write
  (**SC-007**).
