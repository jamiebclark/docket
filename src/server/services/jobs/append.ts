// jobs/append: add items to an open job (research D18). All-or-nothing: a bad item refuses the whole request.
import { appendItemsSchema, API_ITEMS_PER_CALL_MAX } from "@/lib/validation/api";
import { JOB_ITEMS_MAX } from "@/lib/validation/jobs";
import { z } from "zod";
import { ConflictError, JobClosedError, JobItemLimitError, NotFoundError } from "../../dal/errors";
import type { ProjectScope } from "../../dal/scope";
import { assertMediaFits, distinctProviderKeys, isUniqueViolation, loadAccounts, need } from "../generation/single";
import { assertRenderedFits, insertItems } from "./create";
import { assertApiMediaAvailable, prepareApiItems } from "./sources/api";

export interface AppendResult {
  added: number;
  itemCount: number;
  items: { id: string; position: number }[];
}

export { API_ITEMS_PER_CALL_MAX };

export async function appendItems(scope: ProjectScope, jobId: string, input: unknown): Promise<AppendResult> {
  const parsed = appendItemsSchema.parse(input);
  need(scope, { generation: ["run"], post: ["edit"] });
  const id = z.uuid().safeParse(jobId);
  if (!id.success) throw new NotFoundError();

  const write = () =>
    scope.transaction(async (tx) => {
      need(tx, { generation: ["run"], post: ["edit"] });
      const job = await tx.jobs.lockForUpdate(id.data);
      if (!job) throw new NotFoundError("Job not found");
      if (job.status === "cancelled") throw new JobClosedError("This job was cancelled and accepts no more items.");
      if (!job.open) throw new JobClosedError();
      if (job.itemCount + parsed.items.length > JOB_ITEMS_MAX) {
        throw new JobItemLimitError(`A job can have at most ${JOB_ITEMS_MAX} items; this one has ${job.itemCount}.`);
      }
      const items = prepareApiItems(job.templateFields, parsed.items, job.itemCount);
      assertRenderedFits(job.template, items, (i) => `items.${i}`, "too_long");
      if (items.some((i) => i.mediaAssetId !== null)) {
        assertMediaFits(distinctProviderKeys(await loadAccounts(tx, job.targetAccountIds)), 1);
        await assertApiMediaAvailable(tx, items);
      }
      const base = job.itemCount;
      await insertItems(tx, job, items);
      const rows = await tx.jobItems.listForJob(job.id, { limit: items.length, offset: base });
      return { added: items.length, itemCount: base + items.length, items: rows.map((r) => ({ id: r.id, position: r.position })) };
    });

  try {
    return await write();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    throw new ConflictError("Some images were just taken by another job. Try again.");
  }
}
