import { ApiActivityPageSchema, ApiActivityQuerySchema } from "@/lib/api/schemas";
import { listActivityForApi } from "../../services/activity";
import { defineOperation } from "./types";

const errorExample = (code: string, message: string, details?: unknown) => ({
  error: { code, message, ...(details ? { details } : {}), requestId: "req_example" },
});

const eventId = (n: number) => `6f1c0a2e-3b5d-4c7e-8f90-a1b2c3d4e5f${n}`;
const accountId = "1d0e7a52-6c3b-4f18-9a2d-5e4f3a2b1c0d";
const postId = "9a2b4c6d-8e0f-4a1b-b3c5-d7e9f1a3b5c7";
const targetId = "c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f";

const target = (n: number, kind: string, outcome: string, occurredAt: string, local: string, message: string, details: unknown) => ({
  id: eventId(n),
  kind,
  outcome,
  occurredAt,
  occurredAtLocal: local,
  platform: "instagram",
  platforms: ["instagram"],
  account: { id: accountId, name: "Shop IG", removed: false },
  post: { id: postId, targetId, excerpt: "New autumn range is in…", deleted: false },
  message,
  actor: { type: "scheduler", name: "Scheduler" },
  details,
});

const failed = target(
  1, "target_failed", "failed", "2026-10-06T13:02:11.512Z", "2026-10-06T09:02:11.512-04:00[America/New_York]",
  "Gave up after 5 attempts: The media could not be fetched.", { attempt: 5, gaveUp: true },
);
const ambiguous = target(
  2, "target_ambiguous", "ambiguous", "2026-10-06T12:30:00.000Z", "2026-10-06T08:30:00.000-04:00[America/New_York]",
  "The platform did not confirm whether this was published.", { engine: "recovered_ambiguous" },
);
const published = target(
  3, "target_published", "published", "2026-10-06T10:00:02.100Z", "2026-10-06T06:00:02.100-04:00[America/New_York]",
  "Published to Shop IG.", { url: "https://www.instagram.com/p/Cxyz/" },
);
const needsReauth = {
  id: eventId(4),
  kind: "account_needs_reauth",
  outcome: "needs_reauth",
  occurredAt: "2026-10-05T18:00:00.000Z",
  occurredAtLocal: "2026-10-05T14:00:00.000-04:00[America/New_York]",
  platform: "instagram",
  platforms: ["instagram"],
  account: { id: accountId, name: "Shop IG", removed: false },
  post: null,
  message: "Shop IG needs reconnecting: the platform refused to renew its access.",
  actor: { type: "scheduler", name: "Scheduler" },
  details: { reason: "renewal_refused" },
};

export const activityOperations = [
  defineOperation({
    id: "listActivity",
    method: "GET",
    path: "/activity",
    permission: "read",
    tag: "Activity",
    summary: "List publishing activity",
    description:
      "The project's publishing history, newest first: what published, failed, needs a decision, is retrying, was resolved, or needs reconnecting. " +
      "`from` and `to` are calendar days in the project time zone, both inclusive. The cursor is the last row's position, so new events never shift a walk; poll again with `from` to catch up.",
    query: ApiActivityQuerySchema,
    responses: {
      200: {
        description: "A page of events, newest first",
        schema: ApiActivityPageSchema,
        examples: {
          problems: {
            summary: "outcome=problems",
            value: { data: [failed, ambiguous, needsReauth], nextCursor: "eyJ2IjoyLCJ0IjoiMjAyNi0xMC0wNVQxODowMDowMC4wMDBaIiwicyI6IjQyIiwiZCI6Im9sZGVyIn0" },
          },
          published: { summary: "outcome=published", value: { data: [published], nextCursor: null } },
        },
      },
      400: {
        description: "A bad filter value, an unknown parameter, `from` after `to`, or a bad cursor; `details` lists each field",
        examples: {
          bad_outcome: {
            summary: "An unknown outcome",
            value: errorExample("validation_failed", "The request is not valid.", [
              { code: "invalid_value", field: "outcome", message: '"oops" is not an outcome. Use published, failed, ambiguous, retrying, resolved, needs_reauth, connect_failed, successes, problems.' },
            ]),
          },
          from_after_to: {
            summary: "from after to",
            value: errorExample("validation_failed", "The request is not valid.", [
              { code: "invalid_value", field: "from", message: "The start date is after the end date." },
            ]),
          },
        },
      },
      401: { description: "Missing or invalid API key", examples: { invalid: { summary: "Bad key", value: errorExample("invalid_api_key", "Invalid API key.") } } },
      403: { description: "The key lacks `read`", examples: { missing: { summary: "Key without read", value: errorExample("missing_permission", "This key lacks the read permission.") } } },
    },
    idempotent: false,
    async run(scope, { query }) {
      return { status: 200, body: await listActivityForApi(scope, query) };
    },
  }),
];
