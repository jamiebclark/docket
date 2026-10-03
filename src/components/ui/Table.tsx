import type { ReactNode } from "react";

/** Real table markup: pass `columns` for `<th scope="col">` and rows as children. */
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
    <table className="w-full border-collapse text-left text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="border-b border-foreground/30">
          {columns.map((c) => (
            <th key={c} scope="col" className="px-3 py-2 font-medium">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <tr className="border-b border-foreground/10">{children}</tr>;
}

export function Cell({ children, header = false }: { children: ReactNode; header?: boolean }) {
  return header ? (
    <th scope="row" className="px-3 py-2 font-medium">
      {children}
    </th>
  ) : (
    <td className="px-3 py-2">{children}</td>
  );
}
