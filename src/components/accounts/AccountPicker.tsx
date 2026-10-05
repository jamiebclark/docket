"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { Icon, ProviderIcon } from "@/components/ui/Icon";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { controlStyles, errorStyles, hintStyles } from "@/components/ui/controls";

export interface PickableAccount {
  id: string;
  displayName: string;
  providerKey: string;
  providerName: string;
  status: string;
  /** Why the account can't be chosen right now (shown on the card), or null/undefined when it can. */
  unavailableReason?: string | null;
}

/** Above this many accounts the picker shows a filter box. */
export const ACCOUNT_FILTER_THRESHOLD = 8;

/** Accounts whose name or platform contains every typed word. */
export function filterAccounts<T extends PickableAccount>(accounts: readonly T[], query: string): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...accounts];
  return accounts.filter((a) => {
    const hay = `${a.displayName} ${a.providerName}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/**
 * Many-of-many account choice as selectable cards: platform mark, account name, platform and status,
 * with the reason on any card that can't be chosen. Each card is a native checkbox (Space toggles,
 * Tab moves), so it works with forms and screen readers as a plain checkbox list does. Past
 * `ACCOUNT_FILTER_THRESHOLD` accounts a filter box appears; "Select all" acts on what is shown.
 */
export function AccountPicker({
  legend,
  hint,
  accounts,
  value,
  onChange,
  error,
  disabled = false,
  idPrefix,
  legendClassName = "text-sm font-semibold text-foreground",
  showStatus = "problems",
}: {
  legend: ReactNode;
  hint?: ReactNode;
  accounts: readonly PickableAccount[];
  value: readonly string[];
  onChange: (ids: string[]) => void;
  error?: string;
  disabled?: boolean;
  /** Prefix for input ids (`<prefix>-acct-<accountId>`), so labels and tests can address a card. */
  idPrefix?: string;
  /** Lets a card-style fieldset (the composer) style the legend as its title. */
  legendClassName?: string;
  /** `problems` shows a status badge only when an account is not connected; `always` on every card. */
  showStatus?: "always" | "problems";
}) {
  const uid = useId();
  const prefix = idPrefix ?? uid;
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterAccounts(accounts, query), [accounts, query]);
  const pickable = (a: PickableAccount) => !disabled && !a.unavailableReason;
  const shownPickable = shown.filter(pickable);
  const allShownChosen = shownPickable.length > 0 && shownPickable.every((a) => value.includes(a.id));
  const hintId = `${prefix}-accounts-hint`;
  const errorId = `${prefix}-accounts-error`;

  const toggle = (id: string, on: boolean) => onChange(on ? [...value.filter((x) => x !== id), id] : value.filter((x) => x !== id));
  const toggleShown = () =>
    onChange(
      allShownChosen
        ? value.filter((id) => !shownPickable.some((a) => a.id === id))
        : [...new Set([...value, ...shownPickable.map((a) => a.id)])],
    );

  return (
    <fieldset
      className="flex min-w-0 flex-col gap-3"
      aria-describedby={[hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined}
      aria-invalid={error ? true : undefined}
    >
      <legend className={legendClassName}>{legend}</legend>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {hint ? (
          <p id={hintId} className={hintStyles}>
            {hint}
          </p>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-3 text-xs">
          <span className="text-muted-foreground tabular-nums" aria-live="polite">
            {value.length} of {accounts.length} selected
          </span>
          {shownPickable.length > 1 ? (
            <button
              type="button"
              onClick={toggleShown}
              className="rounded font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {allShownChosen ? (query ? "Clear shown" : "Clear all") : query ? "Select shown" : "Select all"}
            </button>
          ) : null}
        </div>
      </div>

      {accounts.length > ACCOUNT_FILTER_THRESHOLD ? (
        <div className="relative">
          <label htmlFor={`${prefix}-accounts-filter`} className="sr-only">
            Filter accounts
          </label>
          <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
          <input
            id={`${prefix}-accounts-filter`}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by account or platform"
            className={`${controlStyles} pl-9`}
          />
        </div>
      ) : null}

      <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((a) => {
          const id = `${prefix}-acct-${a.id}`;
          const whyId = a.unavailableReason ? `${id}-why` : undefined;
          const checked = value.includes(a.id);
          const off = disabled || !!a.unavailableReason;
          return (
            <li key={a.id} className="min-w-0">
              <label
                htmlFor={id}
                className={`group relative flex h-full items-start gap-3 rounded-xl border p-3 transition-colors has-focus-visible:ring-2 has-focus-visible:ring-focus has-focus-visible:ring-offset-2 ${
                  checked ? "border-primary bg-accent/40 shadow-[inset_0_0_0_1px_var(--primary)]" : "border-border bg-surface hover:border-primary/50 hover:bg-muted/40"
                } ${off ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
              >
                <input
                  id={id}
                  type="checkbox"
                  checked={checked}
                  disabled={off}
                  aria-describedby={whyId}
                  onChange={(e) => toggle(a.id, e.target.checked)}
                  className="peer sr-only"
                />
                <ProviderIcon providerKey={a.providerKey} size={36} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-semibold text-foreground">{a.displayName}</span>
                  <span className="truncate text-xs text-muted-foreground">{a.providerName}</span>
                  {showStatus === "always" || a.status !== "active" ? (
                    <span className="mt-1">
                      <StatusBadge status={a.status} />
                    </span>
                  ) : null}
                  {a.unavailableReason ? (
                    <span id={whyId} className="mt-1 text-xs text-muted-foreground">
                      {a.unavailableReason}
                    </span>
                  ) : null}
                </span>
                <span
                  aria-hidden="true"
                  className={`flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                    checked ? "border-primary bg-primary text-primary-foreground" : "border-input bg-surface text-transparent"
                  }`}
                >
                  <Icon name="check" size={13} className="stroke-[3]" />
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {shown.length === 0 ? <p className="text-sm text-muted-foreground">No accounts match “{query}”.</p> : null}
      {error ? (
        <p id={errorId} aria-live="polite" className={errorStyles}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
