import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LocalTime } from "@/components/ui/LocalTime";
import { Cell, Row, Table } from "@/components/ui/Table";
import { NotFoundError } from "@/server/dal";
import { getVersion, getVoiceProfile, listVersions } from "@/server/services/voice";
import { scopeOrNotFound } from "../../scope";

export const metadata: Metadata = { title: "Voice profile history" };
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ projectSlug: string; profileId: string }>;
  searchParams?: Promise<{ v?: string }>;
};

function Show({ label, value }: { label: string; value: string }) {
  return value ? (
    <div>
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="whitespace-pre-wrap text-sm">{value}</dd>
    </div>
  ) : null;
}

export default async function VoiceHistoryPage({ params, searchParams }: Props) {
  const { projectSlug, profileId } = await params;
  const wanted = Number((await searchParams)?.v);
  const scope = await scopeOrNotFound(projectSlug);
  let profile, versions, selected;
  try {
    ({ profile } = await getVoiceProfile(scope, profileId));
    versions = await listVersions(scope, profileId);
    if (Number.isInteger(wanted) && wanted > 0) selected = await getVersion(scope, profileId, wanted).catch(() => undefined);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const base = `/p/${projectSlug}/voice/${profileId}`;
  const c = selected?.content;
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{profile.name}: history</h1>
      <Link href={base} className="text-sm underline">
        Back to the profile
      </Link>
      <Table caption="Versions" columns={["Version", "Author", "Saved"]}>
        {versions.map((v) => (
          <Row key={v.id}>
            <Cell header>
              <Link href={`${base}/history?v=${v.version}`} className="underline">
                Version {v.version}
              </Link>
            </Cell>
            <Cell>{v.authorName ?? "Unknown"}</Cell>
            <Cell>
              <LocalTime value={v.createdAt} timeZone={scope.project.timezone} />
            </Cell>
          </Row>
        ))}
      </Table>
      {selected && c ? (
        <section aria-label={`Version ${selected.version}`} className="flex max-w-2xl flex-col gap-3">
          <h2 className="text-lg font-semibold">Version {selected.version} (read only)</h2>
          <dl className="flex flex-col gap-3">
            <Show label="Voice and tone" value={c.voiceAndTone} />
            <Show label="Audience" value={c.audience} />
            <Show label="Topics and pillars" value={c.topicsAndPillars} />
            <Show label="Avoid" value={c.avoid} />
            <Show label="Example posts" value={c.examplePosts.join("\n\n")} />
            <Show label="Links" value={c.preferredLinks.map((l) => (l.label ? `${l.label}: ${l.url}` : l.url)).join("\n")} />
            <Show label="Hashtags" value={c.preferredHashtags.map((t) => `#${t}`).join(" ")} />
            <Show
              label="Platform guidance"
              value={Object.entries(c.platformGuidance).map(([k, v]) => `${k}: ${v}`).join("\n")}
            />
          </dl>
        </section>
      ) : null}
    </section>
  );
}
