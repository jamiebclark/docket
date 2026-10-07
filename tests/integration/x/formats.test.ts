import { describe, expect, it } from "vitest";
import { UPLOAD_MIME_TYPES } from "../../../src/server/services/media";
import { xProvider } from "../../../src/providers/x";
import { planWith } from "../../helpers/limit-rows";

describe("X image formats", () => {
  it("x: formats accepts every uploadable type without converting it", () => {
    for (const mimeType of UPLOAD_MIME_TYPES) {
      const plan = planWith(xProvider, { mimeType, width: 1000, height: 1000, bytes: 1000 });
      expect(plan.kind, mimeType).toBe("original");
    }
  });
});
