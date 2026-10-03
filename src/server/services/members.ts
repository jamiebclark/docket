import { z } from "zod";
import { roles, type Role } from "@/server/auth/access";
import { ConflictError, ForbiddenError, LastOwnerError, NotFoundError } from "@/server/dal/errors";
import type { AuditRow } from "@/server/dal/audit";
import type { MemberRow } from "@/server/dal/members";
import type { ProjectScope } from "@/server/dal/scope";
import { recordAudit } from "./audit";

const userIdSchema = z.object({ userId: z.uuid() });
const changeRoleSchema = userIdSchema.extend({ role: z.enum(["owner", "admin", "editor"], { error: "Choose a role" }) });

export interface MemberView extends MemberRow {
  isSelf: boolean;
  canChangeRole: boolean;
  canRemove: boolean;
  canTransfer: boolean;
  canLeave: boolean;
}

function asRole(value: string): Role {
  if (!(value in roles)) throw new Error("Unexpected role");
  return value as Role;
}

/** Members of the project with the actions the caller may take on each row. */
export async function list(scope: ProjectScope): Promise<MemberView[]> {
  if (!scope.can({ member: ["view"] })) throw new ForbiddenError();
  const rows = await scope.members.list();
  return rows.map((row) => {
    const isSelf = row.userId === scope.membership.userId;
    const targetIsOwner = row.role === "owner";
    return {
      ...row,
      isSelf,
      canChangeRole: !isSelf && scope.can({ member: ["update_role"] }),
      canRemove: !isSelf && scope.can({ member: targetIsOwner ? ["remove", "remove_owner"] : ["remove"] }),
      canTransfer: !isSelf && scope.can({ member: ["transfer_ownership"] }),
      canLeave: isSelf,
    };
  });
}

export async function recentActivity(scope: ProjectScope, limit = 50): Promise<AuditRow[]> {
  if (!scope.can({ audit: ["view"] })) throw new ForbiddenError();
  return scope.audit.list({ limit });
}

/** Changing your own role is deliberately not offered: owners use transfer, others ask an owner. */
export async function changeRole(scope: ProjectScope, input: unknown): Promise<void> {
  const { userId, role } = changeRoleSchema.parse(input);
  if (!scope.can({ member: ["update_role"] })) throw new ForbiddenError();
  await scope.transaction(
    async (tx) => {
      if (!tx.can({ member: ["update_role"] })) throw new ForbiddenError();
      const target = await tx.members.find(userId);
      if (!target) throw new NotFoundError();
      if (target.role === role) return;
      if (target.role === "owner" && (await tx.members.countOwners()) <= 1) throw new LastOwnerError();
      await tx.members.updateRole(userId, role);
      await recordAudit(tx, {
        action: "role_change",
        actorUserId: tx.membership.userId,
        subjectUserId: userId,
        details: { from: target.role, to: role },
      });
    },
    { lockProject: true },
  );
}

export async function remove(scope: ProjectScope, input: unknown): Promise<void> {
  const { userId } = userIdSchema.parse(input);
  if (!scope.can({ member: ["remove"] })) throw new ForbiddenError();
  await scope.transaction(
    async (tx) => {
      if (userId === tx.membership.userId) {
        throw new ConflictError("You can't remove yourself. Leave the project instead.");
      }
      if (!tx.can({ member: ["remove"] })) throw new ForbiddenError();
      const target = await tx.members.find(userId);
      if (!target) throw new NotFoundError();
      if (target.role === "owner") {
        if (!tx.can({ member: ["remove_owner"] })) throw new ForbiddenError();
        if ((await tx.members.countOwners()) <= 1) throw new LastOwnerError();
      }
      await tx.members.delete(userId);
      await recordAudit(tx, {
        action: "member_remove",
        actorUserId: tx.membership.userId,
        subjectUserId: userId,
        details: { role: target.role },
      });
    },
    { lockProject: true },
  );
}

export async function leave(scope: ProjectScope): Promise<void> {
  await scope.transaction(
    async (tx) => {
      const self = tx.membership;
      if (self.role === "owner" && (await tx.members.countOwners()) <= 1) {
        throw new LastOwnerError("You are the only owner. Transfer ownership before leaving.");
      }
      await tx.members.delete(self.userId);
      await recordAudit(tx, {
        action: "member_leave",
        actorUserId: self.userId,
        subjectUserId: self.userId,
        details: { role: self.role },
      });
    },
    { lockProject: true },
  );
}

/** Target becomes owner and the actor becomes admin, atomically. If the target already owns, only the actor is demoted. */
export async function transferOwnership(scope: ProjectScope, input: unknown): Promise<void> {
  const { userId } = userIdSchema.parse(input);
  if (!scope.can({ member: ["transfer_ownership"] })) throw new ForbiddenError();
  await scope.transaction(
    async (tx) => {
      if (!tx.can({ member: ["transfer_ownership"] })) throw new ForbiddenError();
      if (userId === tx.membership.userId) throw new ConflictError("Choose another member to transfer ownership to.");
      const target = await tx.members.find(userId);
      if (!target) throw new NotFoundError();
      if (target.role !== "owner") await tx.members.updateRole(userId, "owner");
      await tx.members.updateRole(tx.membership.userId, "admin");
      await recordAudit(tx, {
        action: "ownership_transfer",
        actorUserId: tx.membership.userId,
        subjectUserId: userId,
        details: { targetPreviousRole: asRole(target.role), actorNewRole: "admin" },
      });
    },
    { lockProject: true },
  );
}
