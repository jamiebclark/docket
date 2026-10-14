import { z } from "zod";
import { classifyPinterestFailure, type PinterestOAuthFailure } from "./oauth";
import { pinterestRequest } from "./http";

const userAccountSchema = z.object({
  id: z.string().min(1),
  username: z.string().optional(),
  business_name: z.string().optional(),
});

export interface PinterestUserAccount {
  id: string;
  /** `business_name` when Pinterest sent one, else `username`, else the id (K25). */
  displayName: string;
}

export type PinterestAccountResult = { ok: true; account: PinterestUserAccount } | { ok: false; noId: true } | PinterestOAuthFailure;

/** `GET /v5/user_account`. A reply with no usable string `id` is its own refusal kind (contracts/pinterest-connect.md §2 step 5). */
export async function readUserAccount(accessToken: string, signal: AbortSignal): Promise<PinterestAccountResult> {
  const out = await pinterestRequest({ method: "GET", path: "/v5/user_account", auth: { kind: "bearer", token: accessToken }, signal });
  if (out.kind !== "ok") return classifyPinterestFailure(out, []);
  const parsed = userAccountSchema.safeParse(out.body);
  if (!parsed.success) return { ok: false, noId: true };
  const { id, username, business_name } = parsed.data;
  return { ok: true, account: { id, displayName: business_name || username || id } };
}
