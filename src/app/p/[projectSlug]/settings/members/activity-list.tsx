import { LocalTime } from "@/components/ui/LocalTime";

const LABEL: Record<string, string> = {
  invite: "invited",
  invite_regenerate: "regenerated an invitation for",
  invite_revoke: "revoked the invitation for",
  invite_accept: "accepted an invitation:",
  invite_decline: "declined an invitation:",
  member_remove: "removed",
  member_leave: "left the project:",
  role_change: "changed the role of",
  ownership_transfer: "transferred ownership to",
  account_posting_instructions_update: "changed the posting instructions for",
  project_brand_update: "changed the brand",
  llm_credential_update: "changed this project's model credential",
  standing_series_create: "created the standing series",
  standing_series_update: "changed the standing series",
  account_disable: "disabled an account",
  account_enable: "enabled an account",
  standing_series_pause: "paused the standing series",
  standing_series_resume: "resumed the standing series",
  standing_series_delete: "deleted the standing series",
  standing_series_dated_import: "imported a list for the standing series",
  standing_series_dated_row_add: "added a row to the standing series",
  standing_series_dated_row_update: "changed a row of the standing series",
  standing_series_dated_row_delete: "deleted a row from the standing series",
  api_key_create: "created the API key",
  api_key_revoke: "revoked the API key",
  webhook_create: "added the webhook to",
  webhook_update: "changed the webhook to",
  webhook_delete: "deleted the webhook to",
  webhook_rotate_secret: "rotated the signing secret for the webhook to",
  webhook_enable: "enabled the webhook to",
  webhook_disable: "disabled the webhook to",
};

export interface ActivityItem {
  id: string;
  action: string;
  actor: string;
  subject: string;
  createdAt: string;
}

export function ActivityList({ items, timeZone }: { items: ActivityItem[]; timeZone: string }) {
  return (
    <section aria-labelledby="activity-heading" className="flex flex-col gap-3">
      <h2 id="activity-heading" className="text-lg font-semibold">
        Recent activity
      </h2>
      {items.length === 0 ? (
        <p className="text-sm">No activity yet.</p>
      ) : (
        <ol className="flex flex-col gap-1 text-sm">
          {items.map((i) => (
            <li key={i.id}>
              <span className="mr-2 text-muted-foreground">
                <LocalTime value={i.createdAt} timeZone={timeZone} />
              </span>
              {i.actor} {LABEL[i.action] ?? i.action} {i.subject}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
