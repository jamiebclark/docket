# Contract — the Batch jobs screens

What the two screens render while a hold covers the viewer's project, and what must be identical when there
is none. Follows the `docket-ui` skill and `docs/design-system.md`; adds no `src/components/ui/` primitive.

## 1. The notice component

```tsx
// src/app/p/[projectSlug]/jobs/JobNotice.tsx  (NEW, server component)
/**
 * The shape the job page's two existing notices already use: a `role="note"` paragraph with a warning
 * border. Deliberately not `Alert`, whose `warning` tone defaults to `role="alert"` and would be announced
 * more aggressively than today's notices (FR-026).
 */
export function JobNotice({ children }: { children: ReactNode }) {
  return <p role="note" className="rounded-md border border-warning-border p-3 text-sm">{children}</p>;
}
```

```tsx
// src/app/p/[projectSlug]/jobs/CreditHoldNotice.tsx  (NEW, server component)
/** The billing pause, named honestly, with when it started in the project's zone (FR-022). */
export function CreditHoldNotice({ since, timeZone }: { since: Date; timeZone: string }) { … }
```

Both are server components. Neither takes `"use client"`, neither reads the database, and neither receives
anything about the credential beyond an instant.

## 2. The wording

Fixed strings in `src/lib/jobs/credit-hold.ts` (pure, so one unit test owns them and nothing drifts):

```ts
export const CREDIT_HOLD_CAUSE =
  "Generation is paused: the model provider refused the last request because the account has no credit or quota left.";
export const CREDIT_HOLD_WAITING =
  "Queued items are waiting — none of them has failed, and nobody needs to retry them.";
export const CREDIT_HOLD_RESUME =
  "They resume by themselves within a few minutes of credit being restored.";
export const CREDIT_HOLD_ACTION =
  "Add credit to the provider account.";
/** The label before the instant; the instant itself goes through LocalTime (one date format). */
export const CREDIT_HOLD_SINCE_LABEL = "Paused since";
```

Rendered as one notice:

> Generation is paused: the model provider refused the last request because the account has no credit or
> quota left. Paused since Sat, Oct 11, 2:05 PM EDT. Queued items are waiting — none of them has failed, and
> nobody needs to retry them. They resume by themselves within a few minutes of credit being restored. Add
> credit to the provider account.

Every clause FR-022 demands, in order: the cause **named as billing**; since when; waiting and **not**
failed; resumes automatically and no retry needed; what the operator must do.

What the wording must never contain (FR-027, FR-032): an API key or any part of one, the provider's own error
text, a provider account identifier or email, the credential owner value, a request id, the provider name, or
a count of refused calls.

## 3. The Batch jobs list — `src/app/p/[projectSlug]/jobs/page.tsx`

```tsx
const hold = await generationCreditHold(scope);
…
<PageHeader … />
{prerequisites ? <SetupNotice … /> : null}
{hold ? <CreditHoldNotice since={hold.since} timeZone={scope.project.timezone} /> : null}
{items.length === 0 ? … }
```

| Rule | |
|---|---|
| placement | after the page header and the existing prerequisites notice, before the table or the empty state |
| shown when | a hold covers the viewer's project — **regardless of whether any job is queued**, because a hold is install-wide operator state and the list is where someone looks first |
| not shown when | there is no hold; then the page is byte-identical to `main` (FR-026, SC-007) |
| the table | unchanged. Per-status counts already count a waiting item as `queued`, so the "Items" cell reads e.g. `12 in total · 3 done · 9 queued` with nothing failed (FR-024) |
| `StatusBadge` | unchanged; the job's status stays `queued`/`running` (FR-025) |

## 4. A job's page — `src/app/p/[projectSlug]/jobs/[jobId]/page.tsx`

The three notices sit together, in this order, each independently gated and each through `JobNotice`:

```tsx
{active && !llm.configured ? <JobNotice>Generation is not configured, so these items are waiting. Set: …</JobNotice> : null}
{active && !job.jobsRunnable.ok ? <JobNotice>Jobs cannot run: {job.jobsRunnable.message}</JobNotice> : null}
{active && job.creditHold ? <CreditHoldNotice since={job.creditHold.since} timeZone={tz} /> : null}
```

