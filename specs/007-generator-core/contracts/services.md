# Contract: services (`src/server/services/`)

Every function takes a `ProjectScope` first and checks permissions with `scope.can(...)` on the server, again inside the transaction (the existing `need(tx, …)` pattern). Input is `unknown` and parsed with Zod. Errors are the existing DAL classes (`NotFoundError`, `ForbiddenError`, `ConflictError`, `ValidationIssuesError`) plus `LlmNotConfiguredError` and `PolicyNotAllowedError`. None of these modules imports UI code or knows its caller (FR-019). Jobs and the public API will call the same functions later, passing the same inputs.

## Permissions (`src/server/auth/access.ts`)

```ts
statements += { voice: ["view", "manage"], generation: ["run", "auto_approve"] }
owner, admin += { voice: ["view", "manage"], generation: ["run", "auto_approve"] }
editor       += { voice: ["view"],           generation: ["run"] }
```

## Policy (`services/generation/policy.ts`)

### decidePolicy

```ts
export interface PolicyDecision { reviewState: "needs_review" | "approved"; queue: boolean; reason: string }
export function decidePolicy(input: { approval: ApprovalPolicy; scheduling: SchedulingPolicy; blocking: { providerKey: string; message: string }[] }): PolicyDecision;
```

| approval | scheduling | blocking issues | → reviewState | queue | reason |
|---|---|---|---|---|---|
| review_required | leave_as_draft | none | needs_review | false | "Review required by policy" |
| review_required | add_to_queue | none | needs_review | false (applied on approval) | "Review required by policy" |
| auto_approve | leave_as_draft | none | approved | false | "Approved automatically" |
| auto_approve | add_to_queue | none | approved | true | "Approved and queued automatically" |
| any | any | ≥ 1 | needs_review | false | "Forced to review: {first message}" (e.g. "Forced to review: Instagram needs an image") |

### resolvePolicies

```ts
export function resolvePolicies(scope: ProjectScope, req: { approval?: ApprovalPolicy | null; scheduling?: SchedulingPolicy | null; confirmUnreviewedQueue?: boolean }):
  { requested: {...}; resolved: { approval: ApprovalPolicy; scheduling: SchedulingPolicy } };
```

- A missing or null value uses `scope.project.default*`.
- An override with `approval === "auto_approve"` that differs from the default needs `generation: ["auto_approve"]`. Otherwise it throws the new `PolicyNotAllowedError` (in `dal/errors.ts`) with the message "Only owners and admins can auto-approve" and `field: "approval"` (FR-026, SC-010). `failFromError` maps it to `forbidden` and **keeps** its message: it is added to `ERROR_NAME_TO_CODE` and to the keeps-message list, because generic `ForbiddenError` text stays generic.
- A resolved `auto_approve` + `add_to_queue` without `confirmUnreviewedQueue === true` throws a `ZodError`-shaped validation error on field `confirmUnreviewedQueue`: "Confirm that posts will be approved and queued without review." (FR-027).
- It is called **before** any model call, so a refused request generates nothing.

### applyApprovalPolicy

```ts
export async function applyApprovalPolicy(scope: ProjectScope, postId: string, resolved: { approval; scheduling }): Promise<{ decision: PolicyDecision; queued: TargetResult<PlannedTime>[] }>;
```

1. Run `prepareVariants(scope, postId)` (no transaction).
2. Open a transaction, lock the post, and refuse unless `review_state === "needs_review"`.
3. Collect blocking issues from `gate()` for each live target (status `draft`). Only `validation` failures count as blocking. `account_unavailable` is not a content problem and does not force review; it is reported per target by queueing.
4. Call `decidePolicy`.
5. If the result is approved, set `review_state = "approved"`, `reviewed_at = now` and `reviewed_by_user_id = NULL` (an automatic approval).
6. If `queue` is true, call `queueTargetsInTx(tx, post, targets)` (research D15).
7. Run `applyDerivedStatus`, then write `decision` into the latest generation record.

