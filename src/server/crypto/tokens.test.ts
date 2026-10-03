import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/env", () => ({
  getEnv: () => ({ BETTER_AUTH_URL: "http://localhost:3000" }),
}));

import {
  generateInvitationToken,
  hashInvitationToken,
  invitationUrl,
  isWellFormedToken,
} from "./tokens";

describe("invitation tokens", () => {
  it("generates a 43-char base64url token and matching sha256 hex hash", () => {
    const { token, tokenHash } = generateInvitationToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(hashInvitationToken(token));
    expect(tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(generateInvitationToken().token).not.toBe(token);
  });

  it("validates token shape", () => {
    const { token } = generateInvitationToken();
    expect(isWellFormedToken(token)).toBe(true);
    for (const bad of ["", "short", token + "a", token.slice(1) + "+", 42, null, undefined]) {
      expect(isWellFormedToken(bad)).toBe(false);
    }
  });

  it("builds the signup URL", () => {
    expect(invitationUrl("abc")).toBe("http://localhost:3000/signup?token=abc");
  });
});
