import { Temporal } from "@js-temporal/polyfill";
import { afterAll, describe, expect, it } from "vitest";
import { forProject } from "../../../src/server/dal/scope";
import * as accounts from "../../../src/server/services/accounts";
import * as posts from "../../../src/server/services/posts";
import { occurrencesBetween, resolveOccurrence } from "../../../src/server/services/queue/occurrences";
import * as slots from "../../../src/server/services/slots";
import { fakeSession } from "../../helpers/auth";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";

afterAll(async () => {
  await closeDb();
});

// Research F1: 'compatible' moves a gap forward by its length and takes the earlier instant of an overlap (SC-007).
// These pin behaviour, not the polyfill's ambiguous JSDoc. If one disagrees, record it in docs/decisions.md.
const CASES: [string, string, string, string, string][] = [
  ["New York spring-forward gap", "America/New_York", "2026-03-08", "02:30", "2026-03-08T07:30:00Z"],
  ["New York fall-back overlap", "America/New_York", "2026-11-01", "01:30", "2026-11-01T05:30:00Z"],
  ["London spring-forward gap", "Europe/London", "2026-03-29", "01:30", "2026-03-29T01:30:00Z"],
  ["London fall-back overlap", "Europe/London", "2026-10-25", "01:30", "2026-10-25T00:30:00Z"],
  ["Sydney spring-forward gap", "Australia/Sydney", "2026-10-04", "02:30", "2026-10-03T16:30:00Z"],
  ["Sydney fall-back overlap", "Australia/Sydney", "2026-04-05", "02:30", "2026-04-04T15:30:00Z"],
];

describe("resolveOccurrence across DST", () => {
  it.each(CASES)("%s", (_name, tz, date, time, expected) => {
    expect(resolveOccurrence(Temporal.PlainDate.from(date), Temporal.PlainTime.from(time), tz).toString()).toBe(expected);
  });
  it("a gap time lands after the wall-clock gap, not before it", () => {
    const at = resolveOccurrence(Temporal.PlainDate.from("2026-03-08"), Temporal.PlainTime.from("02:30"), "America/New_York");
    expect(at.toZonedDateTimeISO("America/New_York").toPlainTime().toString()).toBe("03:30:00");
  });
});

describe("weekly slots keep their wall-clock time across a transition", () => {
  it("New York 09:00 Sundays: 14:00Z before spring-forward, 13:00Z after", () => {
    const out = occurrencesBetween(
      [{ id: "a", weekday: 7, localTime: "09:00", paused: false }],
      "America/New_York",
      Temporal.Instant.from("2026-03-01T00:00:00Z"),
      Temporal.Instant.from("2026-03-16T00:00:00Z"),
    );
    expect(out.map((o) => o.instant.toString())).toEqual(["2026-03-01T14:00:00Z", "2026-03-08T13:00:00Z", "2026-03-15T13:00:00Z"]);
  });
  it("a fall-back overlap produces exactly one occurrence for the day", () => {
    const out = occurrencesBetween(
      [{ id: "a", weekday: 7, localTime: "01:30", paused: false }],
      "America/New_York",
      Temporal.Instant.from("2026-10-31T00:00:00Z"),
      Temporal.Instant.from("2026-11-02T00:00:00Z"),
    );
    expect(out.map((o) => o.instant.toString())).toEqual(["2026-11-01T05:30:00Z"]);
  });
});

describe("queue allocation in a DST zone", () => {
  it("schedules the shifted instant and reports the wall-clock time it really lands on", async () => {
    const project = await createProject({ timezone: "America/New_York" });
    const owner = await createUser();
    await addMember(project.id, owner.id, "owner");
    const scope = await forProject(fakeSession(owner.id), project.slug);
    const acct = await accounts.connectMock(scope, { displayName: "NY", settings: {} });
    await slots.addSlot(scope, { accountId: acct.id, weekday: 7, localTime: "02:30" });
    const p1 = await posts.createDraft(scope, { baseText: "gap", targets: [{ accountId: acct.id }] });
    const r = await atTime(new Date("2026-03-02T12:00:00Z"), () => posts.addToQueue(scope, p1.post.id));
    expect(r[0]).toMatchObject({ ok: true, scheduledAt: "2026-03-08T07:30:00.000Z", localTime: "2026-03-08T03:30 America/New_York" });
    // The next post takes the following Sunday (the gap day is held).
    const p2 = await posts.createDraft(scope, { baseText: "next", targets: [{ accountId: acct.id }] });
    const r2 = await atTime(new Date("2026-03-02T12:00:00Z"), () => posts.addToQueue(scope, p2.post.id));
    expect(r2[0]).toMatchObject({ ok: true, scheduledAt: "2026-03-15T06:30:00.000Z" });
  });
});
