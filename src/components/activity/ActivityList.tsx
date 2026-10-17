import { Table } from "@/components/ui/Table";
import type { ActivityRow as Row } from "@/server/services/activity";
import { ActivityRow } from "./ActivityRow";

/** Who it was for and when, which post, and what happened — the outcome and the actor ride with the message. */
export function ActivityList({ rows, showProject = false, caption }: { rows: Row[]; showProject?: boolean; caption: string }) {
  const columns = ["Account", "Post", "What happened", ...(showProject ? ["Project"] : []), "Go to"];
  return (
    <Table caption={caption} columns={columns}>
      {rows.map((row) => (
        <ActivityRow key={row.id} row={row} showProject={showProject} />
      ))}
    </Table>
  );
}
