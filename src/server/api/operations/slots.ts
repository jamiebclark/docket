import { z } from "zod";
import type { ApiSlot } from "@/lib/api/schemas";
import {
  AddSlotRequestSchema,
  AddWeekSlotsRequestSchema,
  DeletedSlotSchema,
  OccurrenceSchema,
  SlotSchema,
  UpdateSlotRequestSchema,
  WeekSlotsResultSchema,
} from "@/lib/api/schemas";
import { upcomingQuerySchema } from "@/lib/validation/api";
import { listUpcomingOccurrences } from "../../services/queue";
import { addSlot, addSlotsForWeek, deleteSlot, moveSlot, setSlotPaused } from "../../services/slots";
import type { SlotView } from "../../services/slots";
import { standardErrors } from "./errors-doc";
import { defineOperation } from "./types";

/** `SlotView` → `Slot`: the response shape names the account `accountId`, not `socialAccountId`. */
export function toSlot(slot: SlotView): ApiSlot {
  return { id: slot.id, accountId: slot.socialAccountId, weekday: slot.weekday, localTime: slot.localTime.slice(0, 5), paused: slot.paused };
}

const slotExample = { id: "3f0c1d52-6a8e-4b19-b7c4-9e2d1a0f8c33", accountId: "7c1e2f43-9b0d-4a77-8e55-2a3d4c5b6e71", weekday: 4, localTime: "09:00", paused: false };
const slotParams = z.object({ slotId: z.uuid() });

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
    mcp: { expose: true },
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
  defineOperation({
    id: "addSlot",
    method: "POST",
    path: "/slots",
    permission: "manage_setup",
    tag: "Slots",
    summary: "Add a slot",
    description: "Adds one posting slot for an account at a weekday and time. Requires the `manage_setup` permission.",
    body: {
      kind: "json",
      schema: AddSlotRequestSchema,
      examples: { create: { summary: "Add a slot", value: { accountId: slotExample.accountId, weekday: slotExample.weekday, localTime: slotExample.localTime } } },
    },
    responses: {
      201: { description: "Added", schema: SlotSchema, examples: { created: { summary: "Added", value: slotExample } } },
      ...standardErrors("manage_setup"),
    },
    idempotent: true,
    mcp: { expose: true },
    async run(scope, { body }) {
      const slot = await addSlot(scope, body);
      return { status: 201, body: toSlot(slot) };
    },
  }),
  defineOperation({
    id: "addWeekSlots",
    method: "POST",
    path: "/slots/week",
    permission: "manage_setup",
    tag: "Slots",
    summary: "Book one time on every weekday",
    description:
      "Puts one time on every weekday the account does not already have it on. Days that already have it are reported in `alreadySet`, not refused. Requires the `manage_setup` permission.",
    body: {
      kind: "json",
      schema: AddWeekSlotsRequestSchema,
      examples: { create: { summary: "Book a weekly time", value: { accountId: slotExample.accountId, localTime: slotExample.localTime } } },
    },
    responses: {
      200: {
        description: "The slots created and the weekdays that already had the time",
        schema: WeekSlotsResultSchema,
        examples: {
          halfBooked: {
            summary: "Half-booked week",
            value: { added: [{ ...slotExample, weekday: 4 }, { ...slotExample, weekday: 5 }], alreadySet: [1, 2, 3, 6, 7] },
          },
        },
      },
      ...standardErrors("manage_setup"),
    },
    idempotent: true,
    mcp: { expose: true },
    async run(scope, { body }) {
      const { added, alreadySet } = await addSlotsForWeek(scope, body);
      return { status: 200, body: { added: added.map(toSlot), alreadySet } };
    },
  }),
  defineOperation({
    id: "updateSlot",
    method: "PATCH",
    path: "/slots/{slotId}",
    permission: "manage_setup",
    tag: "Slots",
    summary: "Move, pause or unpause a slot",
    description:
      "Moves a slot to a new weekday and time, or pauses/unpauses it — exactly one of the two per request. Requires the `manage_setup` permission.",
    params: slotParams,
    body: {
      kind: "json",
      schema: UpdateSlotRequestSchema,
      examples: {
        move: { summary: "Move", value: { weekday: 3, localTime: "18:30" } },
        pause: { summary: "Pause", value: { paused: true } },
      },
    },
    resourceParams: ["slotId"],
    responses: {
      200: { description: "Moved or paused/unpaused", schema: SlotSchema, examples: { updated: { summary: "Updated", value: slotExample } } },
      ...standardErrors("manage_setup"),
    },
    idempotent: true,
    mcp: { expose: true },
    async run(scope, { params, body }) {
      const slot =
        "paused" in body
          ? await setSlotPaused(scope, params.slotId, body.paused)
          : await moveSlot(scope, { id: params.slotId, weekday: body.weekday, localTime: body.localTime });
      return { status: 200, body: toSlot(slot) };
    },
  }),
  defineOperation({
    id: "deleteSlot",
    method: "DELETE",
    path: "/slots/{slotId}",
    permission: "manage_setup",
    tag: "Slots",
    summary: "Delete a slot",
    description:
      "Deletes a slot. Posts already scheduled from it keep their times. Requires the `manage_setup` permission.",
    params: slotParams,
    resourceParams: ["slotId"],
    responses: {
      200: { description: "Deleted", schema: DeletedSlotSchema, examples: { deleted: { summary: "Deleted", value: { id: slotExample.id, deleted: true } } } },
      ...standardErrors("manage_setup"),
    },
    idempotent: true,
    mcp: { expose: true, confirm: { effect: "Delete this posting slot." } },
    async run(scope, { params }) {
      await deleteSlot(scope, params.slotId);
      return { status: 200, body: { id: params.slotId, deleted: true } };
    },
  }),
];
