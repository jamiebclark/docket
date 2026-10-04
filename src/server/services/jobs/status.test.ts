import { describe, expect, it } from "vitest";
import type { JobCounts, JobStatus } from "../../dal/jobs";
import { deriveJobStatus } from "./status";

const c = (over: Partial<JobCounts>): JobCounts => ({ queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, ...over });

describe("deriveJobStatus", () => {
  const rows: [string, JobStatus, Partial<JobCounts>, boolean, JobStatus][] = [
    ["nothing claimed yet", "queued", { queued: 3 }, false, "queued"],
    ["an item is running", "queued", { queued: 2, running: 1 }, false, "running"],
    ["some done, some queued", "queued", { queued: 2, done: 1 }, false, "running"],
    ["started, then every item waits in backoff", "running", { queued: 3 }, true, "running"],
    ["all done", "running", { done: 3 }, true, "completed"],
    ["done and failed", "running", { done: 2, failed: 1 }, true, "completed_with_failures"],
    ["all failed", "running", { failed: 3 }, true, "completed_with_failures"],
    ["a failed item is retried after completion", "completed_with_failures", { queued: 1, done: 2 }, true, "running"],
    ["a retried item finishes", "running", { done: 3 }, true, "completed"],
    ["cancelled stays cancelled", "cancelled", { queued: 1 }, true, "cancelled"],
    ["cancelled stays cancelled with all settled", "cancelled", { done: 1, cancelled: 2 }, true, "cancelled"],
    ["cancelled items alone complete a job that was never cancelled", "running", { done: 1, cancelled: 1 }, true, "completed"],
  ];
  it.each(rows)("%s", (_name, current, counts, started, expected) => {
    expect(deriveJobStatus(current, c(counts), started)).toBe(expected);
  });
});