## Posts service changes (`services/posts/index.ts`)

- **New** `queueTargetsInTx(tx, post, targets, opts?)`: the unchanged body of today's `addToQueue` after `lockPost`. `addToQueue` keeps its signature and calls it. Its tests stay green with no edits.
- `queueableGate` also refuses `post.reviewState === "rejected"` with "This post was rejected."
- `REVIEW` and `createSchema` accept `rejected`. `setReviewState` refuses `rejected`; only `rejectPost` sets it.
- `createSchema` gains `generationRequestId?`, `schedulingPolicy?`, `seriesId?` and `seriesPosition?`. These are used only by the generation service; the composer never sends them.
- `listPosts` accepts `status: "rejected"`, and `counts()` includes it.
- `validateTargetContent(tx, account: Pick<AccountRecord, "providerKey">, …)` narrows its type only (research D24).

## Generation core (`services/generation/core.ts`)

```ts
export interface CoreRequest {
  label: string;
  voice: { content: VoiceContent };
  providerKeys: string[];              // distinct, ordered
  assets: MediaRow[];                  // ordered; [] for Try it
  inputs: Omit<GenerationInputs, "targetAccountIds" | "mediaAssetIds">;
}
export type CoreOutcome =
  | { ok: true; output: { variants: Record<string, string>; imageAltTexts: string[] | null };
      remainingProblems: { providerKey: string; messages: string[] }[];
      prompt: { system: string; user: string; images: { mediaAssetId: string; mode: "url" | "bytes" }[] };
      attempts: GenerationRecord["attempts"]; retried: GenerationRecord["retried"]; provider; model }
  | { ok: false; kind: LlmFailureKind; message: string; attempts: …; provider; model };
export async function runGeneration(scope: ProjectScope, req: CoreRequest, llm: LlmProvider = getLlm()): Promise<CoreOutcome>;
```

The algorithm (FR-015, FR-016, SC-004):

1. Prepare the images (`imagesForModel`). On failure, throw `ConflictError(message)` before any call.
2. Call 1. If the result is not ok and its kind is one of `invalid_output | refused | incomplete | timeout`, go to step 4 with those problems. Any other failure kind returns `ok: false` immediately, with no retry.
3. Run `checkGenerationOutput`. With no blocking problems, return ok.
4. Call 2, with `retry: { previousOutput: rawText ?? "", problems }`.
5. If call 2 is unreadable or failed, return `ok: false` with its kind. If it is readable, run the check again and return ok with `remainingProblems`, which may be non-empty.

There are never more than two model calls. The fake's `remaining()` and request count are asserted in tests.

## Single mode (`services/generation/single.ts`)

```ts
export const generateSingleSchema = z.object({
  requestId: z.uuid(),
  voiceProfileId: z.uuid(),
  brief: z.string().trim().min(1, { error: "Write a brief" }).max(2000, { error: "The brief can be at most 2,000 characters" }),
  sourceText: z.string().max(50_000, { error: "Source text can be at most 50,000 characters" }).nullish(),
  instructions: z.string().max(2000, { error: "Instructions can be at most 2,000 characters" }).nullish(),
  targetAccountIds: z.array(z.uuid()).min(1, { error: "Choose at least one account" }).max(50),   // distinct
  mediaIds: z.array(z.uuid()).max(POST_MEDIA_MAX).default([]),
  approval: approvalPolicySchema.nullish(),
  scheduling: schedulingPolicySchema.nullish(),
  confirmUnreviewedQueue: z.boolean().default(false),
});
export type GenerateResult =
  | { ok: true; postId: string; decision: PolicyDecision; queued: TargetResult<PlannedTime>[]; remainingProblems: …; existing: boolean }
  | { ok: false; failureId: string; kind: LlmFailureKind; message: string };
export async function generateSingle(scope: ProjectScope, input: unknown, llm?: LlmProvider): Promise<GenerateResult>;
```

