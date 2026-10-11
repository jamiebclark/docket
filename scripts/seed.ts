/**
 * Fills a local database with enough realistic data to review the app by looking at it.
 *
 * The hard half of offline development was already solved: the `mock` provider publishes
 * nowhere, declares no credential fields, and `MOCK_PROVIDER_ENABLED` defaults on outside
 * production. What was missing is rows — a project, accounts, slots, a voice and posts in
 * every state — so screens could only be judged on a deployed instance. That made every UI
 * change cost a deploy before anyone could see it.
 *
 *   pnpm seed                  create the demo project (refuses if its slug is taken)
 *   pnpm seed --slug demo2     use a different slug
 *   pnpm seed --reset          delete the project first, then recreate it
 *
 * Everything goes through `src/server/services/` so a schema change breaks this at
 * typecheck rather than rotting silently. The one exception is the terminal target states
 * (published, failed, ambiguous) that only the scheduler can reach; those are written
 * directly and marked below.
 */
import { count, eq } from "drizzle-orm";
import { getDb } from "../src/server/db/client";
import { postTargets, posts } from "../src/server/db/schema/posts";
import { projects } from "../src/server/db/schema/projects";
import { installState } from "../src/server/db/schema/install";
import { externalItemClaims } from "../src/server/db/schema/external-claims";
import { generationJobItems, generationJobs } from "../src/server/db/schema/jobs";
import { voiceProfileVersions } from "../src/server/db/schema/generation";
import { organization, user } from "../src/server/db/schema/auth";
import { forProject } from "../src/server/dal/scope";
import type { ProjectScope } from "../src/server/dal/scope";
import { connectMock } from "../src/server/services/accounts";
import { createDraft, setReviewState } from "../src/server/services/posts";
import * as projectsService from "../src/server/services/projects";
import { createFirstUser, isAvailable } from "../src/server/services/setup";
import { addSlot } from "../src/server/services/slots";
import { createVoiceProfile, setDefaultVoiceProfile } from "../src/server/services/voice";

const OWNER = { name: "Demo Owner", email: "demo@localhost.test", password: "demo-password-1234" };
const TIMEZONE = "America/New_York";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

/**
 * Seeding writes fabricated posts and accounts. Running it against a shared database would
 * put demo rows in front of real people, so the host must be loopback — checked before the
 * first write, and before anything reads config that might point elsewhere.
 */
function assertLocal(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a URL.");
  }
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (!local) {
    throw new Error(
      `Refusing to seed: DATABASE_URL points at "${host}", not a local database. ` +
        `This script writes demo accounts and posts and must never run against a shared instance.`,
    );
  }
}

/**
 * The first account if there is none yet, otherwise the existing owner by email.
 *
 * Setup is gated by an `install_state` singleton, not by the user table, so deleting users
 * alone leaves setup permanently closed and no way back to a first account. On a local
 * database with no users left, clear it and bootstrap again — otherwise the only recovery is
 * dropping the whole database.
 */
async function ownerUserId(): Promise<string> {
  const db = getDb();
  if (await isAvailable()) {
    const created = await createFirstUser(OWNER);
    console.log(`  created the first account: ${created.email}`);
    return created.userId;
  }

  const rows = await db.select({ id: user.id }).from(user).where(eq(user.email, OWNER.email)).limit(1);
  const found = rows[0];
  if (found) {
    console.log(`  reusing the existing account: ${OWNER.email}`);
    return found.id;
  }

  const [remaining] = await db.select({ n: count() }).from(user);
  if ((remaining?.n ?? 0) > 0) {
    throw new Error(
      `Accounts already exist but none is "${OWNER.email}". Sign in as a user you have and seed ` +
        `from the UI, or point DATABASE_URL at an empty database.`,
    );
  }

  console.log("  no users left but setup was closed; reopening it");
  await db.delete(installState);
  const created = await createFirstUser(OWNER);
  console.log(`  created the first account: ${created.email}`);
  return created.userId;
}

/**
 * Deletes the organization, not the project. A project *is* a Better Auth organization —
 * `projects.id` equals `organization.id` and references it `on delete cascade` — so removing
 * the project row alone leaves the organization behind, still holding the slug, and the next
 * create fails with "That URL name is already taken."
 */
async function dropProject(slug: string): Promise<boolean> {
  const db = getDb();
  const rows = await db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).limit(1);
  const existing = rows[0];
  if (!existing) {
    // The project may be gone while its organization lingers, from an earlier partial delete.
    const orphan = await db.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug)).limit(1);
    if (!orphan[0]) return false;
    await db.delete(organization).where(eq(organization.id, orphan[0].id));
    return true;
  }
  await db.delete(organization).where(eq(organization.id, existing.id));
  return true;
}

