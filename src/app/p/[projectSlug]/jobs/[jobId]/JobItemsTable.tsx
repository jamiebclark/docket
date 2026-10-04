import Link from "next/link";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Cell, Row, Table } from "@/components/ui/Table";
import type { JobItemView } from "@/server/services/jobs";
import { RetryButton } from "./RetryButtons";

export function JobItemsTable({
  slug,
  jobId,
  items,
  canRetry,
}: {
  slug: string;
  jobId: string;
  items: JobItemView[];
  canRetry: boolean;
}) {
  return (
    <Table caption="Job items" columns={["#", "Item", "Status", "Attempts", "Post", "Error", "Actions"]}>
      {items.map((item) => (
        <Row key={item.id}>
          <Cell>{item.position + 1}</Cell>
          <Cell>
            <span className="flex items-center gap-2">
              {item.media?.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.media.thumbnailUrl} alt={item.media.altText} width={40} height={40} className="h-10 w-10 rounded object-cover" />
              ) : null}
              <span>{item.label}</span>
            </span>
          </Cell>
          <Cell>
            <StatusBadge status={item.status} />
          </Cell>
          <Cell>{item.attemptCount}</Cell>
          <Cell>
            {item.post ? (
              <span className="flex flex-wrap items-center gap-2">
                <Link href={`/p/${slug}/posts/${item.post.id}`} className="underline">
                  View post
                </Link>
                <StatusBadge status={item.post.reviewState} />
                <StatusBadge status={item.post.status} />
              </span>
            ) : null}
          </Cell>
          <Cell>{item.status === "failed" && item.error ? item.error.message : null}</Cell>
          <Cell>{canRetry && item.status === "failed" ? <RetryButton slug={slug} jobId={jobId} itemId={item.id} /> : null}</Cell>
        </Row>
      ))}
    </Table>
  );
}