1. Check `need(scope, { generation: ["run"], post: ["edit"] })`, run `resolvePolicies`, and check the media count against the most permissive selected platform's `maxImages`.
2. If a post with `generationRequestId` exists, return it with `existing: true` (research D13).
3. Load the profile, which must not be archived (`NotFoundError` otherwise). Take its current version **at this moment**; it is recorded even if the profile is edited during the call (edge case). Load the accounts (all in the project, else `NotFoundError`) and the media (`getMany`, all present).
4. Run `runGeneration`. On failure, insert a `generation_failures` row and return `ok: false`.
5. In one transaction, re-check membership through `need(tx, …)` (the edge case "removed member mid-generation"):
   - `createDraft`-equivalent insert with origin `generated`, `review_state = needs_review`, `scheduling_policy = resolved.scheduling`, `generation_request_id`, base text, overrides (research D10), media, and generation metadata `{ v: 1, records: [record] }`;
   - fill empty alt texts (research D9).

   A unique violation on `generation_request_id` returns the existing post.
6. Run `applyApprovalPolicy` and return the result.

## Series (`services/generation/series.ts`)

```ts
export async function planSeries(scope, input: unknown /* generateSingleSchema minus requestId + { count: 2..10 } */, llm?): Promise<
  { ok: true; angles: { title: string; description: string }[]; latencyMs: number } | { ok: false; failureId: string; kind; message }>;
export async function startSeries(scope, input: unknown /* same + { angles: 1..10 edited } + policies + confirm */): Promise<{ seriesId: string }>;
export async function writeSeriesPost(scope, seriesId: string, position: number, llm?): Promise<GenerateResult & { position: number }>;
export async function getSeries(scope, seriesId: string): Promise<{ series; angles; posts: (PostSummary | null)[]; failures: (FailureSummary | null)[] }>;
```

- `planSeries` runs the plan schema with the same retry rule. It saves only a failure row when it fails (Story 5 scenario 6).
- `startSeries` validates and resolves the policies, including the role limit and confirmation, saves the series with `request.resolved`, and makes no model call.
- `writeSeriesPost`:
  - if a live post exists at `(seriesId, position)`, it returns that post (`existing: true`);
  - otherwise it generates with `series: { angle, otherAngles: all other titles, position, total }` and saves it with `series_id` and `series_position`;
  - a unique violation also returns the existing post;
  - the policy comes from `series.request.resolved`;
  - the client calls positions in order, so `add_to_queue` takes slots in plan order (Story 5 scenario 4).
- A failed position records a failure row with `series_id` and `series_position`. The UI offers "Try again", which is the same call.

## Regenerate (`services/generation/regenerate.ts`)

```ts
export async function regeneratePost(scope, postId: string, input: unknown /* { instruction?: string ≤ 2000 } */, llm?): Promise<GenerateResult>;
```

This follows research D21. It needs `generation: ["run"]` and `post: ["edit"]`. It refuses when a target is not `draft`/`cancelled`: `ConflictError("Unschedule this post before regenerating.")`. It refuses a post with no generation record: `ConflictError("Only generated posts can be regenerated.")`. A failure writes a failure row with `post_id` and leaves the post unchanged.

## Review (`services/review.ts`)

