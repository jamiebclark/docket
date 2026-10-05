import type { CSSProperties, ReactNode } from "react";

/** Most columns the stacked phone layout labels (see `.stack-table` in globals.css). */
const MAX_LABELLED_COLUMNS = 10;

/**
 * Real table markup inside a card: pass `columns` for `<th scope="col">` and rows as children.
 * From `sm` up it is a normal table (scrolling sideways if it must); on phones each row stacks
 * into a card, with every cell labelled by its column name. The labels come from CSS variables
 * set here, so rows can be rendered by any component, server or client.
 */
export function Table({
  caption,
  columns,
  children,
}: {
  caption: string;
  columns: string[];
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
        <tbody className="divide-y divide-border max-sm:block">{children}</tbody>
      </table>
    </div>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <tr className="transition-colors hover:bg-muted/40 max-sm:block max-sm:py-2">{children}</tr>;
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
