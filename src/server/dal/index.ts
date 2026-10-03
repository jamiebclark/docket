// The sanctioned surface: application code imports from here, never the database client.
export { databaseIsHealthy } from "./health";
export * from "./errors";
export { crossProject, forProject, requirePermission, requireRole } from "./scope";
export type { ApprovalPolicy, PermissionRequest, ProjectScope, Role, SchedulingPolicy, SessionLike } from "./scope";
export type { AuditEntry, AuditRow, MembershipAction } from "./audit";
export { bootstrapFirstUser, isSetupAvailable } from "./install";
export type { FirstUserInput } from "./install";
export { createProject, listMyProjects, getProject } from "./projects";
export type { NewProject, ProjectRecord, ProjectSummary } from "./projects";
export type { MemberRow, MembersRepo } from "./members";
export type { InvitationRow, InvitationsRepo, InvitationStatus, ProjectTx } from "./invitations";
export type { TokensRepo } from "./tokens";
export type { AccountRecord, AccountsRepo, UpsertConnected } from "./accounts";
export type { SlotRow, SlotsRepo } from "./slots";
export type { MediaRepo, MediaRow, NewMedia } from "./media";
export type { NewPost, PostPatch, PostRecord, PostsRepo } from "./posts";
export type {
  EffectiveContent,
  NewTarget,
  TargetGuard,
  TargetPatch,
  TargetRecord,
  TargetsRepo,
  TargetStatus,
} from "./targets";
export type { AttemptEntry, AttemptOutcome, AttemptRow, AttemptsRepo } from "./attempts";
export { now, runAtTime } from "./clock";
export { closeDb } from "../db/client";
export { readHeartbeats, writeHeartbeat } from "./heartbeats";
export type { Heartbeat } from "./heartbeats";
export { schemaIsReady } from "./schema-ready";
export {
  claimDueTargets,
  claimRefreshAccounts,
  forSchedulerProject,
  recordWithLease,
  releaseLease,
} from "./scheduler";