```ts
export async function listReviewQueue(scope, input: unknown /* { page } */): Promise<{ items: ReviewItem[]; total; page; pageSize: 50 }>;
export interface ReviewItem {
  postId: string; createdAt: Date;
  variants: { providerKey: string; displayName: string; text: string; accountNames: string[]; count: number; limit: number; countingRule: string; issues: ValidationIssue[] }[];
  voice: { name: string; version: number } | null; brief: string | null; schedulingPolicy: SchedulingPolicy | null;
  blocking: boolean;
}
export async function approvePost(scope, postId: string, input?: unknown /* { edits?: { providerKey: string; text: string }[] } */):
  Promise<{ ok: true; queued: TargetResult<PlannedTime>[] } | { ok: false; code: "already_reviewed" | "validation"; message: string; issues?: Record<string, ValidationIssue[]> }>;
export async function rejectPost(scope, postId: string, input?: unknown /* { reason?: string ≤ 500 } */): Promise<{ ok: true } | { ok: false; code: "already_reviewed"; message: string }>;
export async function bulkApprove(scope, input: unknown /* { postIds: uuid[] 1..100 } */):
  Promise<{ approved: { postId: string; queued: number; unscheduled: { accountName: string; message: string }[] }[]; skipped: { postId: string; reason: string }[] }>;
```

Permissions:

- `approvePost` and `bulkApprove` need `post: ["edit", "schedule"]`.
- `rejectPost` needs `post: ["edit"]`.
- Every role has these permissions.

`approvePost` steps:

1. Run `prepareVariants`.
2. Open a transaction and lock the post. A post not in `needs_review` returns `already_reviewed` ("This post was already approved." / "This post was rejected.").
3. Apply the edits: set `override_text` on every live target of that provider.
4. Collect blocking issues with `gate()`. If any exist, return `validation`. The edits are **kept** in the same transaction (Story 3 scenario 3: it stays in review with the problems shown).
5. Otherwise set `approved` with the reviewer and the time.
6. If `scheduling_policy === "add_to_queue"`, call `queueTargetsInTx`. A target with no slots gets the existing "This account has no posting slots" result and other targets are unaffected (Story 3 scenario 9).
7. Run `applyDerivedStatus`.

`bulkApprove` calls `approvePost` once per id, sequentially, and collects the results. A `NotFoundError` becomes skipped "Not found".

## Voice profiles (`services/voice.ts`)

```ts
export async function listVoiceProfiles(scope, input?: { includeArchived?: boolean }): Promise<VoiceProfileSummary[]>;   // voice:view
export async function getVoiceProfile(scope, profileId: string): Promise<{ profile; current: VersionView; isDefault: boolean }>; // voice:view
export async function listVersions(scope, profileId: string): Promise<{ version: number; id: string; authorName: string | null; createdAt: Date }[]>;
export async function getVersion(scope, profileId: string, version: number): Promise<VersionView>;
export async function createVoiceProfile(scope, input: unknown /* { name, content } */): Promise<{ profileId: string; version: 1 }>;        // voice:manage
export async function saveVoiceProfile(scope, profileId: string, input: unknown /* { name, content, baseVersion } */): Promise<{ version: number }>; // voice:manage; ConflictError("This profile changed since you opened it") on stale baseVersion
export async function setDefaultVoiceProfile(scope, profileId: string): Promise<void>;     // voice:manage; refuses archived
export async function archiveVoiceProfile(scope, profileId: string): Promise<void>;        // voice:manage; ConflictError("Make another profile the default first") for the default
export async function restoreVoiceProfile(scope, profileId: string): Promise<void>;        // voice:manage; name clash → ConflictError("A profile with this name already exists")
export async function tryVoice(scope, input: unknown, llm?): Promise<TryItResult>;         // research D24; no writes
```

- A save whose content and name both equal the current version's is a no-op that returns the current version, so no empty versions are created.
- A rename alone does create a new version, because the name is stored on the profile and in the record snapshot.

## Generation failures (`services/generation/failures.ts`)

`listRecentFailures(scope, { limit ≤ 20 })` needs `post: ["view"]` and is shown on Generate as "Recent failures". There is no delete in this entry.

## Project settings (`services/projects.ts`, changed)

`updateSettings` accepts `confirmUnreviewedQueue`. When the new defaults are `auto_approve` + `add_to_queue` and the flag is not `true`, it throws a validation error on that field with the same message as `resolvePolicies` (FR-027, Story 4 scenario 9). Owner and admin only, as before (FR-028).
