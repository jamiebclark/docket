import type { ActivityRow as Row } from "@/server/services/activity";
import { ActivityRow } from "./ActivityRow";

export function ActivityList({ rows, showProject = false, caption }: { rows: Row[]; showProject?: boolean; caption: string }) {
  const columns = ["When", "Outcome", "Platform and account", "Post", "What happened", "By", ...(showProject ? ["Project"] : []), "Go to"];
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border">
            {columns.map((c) => (
              <th key={c} scope="col" className="px-2 py-2 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <ActivityRow key={row.id} row={row} showProject={showProject} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
