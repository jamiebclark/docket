# Contract: component prop changes

No new shared component is added (FR-074). Four existing components change their props. Every other change is inside
the route pages (contracts/ui.md).

## `SchedulerHealth` (`src/components/shell/SchedulerHealth.tsx`)

```ts
props: {
  health: SchedulerHealth;
  now: Date;
  timezone: string;
  variant: "quiet" | "banner";
  viewer: { kind: "owner" } | { kind: "ask"; owners: string }; // NEW, required
}
```

| variant / state | `viewer.kind === "owner"` | `viewer.kind === "ask"` |
|---|---|---|
| quiet / ok | unchanged | unchanged (FR-062) |
| banner / ok | renders nothing | renders nothing |
| banner / stale | today's headline ("The scheduler last ran {when}. Scheduled posts are not going out."), "To fix this, do one of:" and the three remedies, then a link "How to fix this" to `docsUrl("deployment", "9-is-the-scheduler-running")` | **bold** "The scheduler last ran {when}.", then "Scheduled posts are not going out. Ask {owners} to start the scheduler." |
| banner / never | today's headline ("The scheduler has never run. Scheduled posts will not go out."), the remedies and the link | **bold** "The scheduler has never run.", then "Scheduled posts are not going out. Ask {owners} to start the scheduler." |

- The banner keeps `role="alert"` and `alertStyles("danger", true)` for everyone.
- The "ask" variant contains no `<code>`, no `docker`, no `RUN_WORKER_IN_PROCESS`, no `TICK_SECRET`, no `/api/` and
  no link.
- The docs link is an `<a target="_blank" rel="noreferrer">` with an underline, matching the existing setup-guide
  links. It's an inline link in a banner, not an empty-state action.
- **Caller**: `layout.tsx` passes `{ kind: "owner" }` when `scope.membership.role === "owner"`. Otherwise it passes
  `{ kind: "ask", owners: askOwners(await listManagers(scope), "or") }`, reading managers only when the banner will
  render (research D8). The quiet variant always gets the same `viewer` value, for simplicity, and ignores it.

## `ReauthBanner` (`src/components/shell/ReauthBanner.tsx`)

```ts
props: { accounts: ReauthAccount[]; projectSlug: string; canManage: boolean; askNames: string /* NEW */ }
```

- When `!canManage`, the last line reads "Ask {askNames} to reconnect it." for one account, or "… them." for more
  (FR-063).
- `canManage` output is unchanged.
- **Caller**: `askManagers(managers, "or")`. Managers are read only when `reauth.length > 0 && !canManage`. Otherwise
  it passes `""`, which is never rendered.

## `Composer` (`src/app/p/[projectSlug]/compose/Composer.tsx`)

```ts
interface AccountOption { /* existing fields */ hasActiveSlot?: boolean | null /* NEW */ }
props: { /* existing */ canManageSlots?: boolean /* NEW, default false */; managersToAsk?: string /* NEW, default "an owner or admin" */ }
```

- **No accounts (FR-025)**:
  - managers: the message is unchanged ("No accounts are connected yet. Connect an account to start composing
    posts."). The action is `<Link className={buttonStyles({ variant: "primary" })} href="/p/{slug}/accounts">Connect
    an account</Link>`.
  - others: "No accounts are connected yet. Ask {managersToAsk} to connect one.", with no action.
- **Action bar**: `queueSlotHint(...)` is computed from `selected`. The bar renders per research D12:

| Condition | `message` | Save draft | Publish now… | Add to queue… | Schedule… | Order |
|---|---|---|---|---|---|---|
| `blocked` | blocked reason (unchanged) | as today | disabled | disabled, `cta` | disabled | as today |
| hint `all` | hint text and link, `id={hintId}` | as today | enabled | **disabled**, `secondary`, `aria-describedby={hintId}` | enabled, **`cta`** | Save, Publish, Add to queue, **Schedule last** |
| hint `some` | note text | as today | enabled | enabled, `cta` | enabled | as today |
| hint `none` | none | as today | enabled | enabled, `cta` | enabled | as today |

- Opening a dialog still calls `save()` first, exactly as today. Nothing is saved by a disabled button, so SC-004
  holds.
- **Callers** (`compose/page.tsx`, `compose/[postId]/page.tsx`), sketched:

  ```ts
  const counts = await listSlotCounts(scope).catch(() => null);
  const byId = new Map(counts?.map((c) => [c.accountId, hasActiveSlot(c)]) ?? []);
  // accounts[i].hasActiveSlot = counts ? byId.get(id) ?? false : null
  canManageSlots = scope.can({ slot: ["manage"] });
  // managersToAsk read only when the viewer lacks account or slot manage
  managersToAsk = askManagers(await listManagers(scope), "or");
  ```

## `ConnectGroupSection` (`src/app/p/[projectSlug]/accounts/ConnectGroupSection.tsx`)

The props and markup are unchanged. The caller now renders it only for managers. Unconfigured groups are rendered
only inside the owner's disclosure. The `unavailable && !canManage` branch can no longer be reached from Accounts, but
it stays, since the component's contract is unchanged.

## `Checklist` (`src/components/ui/Checklist.tsx`)

Unchanged. Generate, both New job pages and Jobs render
`<Checklist title={PREREQUISITES_TITLE} items={generationPrerequisites(...)!} />` when the list isn't `null`.
