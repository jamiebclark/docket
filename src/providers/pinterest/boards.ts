import { z } from "zod";
import type { AccountDetailsReader } from "../types";
import type { PinterestSettings } from "./settings";
import { readPinterestCredentials } from "./credentials";
import { pinterestRequest } from "./http";

/** data-model §5. The 10-page cap (K20, FR-017). */
export const PINTEREST_BOARD_PAGE_MAX = 10;
export const PINTEREST_BOARD_PAGE_SIZE = 250;

export const pinterestDetailsSchema = z.object({
  v: z.literal(1),
  boards: z.array(z.object({ id: z.string().min(1).max(100), name: z.string().max(400) })).max(2_500),
  /** Set once the 10-page cap is hit while Pinterest still had more boards. */
  truncated: z.boolean(),
});

export type PinterestDetails = z.infer<typeof pinterestDetailsSchema>;

const boardItemSchema = z.object({ id: z.string().min(1), name: z.string() });
const boardsPageSchema = z.object({ items: z.array(boardItemSchema), bookmark: z.string().nullable().optional() });

export type PinterestBoardsResult =
  | { ok: true; boards: { id: string; name: string }[]; truncated: boolean }
  /** `status: null` means network or unparseable. */
  | { ok: false; status: number | null; transient: boolean };

/** `GET /v5/boards?privacy=PUBLIC&page_size=250[&bookmark=…]`, following `bookmark` for at most 10 pages. */
export async function readBoards(accessToken: string, signal: AbortSignal): Promise<PinterestBoardsResult> {
  const boards: { id: string; name: string }[] = [];
  let bookmark: string | null = null;
  let truncated = false;
  for (let page = 0; page < PINTEREST_BOARD_PAGE_MAX; page++) {
    const path =
      `/v5/boards?privacy=PUBLIC&page_size=${PINTEREST_BOARD_PAGE_SIZE}` + (bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : "");
    const out = await pinterestRequest({ method: "GET", path, auth: { kind: "bearer", token: accessToken }, signal });
    if (out.kind === "network") return { ok: false, status: null, transient: true };
    if (out.kind === "unparseable") return { ok: false, status: null, transient: true };
    if (out.kind === "http_error") {
      return { ok: false, status: out.status, transient: out.status === 429 || out.status >= 500 };
    }
    const parsed = boardsPageSchema.safeParse(out.body);
    if (!parsed.success) return { ok: false, status: null, transient: true };
    for (const b of parsed.data.items) boards.push({ id: b.id, name: b.name.slice(0, 400) });
    bookmark = parsed.data.bookmark ?? null;
    if (!bookmark) break;
    if (page === PINTEREST_BOARD_PAGE_MAX - 1) truncated = true;
  }
  return { ok: true, boards, truncated };
}

const LOAD_FAILED = "Couldn't load this Pinterest account's boards.";

/** G26: the composer's live board list. */
export const pinterestAccountDetails: AccountDetailsReader<PinterestSettings, PinterestDetails> = {
  schema: pinterestDetailsSchema,
  async read({ credentials, signal }) {
    const c = readPinterestCredentials(credentials);
    if (!c) return { ok: false, message: LOAD_FAILED, transient: false };
    const r = await readBoards(c.accessToken, signal);
    if (!r.ok) return { ok: false, message: LOAD_FAILED, credentialsExpired: r.status === 401, transient: r.transient };
    return { ok: true, details: { v: 1, boards: r.boards, truncated: r.truncated } };
  },
};
