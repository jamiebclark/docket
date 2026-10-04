import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, PolicyNotAllowedError, ValidationIssuesError } from "../../../src/server/dal/errors";
import { setLlmForTests } from "../../../src/server/llm";
import { createJob, previewJob } from "../../../src/server/services/jobs";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { jobsEnv, parkAllJobs } from "../../helpers/jobs-env";

beforeEach(parkAllJobs);
afterAll(async () => {
  setLlmForTests(null);
  setStorageForTests(undefined);
  await closeDb();
});

async function setup() {
  const fake = createFakeLlm([]);
  const env = await jobsEnv();
  setLlmForTests(fake);
  return { ...env, fake };
}

const messageOf = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as Error | null;

describe("createJob (US1)", () => {
  it("makes one item per unused image, with no model call, and pins the voice version", async () => {
    const e = await setup();
    const [a, b, c] = await e.assets(3);
    await e.asset({ used: true });
    const result = await createJob(e.scope, e.input());
    expect(result).toMatchObject({ itemCount: 3, skippedReserved: 0 });
    expect(e.fake.requests).toHaveLength(0);
    const job = (await e.scope.jobs.get(result.jobId))!;
    expect(job).toMatchObject({ status: "queued", itemCount: 3, sourceKind: "media", sourceSummary: "3 unused images", createdByUserId: e.owner.id });
    expect(job.voiceProfileVersionId).toBe((await e.scope.voiceVersions.getByNumber(e.profile.id, 1))!.id);
    const items = await e.scope.jobItems.listForJob(job.id);
    expect(items.map((i) => i.mediaAssetId).sort()).toEqual([a!.id, b!.id, c!.id].sort());
    expect(items.every((i) => i.status === "queued")).toBe(true);
  });

  it("a filter selection reports matched images that are already used (F2)", async () => {
    const e = await setup();
    await e.assets(2, { tags: ["dusk"] });
    await e.asset({ tags: ["dusk"], used: true });
    const preview = await previewJob(e.scope, e.input({ source: { kind: "media", selection: { mode: "filter", filter: { tag: "dusk" } }, includeUsed: false } }));
    expect(preview).toMatchObject({ itemCount: 2, excluded: [{ reason: "already_used", count: 1 }] });
  });

  it("picks, filters, and honours includeUsed", async () => {
    const e = await setup();
    const tagged = await e.assets(2, { tags: ["sunset"] });
    const usedTagged = await e.asset({ tags: ["sunset"], used: true });
    const picked = await createJob(e.scope, e.input({ source: { kind: "media", selection: { mode: "pick", ids: [tagged[0]!.id, usedTagged.id] }, includeUsed: false } }));
    expect(picked).toMatchObject({ itemCount: 1, excluded: [{ reason: "already_used", count: 1 }] });

    const filtered = await createJob(e.scope, e.input({ source: { kind: "media", selection: { mode: "filter", filter: { tag: "sunset" } }, includeUsed: true } }));
    // `tagged[0]` is now reserved by the first job; the used one is included because includeUsed is on.
    expect(filtered).toMatchObject({ itemCount: 2, skippedReserved: 1 });
    expect((await e.scope.jobs.get(filtered.jobId))!.sourceSummary).toBe("2 images tagged sunset");
  });

  it("refuses 501 images, an empty selection, and a missing placeholder field", async () => {
    const e = await setup();
    const ids = Array.from({ length: 501 }, () => crypto.randomUUID());
    const tooMany = await messageOf(createJob(e.scope, e.input({ source: { kind: "media", selection: { mode: "pick", ids }, includeUsed: false } })));
    expect(tooMany).toBeInstanceOf(Error);

    const none = await messageOf(createJob(e.scope, e.input()));
    expect(none).toBeInstanceOf(ValidationIssuesError);
    expect((none as ValidationIssuesError).issues).toEqual([expect.objectContaining({ message: expect.stringContaining("No unused images left to generate for") })]);

    await e.asset({ used: true });
    const allUsed = await messageOf(createJob(e.scope, e.input({ source: { kind: "media", selection: { mode: "pick", ids: [(await e.asset({ used: true })).id] }, includeUsed: false } })));
    expect((allUsed as ValidationIssuesError).issues).toEqual([expect.objectContaining({ message: expect.stringContaining("None of the selected images can be used") })]);

    await e.asset();
    const unknown = await messageOf(createJob(e.scope, e.input({ template: "About {{missing}}" })));
    expect((unknown as ValidationIssuesError).issues).toEqual([
      expect.objectContaining({ field: "template", message: "Unknown field: missing. Available: alt_text, tags, filename" }),
    ]);
    expect((await e.scope.jobs.list({ limit: 10, offset: 0 })).total).toBe(0);
  });

  it("refuses when generation is not configured", async () => {
    const e = await setup();
    await e.asset();
    setLlmForTests(null);
    const error = await messageOf(createJob(e.scope, e.input()));
    expect(error?.message).toContain("Generation is not configured");
  });

  it("refuses an editor's auto-approve override and an unconfirmed unreviewed queue", async () => {
    const e = await setup();
    await e.assets(2);
    const editor = await e.as(e.editor);
    const refused = await messageOf(createJob(editor, e.input({ approval: "auto_approve" })));
    expect(refused).toBeInstanceOf(PolicyNotAllowedError);
    expect(refused?.message).toBe("Only owners and admins can auto-approve");

    const unconfirmed = await messageOf(createJob(e.scope, e.input({ approval: "auto_approve", scheduling: "add_to_queue" })));
    expect(unconfirmed?.message).toContain("confirm");
    expect((await e.scope.jobs.list({ limit: 10, offset: 0 })).total).toBe(0);

    const ok = await createJob(e.scope, e.input({ approval: "auto_approve", scheduling: "add_to_queue", confirmUnreviewedQueue: true }));
    expect(await e.scope.jobs.get(ok.jobId)).toMatchObject({ approvalPolicy: "auto_approve", schedulingPolicy: "add_to_queue", requestedApproval: "auto_approve" });
  });

  it("is forbidden without generation and edit rights", async () => {
    const e = await setup();
    await e.asset();
    const viewer = { ...e.scope, can: () => false } as typeof e.scope;
    await expect(createJob(viewer, e.input())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("creates a job from 100 images in under 3 seconds (SC-001)", async () => {
    const e = await setup();
    await e.assets(100);
    const t0 = Date.now();
    const result = await createJob(e.scope, e.input());
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(result.itemCount).toBe(100);
    expect(e.fake.requests).toHaveLength(0);
  }, 60_000);

  it("previews without writing", async () => {
    const e = await setup();
    await e.assets(2, { tags: ["cats"] });
    const preview = await previewJob(e.scope, { source: e.input().source, targetAccountIds: [e.account.id] });
    expect(preview).toMatchObject({ itemCount: 2, reserved: 0, fields: ["alt_text", "tags", "filename"], instagramWithoutMedia: false });
    expect(preview.first?.fields.tags).toBe("cats");
    expect((await e.scope.jobs.list({ limit: 10, offset: 0 })).total).toBe(0);
  });
});

describe("createJob with a CSV (US4)", () => {
  const csvInput = (e: Awaited<ReturnType<typeof setup>>, template: string) =>
    e.input({ source: { kind: "csv" }, template });
  const file = (text: string) => ({ file: { name: "items.csv", bytes: Buffer.from(text) } });

  it("refuses an unknown column and creates no job row", async () => {
    const e = await setup();
    const err = await messageOf(createJob(e.scope, csvInput(e, "About {{missing}}"), file("name,price\nMug,5\n")));
    expect(err).toBeInstanceOf(ValidationIssuesError);
    expect(err!.message).toBe("Unknown column: missing. Available: name, price");
    expect((await e.scope.jobs.list({ limit: 10, offset: 0 })).total).toBe(0);
  });

  it("makes one item per row, labelled by line and first value", async () => {
    const e = await setup();
    const result = await createJob(e.scope, csvInput(e, "About {{name}}"), file("name,price\nMug,5\nHat,7\nCap,\n"));
    expect(result).toMatchObject({ itemCount: 3, excluded: [] });
    const job = (await e.scope.jobs.get(result.jobId))!;
    expect(job).toMatchObject({ sourceKind: "csv", templateFields: ["name", "price"], sourceMeta: { filename: "items.csv", rowCount: 3 } });
    const items = await e.scope.jobItems.listForJob(job.id);
    expect(items.map((i) => i.label)).toEqual(["Row 2: Mug", "Row 3: Hat", "Row 4: Cap"]);
    expect(items.every((i) => i.mediaAssetId === null)).toBe(true);
  });

  it("refuses a file that is not valid, listing the problem", async () => {
    const e = await setup();
    const err = await messageOf(createJob(e.scope, csvInput(e, "x"), file("a,\n1,2\n")));
    expect(err).toBeInstanceOf(ValidationIssuesError);
    expect((err as ValidationIssuesError).issues).toEqual([expect.objectContaining({ message: "Column 2 has no name" })]);
  });

  it("refuses when the rendered instructions would be too long", async () => {
    const e = await setup();
    const err = await messageOf(createJob(e.scope, csvInput(e, "{{a}} {{a}}"), file(`a\n${"x".repeat(20_000)}\n`)));
    expect(err?.message).toMatch(/^Row 2: x+: the instructions would be \d+ characters; the limit is/);
  });
});
