import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterTabs } from "@/components/ui/FilterTabs";
import { LocalTime } from "@/components/ui/LocalTime";
import { Cell, Row, Table } from "@/components/ui/Table";
import { listVoiceProfiles } from "@/server/services/voice";
import { scopeOrNotFound } from "./scope";

export const metadata: Metadata = { title: "Voice" };
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ projectSlug: string }>;
  searchParams?: Promise<{ archived?: string }>;
};

export default async function VoicePage({ params, searchParams }: Props) {
  const { projectSlug } = await params;
  const archived = (await searchParams)?.archived === "1";
  const scope = await scopeOrNotFound(projectSlug);
  const manage = scope.can({ voice: ["manage"] });
  const base = `/p/${projectSlug}/voice`;
  const profiles = await listVoiceProfiles(scope, { includeArchived: archived });

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Voice</h1>
        {manage ? (
          <Link href={`${base}/new`} className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background">
            New voice profile
          </Link>
        ) : null}
      </div>
      <FilterTabs
        label="Profiles"
        tabs={[
          { label: "Active", href: base, active: !archived },
          { label: "Include archived", href: `${base}?archived=1`, active: archived },
        ]}
      />
      {profiles.length === 0 ? (
        <EmptyState
          message={
            manage
              ? "No voice profile yet. Create one so generated posts sound like you."
              : "No voice profile yet. Ask an owner or admin to create one."
          }
          action={manage ? <Link href={`${base}/new`} className="text-sm underline">Create a voice profile</Link> : undefined}
        />
      ) : (
        <Table caption="Voice profiles" columns={manage ? ["Name", "Default", "Version", "Updated", "Actions"] : ["Name", "Default", "Version", "Updated"]}>
          {profiles.map((p) => (
            <Row key={p.id}>
              <Cell header>
                <Link href={`${base}/${p.id}`} className="underline">
                  {p.name}
                </Link>
                {p.archived ? " (archived)" : ""}
              </Cell>
              <Cell>{p.isDefault ? <Badge tone="success">Default</Badge> : null}</Cell>
              <Cell>Version {p.currentVersion}</Cell>
              <Cell>
                <LocalTime value={p.updatedAt} timeZone={scope.project.timezone} />
              </Cell>
              {manage ? (
                <Cell>
                  <Link href={`${base}/${p.id}`} className="underline">
                    Edit {p.name}
                  </Link>
                </Cell>
              ) : null}
            </Row>
          ))}
        </Table>
      )}
    </section>
  );
}
