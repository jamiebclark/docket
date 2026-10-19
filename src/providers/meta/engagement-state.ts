import { z } from "zod";

/** contracts/meta-engagement-sweep.md §2. The sweep's entire position lives here (FR-012, FR-013). */
export const metaEngagementStateSchema = z
  .object({
    v: z.literal(1),
    /** ms since epoch: the newest comment time the fresh pass has emitted for this account. */
    freshSince: z.number().int().nonnegative().optional(),
    /** Posts whose comments are mid-walk, oldest queued first. At most MAX_PENDING. */
    pending: z
      .array(z.object({ postId: z.string().min(1).max(100), after: z.string().max(200).optional() }))
      .max(3)
      .optional(),
    /** The catch-up's position in the own-posts listing. Absent + !done = start at the newest page. */
    catchUp: z.object({ postsAfter: z.string().max(200).optional() }).optional(),
    /** The catch-up passed the oldest post the platform will return. Never resumes (SC-004). */
    done: z.literal(true).optional(),
    /** Instagram only. The account's own username, for FR-016. */
    selfUsername: z.string().min(1).max(100).optional(),
    /** Which step ran last, so fresh and catch-up alternate (§4.2 step 3). */
    lastStep: z.enum(["fresh", "catchUp"]).optional(),
  })
  .strict();

export type MetaEngagementState = z.infer<typeof metaEngagementStateSchema>;

const SHRINK_LIMIT_BYTES = 1_500;

function byteLength(state: MetaEngagementState): number {
  return new TextEncoder().encode(JSON.stringify(state)).length;
}

/** Never throws (contracts §2 rule 3): an unparseable or version-mismatched state is a fresh start. */
export function parseEngagementState(raw: unknown): MetaEngagementState {
  const parsed = metaEngagementStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : ({} as MetaEngagementState);
}

/**
 * Serialises `state` and, while it exceeds `SHRINK_LIMIT_BYTES`, drops `pending` entries
 * oldest-first and then `catchUp.postsAfter` (contracts §2 rule 2). Dropping `catchUp.postsAfter`
 * restarts the catch-up from the newest post, losing progress but never items.
 */
export function shrinkEngagementState(state: MetaEngagementState): MetaEngagementState {
  let out = state;
  while (byteLength(out) > SHRINK_LIMIT_BYTES) {
    if (out.pending && out.pending.length > 0) {
      out = { ...out, pending: out.pending.slice(1) };
      continue;
    }
    if (out.catchUp?.postsAfter !== undefined) {
      out = { ...out, catchUp: { ...out.catchUp, postsAfter: undefined } };
      continue;
    }
    break;
  }
  return out;
}
