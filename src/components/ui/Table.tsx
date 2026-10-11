import type { CSSProperties, ReactNode } from "react";

/** Most columns the stacked phone layout labels (see `.stack-table` in globals.css). */
const MAX_LABELLED_COLUMNS = 10;

/**
 * Real table markup inside a card: pass `columns` for `<th scope="col">` and rows as children.
 * From `sm` up it is a normal table (scrolling sideways if it must); on phones each row stacks
 * into a card, with every cell labelled by its column name. The labels come from CSS variables
 * set here, so rows can be rendered by any component, server or client.
 *
 * Keep tables to **five columns or fewer** — facts that answer the same question share a cell
 * and stack with `Sub`, rather than each claiming a column of its own (design system §7).
 *
 * `grouped` leaves the `<tbody>` to the caller, for rows that come in labelled groups or carry
 * a full-width detail row: supply `RowGroup`s instead of `Row`s.
 */
export function Table({
  caption,
  columns,
  grouped = false,
  children,
}: {
  caption: string;
  columns: string[];
  grouped?: boolean;
  children: ReactNode;
}) {
  const labels = Object.fromEntries(
    columns.slice(0, MAX_LABELLED_COLUMNS).map((c, i) => [`--col-${i + 1}`, JSON.stringify(c)]),
  ) as CSSProperties;
  return (
    <div className="rounded-xl border border-border bg-surface shadow-card sm:overflow-x-auto">
      <table style={labels} className="stack-table w-full border-collapse text-left text-sm max-sm:block">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-muted/60 max-sm:sr-only">
          <tr className="border-b border-border">
            {columns.map((c) => (
              <th key={c} scope="col" className="px-4 py-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        {grouped ? children : <tbody className="divide-y divide-border max-sm:block">{children}</tbody>}
      </table>
    </div>
  );
}

export function Row({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <tr id={id} className="scroll-mt-[calc(var(--sticky-top)+1rem)] transition-colors hover:bg-muted/40 max-sm:block max-sm:py-2">
      {children}
    </tr>
  );
}

export function Cell({ children, header = false }: { children: ReactNode; header?: boolean }) {
  return header ? (
    <th scope="row" className="px-4 py-3 align-top font-medium max-sm:block max-sm:pt-2 max-sm:pb-1 max-sm:text-base">
      {children}
    </th>
  ) : (
    <td className="px-4 py-3 align-top max-sm:flex max-sm:items-start max-sm:gap-3 max-sm:px-4 max-sm:py-1.5">
      <div className="min-w-0 max-sm:flex-1">{children}</div>
    </td>
  );
}

/**
 * A secondary line inside a cell — the qualifier that used to be a column of its own ("3 attempts",
 * the platform under an account name, when a post was meant to go out). Quiet and one step smaller
 * than the cell's first line, so a cell reads top-down instead of the table growing sideways.
 */
export function Sub({ children }: { children: ReactNode }) {
  return <div className="mt-0.5 text-xs text-muted-foreground">{children}</div>;
}

/**
 * A `<tbody>` of rows that belong together: one subject's `Row` plus any `DetailRow`, optionally
 * under a `heading` naming the group (`<th scope="rowgroup">`). Use inside `<Table grouped>`.
 */
export function RowGroup({
  id,
  heading,
  span,
  children,
}: {
  id?: string;
  heading?: ReactNode;
  /** Number of columns the heading row spans — pass the table's column count. */
  span?: number;
  children: ReactNode;
}) {
  return (
    <tbody id={id} className="border-t border-border first-of-type:border-t-0 max-sm:block">
      {heading ? (
        <tr className="bg-muted/60 max-sm:block">
          <th scope="rowgroup" colSpan={span} className="px-4 py-2 text-left font-medium max-sm:block">
            {heading}
          </th>
        </tr>
      ) : null}
      {children}
    </tbody>
  );
}

/** A full-width row under its `Row`, for a detail panel that needs the whole table width. */
export function DetailRow({ span, children }: { span?: number; children: ReactNode }) {
  return (
    <tr className="max-sm:block">
      <td colSpan={span} className="px-4 pb-3 max-sm:block max-sm:px-4">
        {children}
      </td>
    </tr>
  );
}
