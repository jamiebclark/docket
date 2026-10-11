import Link from "next/link";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Cell, Row, Sub, Table } from "@/components/ui/Table";
import type { JobItemView } from "@/server/services/jobs";
import { RetryButton } from "./RetryButtons";

/** Why an item is not a post yet: the failure message, or the reason it was skipped. */
function Detail({ slug, item }: { slug: string; item: JobItemView }) {
  if (item.status === "failed" && item.error) return <Sub>{item.error.message}</Sub>;
  if (item.status === "skipped" && item.skipped)
    return (
      <Sub>
        {item.skipped.reason}
        {item.skipped.postId ? (
          <>
            {" "}
            <Link href={`/p/${slug}/posts/${item.skipped.postId}`} className="underline">
              View post
            </Link>
          </>
        ) : null}
      </Sub>
    );
  return null;
}

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
    <Table caption="Job items" columns={["Item", "Status", "Post", "Actions"]}>
      {items.map((item) => (
        <Row key={item.id}>
          <Cell header>
            <span className="flex items-center gap-2">
              {item.media?.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.media.thumbnailUrl} alt={item.media.altText} width={40} height={40} className="h-10 w-10 rounded object-cover" />
              ) : null}
              <span className="min-w-0">
                <span>{item.label}</span>
                <Sub>#{item.position + 1}</Sub>
              </span>
            </span>
          </Cell>
          <Cell>
            <StatusBadge status={item.status} />
            <Sub>
              {item.attemptCount} {item.attemptCount === 1 ? "attempt" : "attempts"}
            </Sub>
            <Detail slug={slug} item={item} />
          </Cell>
          <Cell>
            {item.post ? (
              <>
                <Link href={`/p/${slug}/posts/${item.post.id}`} className="underline">
                  View post
                </Link>
                <Sub>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge status={item.post.reviewState} />
                    <StatusBadge status={item.post.status} />
                  </span>
                </Sub>
              </>
            ) : null}
          </Cell>
          <Cell>{canRetry && item.status === "failed" ? <RetryButton slug={slug} jobId={jobId} itemId={item.id} /> : null}</Cell>
        </Row>
      ))}
    </Table>
  );
}