/** Two slots a day, every day, so the calendar shows a full grid rather than a sparse one. */
async function addSlots(scope: ProjectScope, accountId: string, times: readonly string[]): Promise<number> {
  let made = 0;
  for (const localTime of times) {
    for (let weekday = 1; weekday <= 7; weekday++) {
      await addSlot(scope, { accountId, weekday, localTime });
      made++;
    }
  }
  return made;
}

/**
 * Terminal target states the scheduler owns. No service exposes them — `publish` is driven by
 * `advance()` against a real provider — so a seed that wants the Posts and Failures screens to
 * have anything on them has to write them directly. Kept to the few columns each state needs.
 */
async function forceTargetState(
  postId: string,
  state: "published" | "failed" | "ambiguous",
  at: Date,
): Promise<void> {
  const db = getDb();
  const common = { status: state } as const;
  const extra =
    state === "published"
      ? { publishedAt: at, externalId: `mock-${postId.slice(0, 8)}`, externalUrl: "https://example.test/p/demo" }
      : state === "failed"
        ? { lastError: "The provider rejected the post: rate limit exceeded.", attemptCount: 3 }
        : { lastError: "The publish call timed out; it may or may not have posted.", attemptCount: 1 };
  await db.update(postTargets).set({ ...common, ...extra }).where(eq(postTargets.postId, postId));
  const postStatus = state === "ambiguous" ? "partially_failed" : state;
  await db.update(posts).set({ status: postStatus }).where(eq(posts.id, postId));
}

/**
 * A finished batch job whose items cover done, failed and skipped.
 *
 * Skipped is the one state no amount of clicking will produce locally: an item is skipped
 * when its `externalId` was already claimed by an earlier post, which needs the ledger row
 * *and* a successful model call to have made that post. Without it the Skipped badge, its
 * Detail link and the Skipped filter tab cannot be looked at outside production.
 *
 * `toItemView` builds the skipped detail by reading `sourceMeta.sourceKey` off the job and
 * looking up `(sourceKey, externalId)` in the claims ledger, so all three have to agree for
 * the row to link to the post that covers it.
 */
