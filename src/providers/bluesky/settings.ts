import { z } from "zod";
import { videoUploadSchema } from "./video-state";

export const DEFAULT_PDS_URL = "https://bsky.social";

/** Parses the stored shape only; it does not re-validate rows on read. */
export const blueskySettingsSchema = z.object({ pdsUrl: z.string().default(DEFAULT_PDS_URL) });
export type BlueskySettings = z.infer<typeof blueskySettingsSchema>;

export const blueskyCredentialsSchema = z.object({
  accessJwt: z.string().min(1),
  refreshJwt: z.string().min(1),
  did: z.string().startsWith("did:"),
  handle: z.string().min(1),
});
export type BlueskyCredentials = z.infer<typeof blueskyCredentialsSchema>;

/**
 * Bluesky's write budget: 5,000 points/hour and 35,000 points/day, a create costing 3 points, so
 * `floor(points ÷ 3)` posts. APPROXIMATE (research U3: the source page did not load), and the points
 * are shared with any other app writing to the account. Enforced as declared.
 */
export const BLUESKY_DEFAULT_PUBLISH_LIMITS = [
  { count: 1_666, windowSeconds: 3_600 },
  { count: 11_666, windowSeconds: 86_400 },
] as const;

export const blueskyStateSchema = z.object({
  v: z.literal(1),
  /** handle (normalised) → DID, or null when it did not resolve. Absent = not resolved yet. */
  mentions: z.record(z.string(), z.string().nullable()).optional(),
  /** One per uploaded image, in post order (the blob returned by `uploadBlob`, as plain JSON). */
  blobs: z
    .array(
      z.object({
        $type: z.literal("blob"),
        ref: z.object({ $link: z.string() }),
        mimeType: z.string(),
        size: z.number().int().nonnegative(),
      }),
    )
    .default([]),
  /** The video upload in progress (video posts only; data-model §2). */
  video: videoUploadSchema.optional(),
});
export type BlueskyState = z.infer<typeof blueskyStateSchema>;

/** Strip a leading `@`, trim, lower-case. */
export function normaliseHandle(input: string): string {
  return input.trim().replace(/^@+/, "").trim().toLowerCase();
}

/** `https:` only, no credentials, query or fragment, root path. Returns `url.origin`, or `null` when invalid. */
export function normalisePdsUrl(input: string | undefined): string | null {
  const raw = (input ?? "").trim();
  if (raw === "") return DEFAULT_PDS_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (raw.includes("?") || raw.includes("#")) return null;
  return url.origin;
}
