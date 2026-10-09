import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { getStorage } from "@/server/storage";
import * as accounts from "@/server/services/accounts";
import * as media from "@/server/services/media";
import * as posts from "@/server/services/posts";
import { Composer } from "../Composer";

export const metadata: Metadata = { title: "Edit post" };
export const dynamic = "force-dynamic";

export default async function EditPostPage({ params }: { params: Promise<{ projectSlug: string; postId: string }> }) {
  const { projectSlug, postId } = await params;
  let scope;
  let detail;
  try {
    scope = await forProject(await getSession(), projectSlug);
    detail = await posts.getPost(scope, postId);
  } catch (error) {
    // A malformed id is a ZodError from the service; to the visitor it is simply not found.
    if (error instanceof NotFoundError || (error instanceof Error && error.name === "ZodError")) notFound();
    throw error;
  }
  const list = await accounts.listAccounts(scope);
  // Deleted images drop out of the picker; the next save removes them from the post.
  const initialMedia = (await Promise.all(detail.mediaIds.map((id) => media.getMedia(scope, id).catch(() => null)))).filter(
    (m) => m !== null,
  );
  const videoEdits = Object.fromEntries(await scope.posts.listVideoEdits(detail.post.id));
  const live = detail.targets.filter((t) => t.status !== "cancelled");
  return (
    <Composer
      slug={projectSlug}
      timeZone={scope.project.timezone}
      accounts={list.map(({ id, displayName, providerKey, providerName, status, providerAvailable }) => ({
        id,
        displayName,
        providerKey,
        providerName,
        status,
        providerAvailable,
      }))}
      canManageAccounts={scope.can({ account: ["manage"] })}
      canEdit={scope.can({ post: ["edit"] })}
      canSchedule={scope.can({ post: ["schedule"] })}
      mediaEnabled={getStorage() !== null}
      initialMedia={initialMedia}
      initial={{
        postId: detail.post.id,
        baseText: detail.post.baseText,
        mediaIds: detail.mediaIds,
        videoEdits,
        targets: live.map((t) => ({
          accountId: t.accountId,
          overrideText: t.overrideText,
          postType: t.chosenPostType ?? null,
          posting: t.postingFields ?? undefined,
          // The check compares this with the post as it stands, so a stale record shows unticked.
          consentFingerprint: t.consentFingerprint,
        })),
        editable: !detail.targets.some((t) => ["publishing", "published", "ambiguous"].includes(t.status)),
        reviewBlocked: detail.post.reviewState === "needs_review",
      }}
    />
  );
}