| Rule | |
|---|---|
| shown when | `active` (`queued` or `running`) **and** a hold covers the project — the same gate the two existing notices use |
| coexistence | all three can render at once without repeating each other (FR-023). Not configured comes first because it is the more fundamental problem; a not-configured install never reaches the gate anyway, so in practice the pair is rare |
| clearing itself | the page is `export const dynamic = "force-dynamic"` with `<AutoRefresh active intervalMs={5000} />`, so lifting the hold removes the notice on the next 5 s refresh with no manual reload and no new polling (FR-023, US3 AS4) |
| routing the existing two through `JobNotice` | produces identical markup to `main`, so no existing assertion or snapshot moves |
| the counts `<dl>`, `LiveRegion`, `FilterTabs`, `Pagination`, the action row | unchanged. "Retry failed items" still appears only when `c.failed > 0`, so a hold does not offer it |

## 5. The waiting item row — `JobItemsTable.tsx`

```tsx
function Detail({ slug, item }: { slug: string; item: JobItemView }) {
  if (item.status === "failed" && item.error) return <Sub>{item.error.message}</Sub>;
  if (item.status === "queued" && item.error?.kind === "credit_exhausted") return <Sub>{item.error.message}</Sub>; // NEW
  if (item.status === "skipped" && item.skipped) return …;
  return null;
}
```

| Rule | |
|---|---|
| status cell | `StatusBadge status="queued"` → reads **"Queued"**. No new badge, no new status, no colour-only signal (FR-024, FR-025) |
| reason | the kind's one fixed sentence as a `Sub` line, beside the existing `"N attempts"` line — which still reads the same number as before the refusal (FR-007) |
| actions cell | empty: the retry control is already `canRetry && item.status === "failed"`, so a queued item is offered nothing (FR-024) |
| scope of the change | only `queued` **and** `credit_exhausted`. A `queued` item carrying an older `rate_limited` or `internal` error renders exactly as it does today (SC-007) |
| the "Failed" filter tab | unaffected: a waiting item is not `failed`, so it is not in that tab |

## 6. Accessibility and keyboard (FR-026)

| Requirement | How |
|---|---|
| conveyed as text, not colour | every clause is text; the warning border only reinforces it. The row's state is the word "Queued" plus a sentence |
| full keyboard use, visible focus | the notices contain no control, so they add nothing to the tab order and remove nothing from it. The page's existing links, tabs and buttons are untouched |
| reachable with assistive technology | a `<p role="note">` in the normal document flow, inside `<main>`, read in reading order; no `aria-hidden`, no off-screen text |
| announced no more aggressively than today | `role="note"` is not a live region and is not announced on insertion — exactly what the two existing notices do. `LiveRegion`'s existing `"N done, N failed, N queued"` message is unchanged, so the auto-refresh announces no more than it does now |
| one date format | the instant renders through `<LocalTime>` in the project's zone, with the full date in `title` — so `tests/lint/date-format.test.ts` stays green |
| server components | both new components are server components; no `"use client"` is added anywhere |
| contrast | `border-warning-border` and the default text token, already checked by `scripts/check-contrast.mjs`; no new colour and no `dark:` variant |
| five columns or fewer | the items table keeps its four columns; the reason is a `Sub` line inside the existing Status cell, not a new column |

## 7. Roles

Every role that can already view Batch jobs (`post: ["view"]` — owner, admin and editor) sees the notice,
with identical wording (FR-027). No role sees more: the payload is one instant. Nothing about the notice is
gated on `generation: ["run"]`, because it explains why nothing is happening rather than offering an action.

## 8. Test contract — `tests/integration/jobs/ui.test.tsx`

Rendered with `renderToStaticMarkup`, as the file already does:

1. **List, held**: the markup contains each of the five fixed strings and the formatted instant; `role="note"`
   is present once.
2. **Job page, held and active**: the same, beside the existing notices when they also apply; and a job whose
   status is `completed` or `cancelled` shows **no** hold notice.
3. **Waiting row**: a `queued` item with `credit_exhausted` shows the fixed sentence, shows `Queued`, and the
   row's Actions cell contains no retry control; its attempt count is the number it had before the refusal.
4. **Counts**: the job page's `Failed` figure is `0` and `Queued` includes the waiting items.
5. **Not held**: both screens' markup is identical to the same render with the hold row deleted — and the
   existing assertions in this file pass unchanged.
6. **Auto-refresh**: `AutoRefresh` is still rendered with `active` and `intervalMs={5000}`; deleting the hold
   row and re-rendering removes the notice (US3 AS4).
7. **Roles**: rendered as an editor as well as the owner, both see it (FR-027).
8. **No secret**: with `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` set to a distinctive value and a billing refusal
   whose body echoes it, neither screen's markup contains the value, any provider error text or the owner
   value (FR-032, SC-006). Also covered by the scanned run in
   `tests/integration/security/secret-scan.test.ts`.
