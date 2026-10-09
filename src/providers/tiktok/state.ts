import { z } from "zod";

export const TARGET_CHUNKS = 30;
export const MIN_CHUNK_BYTES = 5_242_880;
export const MAX_CHUNK_BYTES = 64_000_000;
/** Exclusive. */
export const MAX_FINAL_CHUNK_BYTES = 128_000_000;
export const MAX_CHUNKS = 1000;
export const MAX_VIDEO_BYTES = 4_000_000_000;
/** The upload address is valid for an hour; it is renewed ahead of that (P28). */
export const UPLOAD_SAFE_AGE_MS = 55 * 60_000;
export const MAX_RESTARTS = 2;
export const CAP_RETRY_MS = 60 * 60_000;
export const CAP_GIVE_UP_MS = 23 * 60 * 60_000;
export const RATE_RETRY_MS = 60_000;
export const FIRST_READ_DELAY_MS = 15_000;
export const FAST_READ_INTERVAL_MS = 60_000;
export const FAST_PHASE_MS = 10 * 60_000;
export const SLOW_READ_INTERVAL_MS = 5 * 60_000;
export const STATUS_CEILING_MS = 60 * 60_000;

export interface ChunkPlan {
  chunkSize: number;
  chunkCount: number;
  /** Bytes of the last chunk, which absorbs the remainder. */
  finalSize: number;
}

/** Data-model §7 (P24). Null when the file cannot be sent: empty, too large, or a final chunk of 128 MB or more. */
export function chunkPlan(size: number): ChunkPlan | null {
  if (!Number.isInteger(size) || size < 1 || size > MAX_VIDEO_BYTES) return null;
  const chunkSize = Math.min(MAX_CHUNK_BYTES, Math.max(MIN_CHUNK_BYTES, Math.floor(size / TARGET_CHUNKS)));
  const count = Math.floor(size / chunkSize);
  if (count <= 1) return { chunkSize: size, chunkCount: 1, finalSize: size };
  const finalSize = size - (count - 1) * chunkSize;
  if (count > MAX_CHUNKS || finalSize >= MAX_FINAL_CHUNK_BYTES) return null;
  return { chunkSize, chunkCount: count, finalSize };
}

/** The inclusive byte range of chunk `k` (1-based). */
export function chunkRange(plan: ChunkPlan, size: number, k: number): { first: number; last: number } {
  const first = (k - 1) * plan.chunkSize;
  return { first, last: k >= plan.chunkCount ? size - 1 : first + plan.chunkSize - 1 };
}

const iso = z.string().datetime();

/** Non-secret step state (data-model §6). The upload address is only ever sealed. */
export const tiktokStateSchema = z.object({
  v: z.literal(1),
  kind: z.enum(["video", "photo"]),
  phase: z.enum(["creator", "start", "chunks", "status"]),
  restarts: z.number().int().min(0).max(MAX_RESTARTS),
  capWaitSince: iso.optional(),
  nickname: z.string().max(200).optional(),
  fileUrl: z.string().url().optional(),
  fileBytes: z.number().int().min(1).max(MAX_VIDEO_BYTES).optional(),
  chunkSize: z.number().int().min(1).optional(),
  chunkCount: z.number().int().min(1).max(MAX_CHUNKS).optional(),
  chunksSent: z.number().int().min(0).optional(),
  publishId: z.string().min(1).max(64).optional(),
  sealedUploadUrl: z.string().max(2000).optional(),
  uploadIssuedAt: iso.optional(),
  sentAt: iso.optional(),
  reads: z.number().int().min(0).max(200).optional(),
  lastReadAt: iso.optional(),
  lastStatus: z.string().max(40).optional(),
});

export type TikTokState = z.infer<typeof tiktokStateSchema>;

/** Null for anything unreadable or breaking a phase invariant. Never throws. */
export function parseTikTokState(value: unknown): TikTokState | null {
  const parsed = tiktokStateSchema.safeParse(value);
  if (!parsed.success) return null;
  const s = parsed.data;
  switch (s.phase) {
    case "creator":
      return s;
    case "start":
      return s.nickname !== undefined ? s : null;
    case "chunks": {
      if (s.kind !== "video") return null;
      if (!s.fileUrl || !s.fileBytes || !s.chunkSize || !s.chunkCount || !s.publishId || !s.sealedUploadUrl || !s.uploadIssuedAt) return null;
      if (s.chunksSent === undefined || s.chunksSent >= s.chunkCount) return null;
      const plan = chunkPlan(s.fileBytes);
      return plan && plan.chunkSize === s.chunkSize && plan.chunkCount === s.chunkCount ? s : null;
    }
    case "status":
      return s.publishId && s.sentAt ? s : null;
  }
}

/** The state to start over from, keeping the restart count. */
export function creatorState(kind: TikTokState["kind"], restarts = 0, extra: Partial<TikTokState> = {}): TikTokState {
  return { v: 1, kind, phase: "creator", restarts, ...extra };
}

/**
 * P33: a state before publishing whose kind or file no longer matches the content starts over from the creator check.
 * A state after publishing never restarts.
 */
export function fitState(state: TikTokState, file: { kind: TikTokState["kind"]; url?: string; bytes?: number }): TikTokState {
  if (state.phase === "status") return state;
  const kindOk = state.kind === file.kind;
  const fileOk = state.fileUrl === undefined || (state.fileUrl === file.url && state.fileBytes === file.bytes);
  return kindOk && fileOk ? state : creatorState(file.kind, state.restarts, state.capWaitSince ? { capWaitSince: state.capWaitSince } : {});
}

/** P30: when the next status read may happen. Never later than the 60-minute ceiling. */
export function nextReadAt(state: Pick<TikTokState, "sentAt" | "lastReadAt">): Date {
  const sent = Date.parse(state.sentAt ?? "");
  const ceiling = sent + STATUS_CEILING_MS;
  if (!state.lastReadAt) return new Date(Math.min(sent + FIRST_READ_DELAY_MS, ceiling));
  const last = Date.parse(state.lastReadAt);
  const gap = last < sent + FAST_PHASE_MS ? FAST_READ_INTERVAL_MS : SLOW_READ_INTERVAL_MS;
  return new Date(Math.min(Math.max(last + gap, sent + FIRST_READ_DELAY_MS), ceiling));
}
