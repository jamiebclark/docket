import { createHash, randomBytes } from "node:crypto";
import { getEnv } from "@/server/env";

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateInvitationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInvitationToken(token) };
}

export function isWellFormedToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function invitationUrl(token: string): string {
  return `${getEnv().BETTER_AUTH_URL}/signup?token=${token}`;
}
