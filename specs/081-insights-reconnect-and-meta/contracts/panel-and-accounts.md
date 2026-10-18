# Contract — the panel's new states and the accounts page's new line

[plan.md](../plan.md) · 080's [panel.md](../../080-insights-core-bluesky/contracts/panel.md) ·
FR-025, FR-026, FR-027, FR-035, FR-042

---

## §1 `buildTargetInsightsView` — four new states, two insertion points

```ts
export type TargetInsightsView =
  | { state: "not_published" }
  | { state: "platform_unsupported"; providerName: string }
  | { state: "unavailable"; reason: string; docsPath?: string }
  // NEW, immediately after `unavailable` and before `no_external_id` (FR-025):
  | { state: "permission_not_requested"; reason: string; docsPath?: string }
  | { state: "needs_reconnect"; reason: string; docsPath?: string; canReconnect: boolean }
  | { state: "no_external_id" }
  | { state: "unqueryable"; reason: string; snapshot: Snapshot | null }      // NEW (FR-036)
  | { state: "gone"; snapshot: Snapshot | null }
  | { state: "expired"; snapshot: Snapshot | null }                          // NEW (FR-042)
  | { state: "failing"; since: Date; reason: string; snapshot: Snapshot | null }
  | { state: "not_polled_yet"; firstReadDueAt: Date | null }
  | { state: "nothing_reported"; capturedAt: Date }
  | { state: "reported"; capturedAt: Date; rows: MetricRow[] };
```

The input gains one field — `permission: InsightsPermission | null` — produced by the one pure helper
(granted-scopes.md §4). The decision table's new rows, in order:

| After | New branch | Emits |
|---|---|---|
| `declaration.unavailable` | `permission.kind === "not_requested"` | `permission_not_requested` |
| that | `permission.kind === "not_granted"` | `needs_reconnect` with `canReconnect` |
| `pollState.frozenReason === "gone"` | `=== "unqueryable"` | `unqueryable` + whatever snapshots exist |
| that | `=== "expired"` | `expired` + whatever snapshots exist |

**Why the permission branches go before `no_external_id`.** An account that may not be read is the
*larger* truth about a target: telling a member "this post has no external id" when the real reason
Docket shows no numbers is a missing permission sends them to debug the wrong thing. FR-025 fixes the
order for exactly this reason.

**Why `expired` and `unqueryable` go after `gone` but before `failing`.** They are terminal states
about the *subject*, and the existing `failing` branch tests `consecutiveFailures > 0`. A target
frozen for either reason has its failure counters cleared when it is frozen
(scheduler-insights-081.md §3), so the ordering is belt-and-braces — but it must be this way round,
or a target that failed once before being frozen would render as a permanent failure that nothing
will ever retry.

**Neither permission state renders a number, a dash or a zero** (FR-025). Both carry only a reason
and a docs path. `expired` and `unqueryable` *do* carry snapshots, because numbers captured while the
subject lived are real and final (FR-042).

## §2 Rendering (`src/components/targets/PerformancePanel.tsx`)

| State | What a person sees |
|---|---|
| `permission_not_requested` | "Docket has not been given permission to read Instagram's numbers." + guide link. **No reconnect control** — nothing a member can do; it is an operator's change (US1-AS3) |
| `needs_reconnect`, `canReconnect: true` | the provider's reason, naming the missing permission, + guide link |
| `needs_reconnect`, `canReconnect: false` | the Login-for-Business reason: add it to the Meta Login configuration, + guide link (FR-019) |
| `expired` | every snapshot captured while it lived, with its "as of" time, **plus** "This story has expired; these numbers are final." **No failure styling** (US5-AS4) |
| `unqueryable` | the provider's reason ("published as a video id…"), plus any snapshots. Not a failure (US7-AS3) |

- The reconnect control on the panel is **not** added — the accounts page owns reconnecting, and the
  panel links there. FR-026 puts the control on the accounts page and nowhere else.
- **One block per account, no aggregate anywhere** (FR-034, US4). The panel is already per-target;
  the four-platform test asserts the labels, the per-account grouping, and the *absence* of any
  total, average or combined figure. With Facebook, Instagram and Threads all able to say "Views"
  (research §2), this test is now load-bearing rather than defensive.
- **Absent stays absent** (FR-035). `rowsFor` already emits a row only for a declared key whose value
  is a `number`, so a metric the response omitted, or returned with an empty value list, produces no
  row. Unchanged; asserted again for the three new providers, including the empty-`values` case.
- Server component, keyboard reachable, heading order preserved, `docket-ui` conventions — unchanged
  from 080.

## §3 The accounts page (FR-026, FR-027)

`AccountView` gains `insightsPermission` (data-model §6), computed in
`src/server/services/accounts.ts` from the stored grant, the provider's declaration and the group's
`optionalScopes` — so the page renders a decision it did not make.

Rendered beside the existing per-account notes, **after** `notes` and **before** the reconnect
controls:

```
Insights need a reconnect
<the provider's reason, naming the missing permission>        [Set up insights →]
[Reconnect Facebook Pages and Instagram]        ← only when canReconnect
```

Three rules, each a test:

1. **Shown only for `not_granted`** (FR-026). `not_requested` shows nothing on the accounts page:
   the install is not asking, so there is nothing for a member to act on, and a line saying so on
   every Meta account of every install that has not opted in would be noise bordering on a nag
   (US1-AS4 asserts its absence).
2. **The reconnect button only when `canReconnect`** (FR-019, US3-AS3). It is the **existing**
   `ReconnectGroupButton`, already used for `needs_reauth`, with no change — which also means the
   existing "paste a new token" and credentials-form fallbacks are untouched.
3. **The status badge, publishing and the scheduler are untouched** (FR-027). The badge still comes
   from `status` alone, `needs_reauth` is not used for this and not set by it, and a test asserts an
   ineligible account's `status` is still `active` and that it still publishes. An account that can
   publish perfectly well but cannot read insights **is not broken**, and marking it broken would
   both lie and change what the scheduler does with it.

`canManage` governs the reconnect button exactly as it does today; the reason line follows the page's
existing view permission. **No new statement in `src/server/auth/access.ts`** (spec decision).

## §4 Where the panel's permission comes from

`getPostView` (`src/server/services/posts/view.ts`) already loads each target's account to build
`PostViewTarget`. It gains `grantedScopes` on that read and calls `insightsPermissionFor` once per
target, with `requestedScopes` and `cannotWiden` resolved from the provider's connect group against
`process.env`. **No new query** — one more column on a row already being read, and one pure call.

The group lookup is per provider key and is memoised for the request, so a post with four targets
does not parse the environment four times.
