import { describe, expect, it } from "vitest";
import { POST_LIST_STATUSES, postSearchParamsSchema } from "./media";

describe("post list search params (F2)", () => {
  it.each(POST_LIST_STATUSES)("keeps ?status=%s", (status) => {
    expect(postSearchParamsSchema.parse({ status }).status).toBe(status);
  });

  it("drops an unknown status rather than failing", () => {
    expect(postSearchParamsSchema.parse({ status: "bogus" }).status).toBeUndefined();
  });
});
