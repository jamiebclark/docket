import { NotificationSwitch } from "@/components/notifications/NotificationSwitch";
import { Cell, DetailRow, Row, RowGroup, Sub, Table } from "@/components/ui/Table";
import { platformsOffNote, projectOffText } from "@/lib/notifications/text";
import type { ProjectPreferenceRow } from "@/server/services/notifications";

const COLUMNS = ["Project", "Failed", "Needs your decision", "Needs reconnecting", "Connect failed", "This project"];

/**
 * `/notifications`'s "Projects" card, one `RowGroup` per project with its four kind switches, the
 * project-level controls and a platforms disclosure (contracts/ui.md §2, FR-015, Q19).
 */
export function NotificationPreferenceGrid({
  rows,
  action,
}: {
  rows: ProjectPreferenceRow[];
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <Table caption="Notifications for each of your projects" columns={COLUMNS} grouped>
      {rows.map((row) => {
        const offPlatforms = row.platforms.filter((p) => !p.on);
        const onCount = row.platforms.length - offPlatforms.length;
        return (
          <RowGroup key={row.slug} span={COLUMNS.length}>
            <Row>
              <Cell header>
                {row.name}
                {!row.on ? <Sub>{projectOffText()}</Sub> : null}
                {row.on && offPlatforms.length > 0 ? <Sub>{platformsOffNote(offPlatforms.map((p) => p.label))}</Sub> : null}
              </Cell>
              {row.kinds.map((k) => (
                <Cell key={k.key}>
                  <NotificationSwitch
                    action={action}
                    projectSlug={row.slug}
                    projectName={row.name}
                    axis="kind"
                    switchKey={k.key}
                    label={k.label}
                    on={k.on}
                  />
                </Cell>
              ))}
              <Cell>
                <div className="flex items-center gap-2">
                  <NotificationSwitch action={action} projectSlug={row.slug} projectName={row.name} axis="project" label="" on={true} />
                  <NotificationSwitch action={action} projectSlug={row.slug} projectName={row.name} axis="project" label="" on={false} />
                </div>
              </Cell>
            </Row>
            <DetailRow span={COLUMNS.length}>
              <details>
                <summary>
                  Platforms ({onCount} of {row.platforms.length} on) — {row.name}
                </summary>
                {row.platforms.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">This project has no connected accounts yet.</p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {row.platforms.map((p) => (
                      <NotificationSwitch
                        key={p.key}
                        action={action}
                        projectSlug={row.slug}
                        projectName={row.name}
                        axis="platform"
                        switchKey={p.key}
                        label={p.label}
                        on={p.on}
                      />
                    ))}
                  </div>
                )}
              </details>
            </DetailRow>
          </RowGroup>
        );
      })}
    </Table>
  );
}
