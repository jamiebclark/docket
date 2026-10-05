import type { ReactNode } from "react";

/** Real table markup inside a card: pass `columns` for `<th scope="col">` and rows as children. Scrolls sideways on narrow screens. */
export function Table({
  caption,
  columns,
  children,
}: {
  caption: string;
  columns: string[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-card">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-muted/60">
          <tr className="border-b border-border">
            {columns.map((c) => (
              <th key={c} scope="col" className="px-4 py-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <tr className="transition-colors hover:bg-muted/40">{children}</tr>;
}

export function Cell({ children, header = false }: { children: ReactNode; header?: boolean }) {
  return header ? (
    <th scope="row" className="px-4 py-3 align-top font-medium">
      {children}
    </th>
  ) : (
    <td className="px-4 py-3 align-top">{children}</td>
  );
}
