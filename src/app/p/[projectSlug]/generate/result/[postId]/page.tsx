import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LocalTime } from "@/components/ui/LocalTime";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { GenerationRecord } from "@/lib/validation/generation";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as accounts from "@/server/services/accounts";
import * as posts from "@/server/services/posts";
import { RegenerateDialog } from "./RegenerateDialog";
import { VariantEditor } from "./VariantEditor";
import type { VariantCard } from "./variant-logic";

export const metadata: Metadata = { title: "Generated post" };
export const dynamic = "force-dynamic";

export default async function ResultPage({ params }: { params: Promise<{ projectSlug: string; postId: string }> }) {
  const { projectSlug, postId } = await params;
  let scope;
  let detail;
  try {
    scope = await forProject(await getSession(), projectSlug);
    detail = await posts.getPost(scope, postId);
  } catch (error) {
    if (error instanceof NotFoundError || (error instanceof Error && ["ZodError", "ForbiddenError"].includes(error.name))) notFound();
    throw error;
  }
  const records = ((detail.post.generationMetadata as { records?: GenerationRecord[] } | null)?.records ?? []) as GenerationRecord[];
  const record = records.at(-1);
  if (!record) notFound();

  const timeZone = scope.project.timezone;
  const byAccount = new Map((await accounts.listAccounts(scope)).map((a) => [a.id, a]));
  const live = detail.targets.filter((t) => t.status !== "cancelled");
  const cards: VariantCard[] = [];
  for (const t of live) {
    const a = byAccount.get(t.accountId);
    if (!a) continue;
    let card = cards.find((c) => c.providerKey === a.providerKey);
    if (!card) {
      card = { providerKey: a.providerKey, providerName: a.providerName, accountIds: [], accountNames: [], text: t.overrideText ?? detail.post.baseText };
      cards.push(card);
    }
    card.accountIds.push(a.id);
    card.accountNames.push(a.displayName);
  }

  const locked = live.some((t) => t.status !== "draft");
  const queuedTargets = live.filter((t) => t.status === "scheduled" && t.scheduledAt);
  const decision = record.policies.decision;
  const decisionText =
    detail.post.reviewState === "approved" && queuedTargets.length > 0
      ? null
      : `${detail.post.reviewState === "approved" ? "Approved" : "In review"}: ${decision?.reason ?? ""}`.trim();
  const remaining = record.remainingProblems.flatMap((p) => p.messages.map((m) => `${p.providerKey}: ${m}`));

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Generated post</h1>
        <StatusBadge status={detail.post.status} />
      </div>
      <p className="text-sm" data-testid="decision">
        {decisionText ?? (
          <>
            Approved and queued:{" "}
            {queuedTargets.map((t, i) => (
              <span key={t.id}>
                {i > 0 ? "; " : ""}
                {byAccount.get(t.accountId)?.displayName} <LocalTime value={t.scheduledAt!} timeZone={timeZone} />
              </span>
            ))}
          </>
        )}
      </p>
      {remaining.length > 0 ? (
        <ul className="list-disc pl-5 text-sm text-danger">
          {remaining.map((m) => (
            <li key={m}>Error: {m}</li>
          ))}
        </ul>
      ) : null}

      <VariantEditor
        slug={projectSlug}
        postId={postId}
        cards={cards}
        mediaIds={detail.mediaIds}
        canEdit={scope.can({ post: ["edit"] }) && !locked}
      />

      <div className="flex flex-wrap items-center gap-3">
        {locked ? (
          <p className="text-sm">Unschedule to regenerate.</p>
        ) : scope.can({ generation: ["run"], post: ["edit"] }) ? (
          <RegenerateDialog slug={projectSlug} postId={postId} />
        ) : null}
        <Link href={`/p/${projectSlug}/posts/${postId}`} className="text-sm underline">
          Open in posts
        </Link>
        <Link href={`/p/${projectSlug}/generate`} className="text-sm underline">
          Generate another
        </Link>
      </div>

      <details className="max-w-2xl text-sm">
        <summary className="cursor-pointer font-medium">Generation details</summary>
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt>Provider</dt>
          <dd>{record.provider}</dd>
          <dt>Model</dt>
          <dd>{record.model}</dd>
          <dt>Voice profile</dt>
          <dd>
            {record.voiceProfile.name}, version {record.voiceProfile.version}
          </dd>
          <dt>Latency</dt>
          <dd>{record.attempts.map((a) => `${a.latencyMs} ms`).join(", ")}</dd>
          <dt>Retried</dt>
          <dd>{record.retried ? `Yes (${record.retried.reason.replaceAll("_", " ")})` : "No"}</dd>
        </dl>
      </details>
    </section>
  );
}
