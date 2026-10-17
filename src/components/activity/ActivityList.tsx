import { Table } from "@/components/ui/Table";
import type { ActivityRow as Row } from "@/server/services/activity";
import { ActivityRow } from "./ActivityRow";

/** Who it was for and when, which post, and what happened — the outcome and the actor ride with the message. */
export function ActivityList({ rows, showProject = false, caption }: { rows: Row[]; showProject?: boolean; caption: string }) {
  // "Open", not "Go to": the column is only as wide as an icon, and a two-word head wraps to two
  // lines in it. It also matches what the links say — "Open in Failures", "Open post".
  const columns = ["Account", "Post", "What happened", ...(showProject ? ["Project"] : []), "Open"];
  return (
    <Table caption={caption} columns={columns}>
      {rows.map((row) => (
        <ActivityRow key={row.id} row={row} showProject={showProject} />
      ))}
    </Table>
  );
}
