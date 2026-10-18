# Contract: the shape of a metric (G38)

**Feature**: 083 | Satisfies FR-001 to FR-005, SC-007

## §1 The declaration

`src/providers/types.ts`:

```ts
export type MetricShape =
  | { kind: "cumulative" }
  /** `windowMs: null` when a window exists but its length is not fixed or not confirmed. */
  | { kind: "windowed"; windowMs: number | null }
  /** The reason is rendered where the series would otherwise be (FR-004). */
  | { kind: "unknown"; reason: string };

export interface MetricKeyDeclaration {
  key: string;
  label: string;
  shape: MetricShape;   // required — no default, no optionality
}
```

**The provider owns it.** A key's shape is declared beside the key and label, by the provider, from
`docs/research/*.md`. Nothing in `src/server/**` or `src/lib/**` may branch on a provider key to
decide a shape, and nothing may infer one from a key's name.

**The compiler is the gate.** Because `shape` is required, a provider added later cannot declare a key
without it. There is no lint rule and no registry test to forget; `pnpm typecheck` fails.

## §2 The classification is not a code decision

Every one of the 46 declared keys is classified in [../research.md](../research.md) §1.1 with a source
line. Three are `unknown`:

| Key | Reason string (rendered to members) |
|---|---|
| `page_follows` (facebook, account) | "Facebook does not state the period this number covers, so Docket cannot plot it over time." |
| `page_post_engagements` (facebook, account) | "Facebook reports this for a day, a week or 28 days and Docket's request does not pin one, so it cannot be plotted over time." |
| `monthly_views` (pinterest, account) | "Pinterest does not document the window this number covers, so Docket cannot plot it over time." |

Classifying a key MUST NOT change any request. In particular this entry does **not** pin a `period`
on Facebook's account read to make `page_post_engagements` knowable; that is a reader change
(FR-005), and the open question is recorded in `docs/research/meta.md`,
`docs/research/pinterest.md` and `docs/decisions.md`.

## §3 What each shape means downstream

`src/lib/insights/shape.ts`, pure:

```ts
/** False for `unknown`: absent from every trend, comparison and derived figure (FR-004). */
export function isPlottable(shape: MetricShape): boolean;
/** The sentence shown where an `unknown` key's series would be. */
export function shapeNote(shape: MetricShape): string | null;
```

| Shape | In a trend | In a comparison | On the existing panel |
|---|---|---|---|
| `cumulative` | a continuous value over time; a fall is drawn as a fall, never clamped (FR-013) | the latest reading per target | unchanged |
| `windowed` | one value per period, **at most one reading per project-local day** (the newest that day), never accumulated (FR-013) | the latest reading per target, with its window stated beside the figure | unchanged |
| `unknown` | **absent**, with `shapeNote` shown where the series would be (FR-004) | **absent**, counted as the `metric_shape_unknown` exclusion | **unchanged — still a latest number** (FR-004) |

The last column is the requirement most easily broken by accident: `unknown` removes a key from
*derived* views only. `buildTargetInsightsView` keeps rendering it, so the existing panel's output for
every provider is byte-identical to before this entry. `tests/integration/insights/panel.test.tsx`
asserts exactly that.

## §4 Where it is recorded

- `docs/adding-a-provider.md` — a new row in the Generic hooks index:
  `| G38 | `shape` on a `MetricKeyDeclaration` — whether a key is cumulative, windowed or unknown | 21 |`
  plus a prose section beside G33-G37.
- `docs/decisions.md` — the classification decision, the three `unknown` keys and the refusal to pin
  a period to resolve them.
- `docs/insights.md` — the member-facing consequence: Facebook Pages have no account trend, Pinterest
  has a follower trend and no monthly-views trend.
