import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as invitations from "@/server/services/invitations";
import * as membersService from "@/server/services/members";
import { ActivityList } from "./activity-list";
import { InvitationsPanel } from "./invitations-panel";
import { MembersPanel } from "./members-panel";

export const metadata: Metadata = { title: "Members & invitations" };
export const dynamic = "force-dynamic";

export default async function MembersPage({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  const session = await getSession();
  let scope;
  try {
    scope = await forProject(session, projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const memberList = await membersService.list(scope);
  const names = new Map(memberList.map((m) => [m.userId, m.name]));
  const nameOf = (id: string | null, email?: string | null) =>
    (id ? names.get(id) : undefined) ?? email ?? "a former member";
  const activity = scope.can({ audit: ["view"] }) ? await membersService.recentActivity(scope, 50) : null;

  const canViewInvitations = scope.can({ invitation: ["view"] });
  const list = canViewInvitations ? await invitations.listForProject(scope) : [];
  const canOwner = scope.can({ invitation: ["create_owner"] });

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-2xl font-semibold">Members &amp; invitations</h1>
      <MembersPanel
        slug={scope.project.slug}
        members={memberList.map((m) => ({
          userId: m.userId,
          name: m.name,
          email: m.email,
          role: m.role,
          joinedAt: m.joinedAt.toISOString(),
          isSelf: m.isSelf,
          canChangeRole: m.canChangeRole,
          canRemove: m.canRemove,
          canTransfer: m.canTransfer,
          canLeave: m.canLeave,
        }))}
      />
      {canViewInvitations ? (
        <InvitationsPanel
          slug={scope.project.slug}
          canInvite={scope.can({ invitation: ["create"] })}
          canInviteOwner={canOwner}
          invitations={list.map((i) => ({
            id: i.id,
            email: i.email,
            role: i.role,
            status: i.status,
            inviterName: i.inviterName,
            expiresAt: i.expiresAt.toISOString(),
            canManage: i.role === "owner" ? canOwner : true,
          }))}
        />
      ) : null}
      {activity ? (
        <ActivityList
          items={activity.map((a) => ({
            id: a.id,
            action: a.action,
            actor: nameOf(a.actorUserId),
            subject: nameOf(a.subjectUserId, a.subjectEmail),
            createdAt: a.createdAt.toISOString(),
          }))}
        />
      ) : null}
    </div>
  );
}
