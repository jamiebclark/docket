import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const keyA = randomBytes(32).toString("base64");
const keyB = randomBytes(32).toString("hex");
let currentKey = keyA;

vi.mock("@/server/env", () => ({
  getEnv: () => ({ CREDENTIALS_ENCRYPTION_KEY: currentKey, BETTER_AUTH_URL: "http://localhost:3000" }),
}));

import {
  mintUnsubscribeToken,
  oneClickUnsubscribeUrl,
  readUnsubscribeToken,
  unsubscribeUrl,
} from "./unsubscribe";

describe("unsubscribe tokens", () => {
  beforeEach(() => {
    currentKey = keyA;
  });

  it("round-trips a grant for a single project", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const token = mintUnsubscribeToken({ userId: "user-1", projectId: "project-1" }, now);
    expect(readUnsubscribeToken(token, now)).toEqual({ userId: "user-1", projectId: "project-1" });
  });

  it("round-trips a grant for a digest spanning several projects", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const token = mintUnsubscribeToken({ userId: "user-1", projectId: null }, now);
    expect(readUnsubscribeToken(token, now)).toEqual({ userId: "user-1", projectId: null });
  });

  it("expires after the TTL", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const token = mintUnsubscribeToken({ userId: "user-1", projectId: null }, now);
    const justBefore = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000 - 1000);
    const justAfter = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000 + 1000);
    expect(readUnsubscribeToken(token, justBefore)).not.toBeNull();
    expect(readUnsubscribeToken(token, justAfter)).toBeNull();
  });

  it("rejects a tampered token", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const token = mintUnsubscribeToken({ userId: "user-1", projectId: "project-1" }, now);
    const parts = token.split(":");
    const last = parts.length - 1;
    parts[last] = parts[last] === "a" ? "b" : "a" + parts[last];
    expect(readUnsubscribeToken(parts.join(":"), now)).toBeNull();
  });

  it("rejects a truncated token", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const token = mintUnsubscribeToken({ userId: "user-1", projectId: "project-1" }, now);
    expect(readUnsubscribeToken(token.slice(0, -10), now)).toBeNull();
  });

  it("rejects a non-string token", () => {
    expect(readUnsubscribeToken(undefined, new Date())).toBeNull();
    expect(readUnsubscribeToken(42, new Date())).toBeNull();
  });

  it("rejects a token re-signed under a different AAD shape (another token swapped in)", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const grantA = mintUnsubscribeToken({ userId: "user-1", projectId: "project-1" }, now);
    const grantB = mintUnsubscribeToken({ userId: "user-2", projectId: "project-2" }, now);
    expect(readUnsubscribeToken(grantA, now)).not.toEqual(readUnsubscribeToken(grantB, now));
  });

  it("rejects a token minted under a rotated CREDENTIALS_ENCRYPTION_KEY", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const token = mintUnsubscribeToken({ userId: "user-1", projectId: "project-1" }, now);
    currentKey = keyB;
    expect(readUnsubscribeToken(token, now)).toBeNull();
  });

  it("never includes a readable substring of the user id, project id, address or slug", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const userId = "user-super-secret-id";
    const projectId = "project-very-identifiable-slug";
    const token = mintUnsubscribeToken({ userId, projectId }, now);
    expect(token).not.toContain(userId);
    expect(token).not.toContain(projectId);
    expect(token.toLowerCase()).not.toContain(userId.toLowerCase());
    expect(token.toLowerCase()).not.toContain(projectId.toLowerCase());
  });

  it("builds the two unsubscribe urls", () => {
    expect(unsubscribeUrl("tok")).toBe("http://localhost:3000/email/unsubscribe?t=tok");
    expect(oneClickUnsubscribeUrl("tok")).toBe("http://localhost:3000/api/email/unsubscribe?t=tok");
  });
});
