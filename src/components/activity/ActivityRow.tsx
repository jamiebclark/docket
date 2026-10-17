import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { cellLinkStyles, iconControlStyles } from "@/components/ui/controls";
import { Icon, ProviderIcon } from "@/components/ui/Icon";
import { LocalTime } from "@/components/ui/LocalTime";
import { Cell, Row, Sub } from "@/components/ui/Table";
import { OUTCOME_LABEL, OUTCOME_TONE } from "@/lib/activity/outcomes";
import type { ActivityRow as RowData } from "@/server/services/activity";

const isoString = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

/** The row's details as text, never raw JSON. */
function Details({ row }: { row: RowData }) {
  const d = row.details;
  const tz = row.project.timeZone;
  const next = isoString(d.nextAttemptAt);
  const scheduled = isoString(d.scheduledAt);
  const url = typeof d.url === "string" && /^https?:\/\//i.test(d.url) ? d.url : null;
  return (
    <>
      {typeof d.attempt === "number" ? (
        <Sub>
          Attempt {d.attempt}
          {next ? (
            <>
              {" · next try "}
              <LocalTime value={next} timeZone={tz} />
            </>
          ) : null}
        </Sub>
      ) : null}
      {scheduled ? (
        <Sub>
          Requeued for <LocalTime value={scheduled} timeZone={tz} />
        </Sub>
      ) : null}
      {url ? (
        <div className="text-xs">
          <a href={url} target="_blank" rel="noopener noreferrer" className={cellLinkStyles}>
            Link
          </a>
        </div>
      ) : null}
    </>
  );
}

export function ActivityRow({ row, showProject }: { row: RowData; showProject: boolean }) {
  const platform = row.platform ?? row.platforms[0] ?? null;
  // Who it happened to and when it happened answer one question, so they share a cell: the account
  // on top, the time under it, rather than a thin "When" column beside a thin "Account" one.
  const when = (
    <Sub>
      <span className="whitespace-nowrap">
        <LocalTime value={row.occurredAt} timeZone={row.project.timeZone} />
      </span>
    </Sub>
  );
  return (
    <Row>
      <Cell>
        {platform ? (
          <div className="flex items-start gap-2">
            <ProviderIcon providerKey={platform.key} size={24} />
            <div className="min-w-0">
              <div>{platform.name}</div>
              {row.account ? <Sub>{row.account.name}</Sub> : null}
              {when}
            </div>
          </div>
        ) : (
          when
        )}
      </Cell>
      <Cell>
        {row.post ? (
          row.post.deleted ? (
            <span>
              Post deleted
              {row.post.excerpt ? <Sub>{row.post.excerpt}</Sub> : null}
            </span>
          ) : (
            <Link href={`/p/${row.project.slug}/posts/${row.post.id}`} className={`line-clamp-3 ${cellLinkStyles}`}>
              {row.post.excerpt || "(no text)"}
            </Link>
          )
        ) : null}
      </Cell>
      <Cell>
        <Badge tone={OUTCOME_TONE[row.outcome]}>{OUTCOME_LABEL[row.outcome]}</Badge>
        <div className="mt-0.5">{row.message}</div>
        <Details row={row} />
        <Sub>by {row.actorLabel}</Sub>
      </Cell>
      {showProject ? (
        <Cell>
          <Link href={`/p/${row.project.slug}/activity`} className={cellLinkStyles}>
            {row.project.name}
          </Link>
        </Cell>
      ) : null}
      <Cell>
        {row.link ? (
          <Link href={row.link.href} title={row.link.label} className={iconControlStyles}>
            <Icon name="arrowRight" />
            <span className="sr-only">{row.link.label}</span>
          </Link>
        ) : null}
      </Cell>
    </Row>
  );
}