async function seedJobWithSkippedItem(
  scope: ProjectScope,
  opts: { projectId: string; accountIds: string[]; voiceProfileId: string; claimedPostId: string; donePostId: string },
): Promise<void> {
  const db = getDb();
  const sourceKey = "demo-source";
  const externalId = "record-4815";

  const versions = await db
    .select({ id: voiceProfileVersions.id })
    .from(voiceProfileVersions)
    .where(eq(voiceProfileVersions.profileId, opts.voiceProfileId))
    .limit(1);
  const versionId = versions[0]?.id;
  if (!versionId) throw new Error("The voice profile has no version row; cannot seed a job.");

  // The claim that makes the third item skip: this external id already became a post.
  await db.insert(externalItemClaims).values({
    projectId: opts.projectId,
    sourceKey,
    externalId,
    postId: opts.claimedPostId,
  });

  const [job] = await db
    .insert(generationJobs)
    .values({
      projectId: opts.projectId,
      sourceKind: "api",
      sourceSummary: "Items sent through the API",
      sourceMeta: { open: false, sourceKey },
      voiceProfileId: opts.voiceProfileId,
      voiceProfileVersionId: versionId,
      template: "Write a short post about {{title}}.",
      templateFields: ["title"],
      targetAccountIds: opts.accountIds,
      approvalPolicy: "review_required",
      schedulingPolicy: "leave_as_draft",
      status: "completed_with_failures",
      itemCount: 3,
      // `generation_jobs_finished_pair` requires a finish time once the status is terminal.
      startedAt: new Date(Date.now() - 10 * 60_000),
      finishedAt: new Date(Date.now() - 9 * 60_000),
    })
    .returning({ id: generationJobs.id });
  if (!job) throw new Error("Could not create the demo job.");

  const now = new Date();
  const items = await db
    .insert(generationJobItems)
    .values([
      {
        projectId: opts.projectId, jobId: job.id, position: 0, label: "A record that worked",
        payload: { title: "a traffic cone" }, externalId: "record-1123", status: "done", finishedAt: now,
      },
      {
        projectId: opts.projectId, jobId: job.id, position: 1, label: "A record that failed",
        payload: { title: "a filing cabinet" }, externalId: "record-2242", status: "failed",
        attemptCount: 3, lastErrorKind: "rate_limited",
        lastError: "The model provider is rate limiting requests. Try again in a minute.", finishedAt: now,
      },
      {
        projectId: opts.projectId, jobId: job.id, position: 2, label: "A record already posted",
        payload: { title: "a traffic cone" }, externalId, status: "skipped", finishedAt: now,
      },
    ])
    .returning({ id: generationJobItems.id, position: generationJobItems.position });

  // The done item shows its post through `posts.findByJobItemId`; point one at position 0.
  const doneItem = items.find((i) => i.position === 0);
  if (doneItem) {
    await db.update(posts).set({ generationJobItemId: doneItem.id }).where(eq(posts.id, opts.donePostId));
  }

  console.log(`  1 job: done, failed and skipped (skipped links to the post claiming "${externalId}")`);
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Set DATABASE_URL to a local Postgres database.");
    return 2;
  }
  assertLocal(url);

  const slug = arg("--slug") ?? "demo";

  if (flag("--reset")) {
    const dropped = await dropProject(slug);
    console.log(dropped ? `Removed the existing "${slug}" project.` : `No "${slug}" project to remove.`);
  } else {
    const db = getDb();
    const taken = await db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).limit(1);
    if (taken[0]) {
      console.error(`A project with slug "${slug}" already exists. Re-run with --reset, or pass --slug.`);
      return 1;
    }
  }

  console.log("Owner");
  const userId = await ownerUserId();
  const session = { user: { id: userId } };

  console.log("Project");
  await projectsService.create(session, { name: "Demo project", slug, timezone: TIMEZONE });
  const scope = await forProject(session, slug);
  console.log(`  ${slug} (${TIMEZONE})`);

  console.log("Accounts (mock provider — these publish nowhere)");
  const accounts = [];
  for (const displayName of ["Demo Page", "Demo Gram", "Demo Threads"]) {
    accounts.push(await connectMock(scope, { displayName }));
    console.log(`  ${displayName}`);
  }

  console.log("Posting slots");
  const slotTimes = [
    ["09:15", "17:45"],
    ["11:30", "19:30"],
    ["12:45", "20:15"],
  ] as const;
  let slotCount = 0;
  for (const [i, account] of accounts.entries()) {
    slotCount += await addSlots(scope, account.id, slotTimes[i] ?? ["10:00"]);
  }
  console.log(`  ${slotCount} slots across ${accounts.length} accounts`);

  console.log("Voice profile");
  const voice = await createVoiceProfile(scope, {
    name: "Demo house voice",
    content: {
      voiceAndTone: "Plain, warm and specific. Short sentences. No exclamation marks.",
      audience: "People who already use the product and want to know what changed.",
      topicsAndPillars: "Product changes, how things work, the occasional behind-the-scenes note.",
      avoid: "Hype, superlatives, emoji in the body, and anything that reads like a press release.",
      examplePosts: ["The calendar now shows empty slots, so you can see the gaps as well as the posts."],
      preferredHashtags: ["demo"],
    },
  });
  await setDefaultVoiceProfile(scope, voice.profileId);
  console.log("  Demo house voice (default)");

  console.log("Posts");
  const allTargets = accounts.map((a) => ({ accountId: a.id }));
  const made: { label: string; id: string }[] = [];

  const drafts: { label: string; text: string; review?: "needs_review" | "approved" }[] = [
    { label: "draft", text: "A half-written thought that is not ready to go anywhere yet." },
    { label: "needs_review", text: "Waiting on a second pair of eyes before this goes out.", review: "needs_review" },
    { label: "approved", text: "Signed off and ready for a slot.", review: "approved" },
    { label: "published", text: "This one already went out, and the calendar should say so." },
    { label: "failed", text: "This one did not make it, and Failures should show why." },
    { label: "ambiguous", text: "Nobody knows whether this published. It needs a human decision." },
  ];

  for (const d of drafts) {
    const detail = await createDraft(scope, { baseText: d.text, targets: allTargets, mediaIds: [] });
    if (d.review) await setReviewState(scope, detail.post.id, d.review);
    made.push({ label: d.label, id: detail.post.id });
  }

  const now = new Date();
  for (const label of ["published", "failed", "ambiguous"] as const) {
    const entry = made.find((m) => m.label === label);
    if (entry) await forceTargetState(entry.id, label, now);
  }
  console.log(`  ${made.length} posts: ${made.map((m) => m.label).join(", ")}`);

  const claimed = made.find((m) => m.label === "published");
  const doneFor = made.find((m) => m.label === "approved");
  if (claimed && doneFor) {
    console.log("Batch job");
    await seedJobWithSkippedItem(scope, {
      projectId: scope.project.id,
      accountIds: accounts.map((a) => a.id),
      voiceProfileId: voice.profileId,
      claimedPostId: claimed.id,
      donePostId: doneFor.id,
    });
  }

  console.log(`\nDone. Sign in at /login as ${OWNER.email} with the password ${OWNER.password}`);
  console.log(`Then open /p/${slug}/calendar`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
