import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { ProviderIcon } from "@/components/ui/Icon";
import { LocalTime } from "@/components/ui/LocalTime";
import { OUTCOME_LABEL, OUTCOME_TONE } from "@/lib/activity/outcomes";
import type { ActivityRow as Row } from "@/server/services/activity";

const isoString = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

/** The row's details as text, never raw JSON. */
function Details({ row }: { row: Row }) {
  const d = row.details;
  const tz = row.project.timeZone;
  const next = isoString(d.nextAttemptAt);
  const scheduled = isoString(d.scheduledAt);
  const url = typeof d.url === "string" && /^https?:\/\//i.test(d.url) ? d.url : null;
  return (
    <>
      {typeof d.attempt === "number" ? (
        <div className="text-xs text-muted-foreground">
          Attempt {d.attempt}
          {next ? (
            <>
              {" · next try "}
              <LocalTime value={next} timeZone={tz} />
            </>
          ) : null}
        </div>
      ) : null}
      {scheduled ? (
        <div className="text-xs text-muted-foreground">
          Requeued for <LocalTime value={scheduled} timeZone={tz} />
        </div>
      ) : null}
      {url ? (
        <div className="text-xs">
          <a href={url} target="_blank" rel="noopener noreferrer" className="underline">
            Link
          </a>
        </div>
      ) : null}
    </>
  );
}

export function ActivityRow({ row, showProject }: { row: Row; showProject: boolean }) {
  const platform = row.platform ?? row.platforms[0] ?? null;
  return (
    <tr className="border-b border-border align-top">
      <td className="px-2 py-2 whitespace-nowrap">
        <LocalTime value={row.occurredAt} timeZone={row.project.timeZone} />
      </td>
      <td className="px-2 py-2">
        <Badge tone={OUTCOME_TONE[row.outcome]}>{OUTCOME_LABEL[row.outcome]}</Badge>
      </td>
      <td className="px-2 py-2">
        {platform ? (
          <div className="flex items-center gap-2">
            <ProviderIcon providerKey={platform.key} size={24} />
            <div>
              <div className="font-medium">{platform.name}</div>
              {row.account ? <div className="text-xs text-muted-foreground">{row.account.name}</div> : null}
            </div>
          </div>
        ) : (
          "—"
        )}
      </td>
      <td className="px-2 py-2">
        {row.post ? (
          row.post.deleted ? (
            <span>
              Post deleted
              {row.post.excerpt ? <span className="text-muted-foreground"> · {row.post.excerpt}</span> : null}
            </span>
          ) : (
            <Link href={`/p/${row.project.slug}/posts/${row.post.id}`} className="underline">
              {row.post.excerpt || "(no text)"}
            </Link>
          )
        ) : (
          "—"
        )}
      </td>
      <td className="px-2 py-2">
        <div>{row.message}</div>
        <Details row={row} />
      </td>
      <td className="px-2 py-2">{row.actorLabel}</td>
      {showProject ? (
        <td className="px-2 py-2">
          <Link href={`/p/${row.project.slug}/activity`} className="underline">
            {row.project.name}
          </Link>
        </td>
      ) : null}
      <td className="px-2 py-2 whitespace-nowrap">
        {row.link ? (
          <Link href={row.link.href} className="underline">
            {row.link.label}
          </Link>
        ) : null}
      </td>
    </tr>
  );
}
