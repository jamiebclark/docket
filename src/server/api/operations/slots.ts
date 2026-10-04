import { z } from "zod";
import { OccurrenceSchema } from "@/lib/api/schemas";
import { upcomingQuerySchema } from "@/lib/validation/api";
import { listUpcomingOccurrences } from "../../services/queue";
import { defineOperation } from "./types";

export const slotOperations = [
  defineOperation({
    id: "listUpcomingSlots",
    method: "GET",
    path: "/slots/upcoming",
    permission: "read",
    tag: "Slots",
    summary: "List upcoming slot occurrences",
    description: "Free and taken occurrences of active slots. `days` defaults to 14 and is at most 60.",
    query: upcomingQuerySchema,
    responses: { 200: { description: "Occurrences in time order", schema: z.object({ data: z.array(OccurrenceSchema), nextCursor: z.null() }) } },
    idempotent: false,
    async run(scope, { query }) {
      const data = await listUpcomingOccurrences(scope, {
        days: query.days,
        ...(query.accountId ? { accountId: query.accountId } : {}),
        ...(query.from ? { from: query.from } : {}),
      });
      return {
        status: 200,
        body: {
          data: data.map(({ localTime, scheduledAt, ...rest }) => ({ ...rest, scheduledAt, scheduledAtLocal: localTime })),
          nextCursor: null,
        },
      };
    },
  }),
];
