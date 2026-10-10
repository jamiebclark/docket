import { describe, expect, it } from "vitest";
import {
  additionFocusId,
  announceAdded,
  announceDeleted,
  announcePaused,
  announceMoved,
  announceRefused,
  announceResumed,
  announceRetimed,
  applyOverrides,
  clampToDay,
  conflictAt,
  DUPLICATE_REFUSAL,
  hhmm,
  isNoOpMove,
  minutesOf,
  nextFreeTime,
  roundToStep,
  slotsByWeekday,
  timeAtPosition,
  timeOfMinutes,
  type GridSlotState,
} from "./week-slot-grid-logic";

function slot(overrides: Partial<GridSlotState> = {}): GridSlotState {
  return { id: "slot-1", weekday: 1, localTime: "09:00", paused: false, pending: false, ...overrides };
}

describe("hhmm / minutesOf / timeOfMinutes", () => {
  it("strips seconds", () => {
    expect(hhmm("09:30:00")).toBe("09:30");
    expect(hhmm("09:30")).toBe("09:30");
  });

  it("converts to and from minutes", () => {
    expect(minutesOf("09:30")).toBe(570);
    expect(timeOfMinutes(570)).toBe("09:30");
  });
});

describe("roundToStep", () => {
  it("rounds to the nearest 30-minute boundary", () => {
    expect(roundToStep(570)).toBe(570);
    expect(roundToStep(580)).toBe(570);
    expect(roundToStep(585)).toBe(600);
    expect(roundToStep(600)).toBe(600);
  });
});

describe("clampToDay", () => {
  it("passes through values inside the day", () => {
    expect(clampToDay(600)).toBe(600);
  });

  it("clamps the midnight edge case", () => {
    expect(clampToDay(0)).toBe(0);
    expect(clampToDay(-30)).toBe(0);
    expect(clampToDay(1410)).toBe(1410);
    expect(clampToDay(1440)).toBe(1410);
    expect(clampToDay(1500)).toBe(1410);
  });
});

describe("timeAtPosition", () => {
  it("uses the same formula for a click and a drop", () => {
    const click = timeAtPosition(300, 1200);
    const drop = timeAtPosition(300, 1200);
    expect(click).toBe(drop);
    expect(click).toBe(timeOfMinutes(clampToDay(roundToStep((300 / 1200) * 1440))));
  });

  it("clamps near the bottom of the column", () => {
    expect(timeAtPosition(1199, 1200)).toBe("23:30");
  });
});

describe("slotsByWeekday", () => {
  it("buckets into seven days, ascending by time, ties broken by id", () => {
    const slots: GridSlotState[] = [
      slot({ id: "b", weekday: 1, localTime: "10:00" }),
      slot({ id: "a", weekday: 1, localTime: "10:00" }),
      slot({ id: "c", weekday: 3, localTime: "08:00" }),
    ];
    const buckets = slotsByWeekday(slots);
    expect(buckets).toHaveLength(7);
    expect(buckets[0]!.map((s) => s.id)).toEqual(["a", "b"]);
    expect(buckets[2]!.map((s) => s.id)).toEqual(["c"]);
    expect(buckets[1]).toEqual([]);
  });
});

describe("nextFreeTime", () => {
  it("finds the first free 30-minute boundary at or after 09:00", () => {
    const day: GridSlotState[] = [slot({ localTime: "09:00" })];
    expect(nextFreeTime(day)).toBe("09:30");
  });

  it("wraps to the first free boundary from 00:00 when full from 09:00 onward", () => {
    const day: GridSlotState[] = [];
    for (let m = 540; m < 1440; m += 30) day.push(slot({ id: `s-${m}`, localTime: timeOfMinutes(m) }));
    expect(nextFreeTime(day)).toBe("00:00");
  });

  it("returns null for a day with no free boundary at all", () => {
    const day: GridSlotState[] = [];
    for (let m = 0; m < 1440; m += 30) day.push(slot({ id: `s-${m}`, localTime: timeOfMinutes(m) }));
    expect(nextFreeTime(day)).toBeNull();
  });
});

describe("isNoOpMove", () => {
  it("is true for the same weekday and same rounded time", () => {
    expect(isNoOpMove(slot({ weekday: 1, localTime: "09:00" }), { id: "slot-1", weekday: 1, localTime: "09:05" })).toBe(true);
  });

  it("is false otherwise", () => {
    expect(isNoOpMove(slot({ weekday: 1, localTime: "09:00" }), { id: "slot-1", weekday: 2, localTime: "09:00" })).toBe(false);
    expect(isNoOpMove(slot({ weekday: 1, localTime: "09:00" }), { id: "slot-1", weekday: 1, localTime: "10:00" })).toBe(false);
  });

  it("with exact: true, a typed time near the chip's time is not a no-op", () => {
    expect(isNoOpMove(slot({ weekday: 1, localTime: "08:00" }), { id: "slot-1", weekday: 1, localTime: "08:10" }, true)).toBe(false);
    expect(isNoOpMove(slot({ weekday: 1, localTime: "08:00" }), { id: "slot-1", weekday: 1, localTime: "08:14" }, true)).toBe(false);
  });

  it("with exact: true, only the identical time is a no-op", () => {
    expect(isNoOpMove(slot({ weekday: 1, localTime: "08:00" }), { id: "slot-1", weekday: 1, localTime: "08:00" }, true)).toBe(true);
  });
});

describe("conflictAt", () => {
  it("finds a same-weekday same-time slot", () => {
    const slots = [slot({ id: "other", weekday: 1, localTime: "10:00" })];
    expect(conflictAt(slots, { id: "moving", weekday: 1, localTime: "10:00" })?.id).toBe("other");
  });

  it("ignores the chip being moved via exceptId", () => {
    const slots = [slot({ id: "self", weekday: 1, localTime: "10:00" })];
    expect(conflictAt(slots, { id: "self", weekday: 1, localTime: "10:00" }, "self")).toBeNull();
  });

  it("returns null when free", () => {
    const slots = [slot({ id: "other", weekday: 1, localTime: "10:00" })];
    expect(conflictAt(slots, { id: "moving", weekday: 2, localTime: "10:00" })).toBeNull();
  });
});

describe("applyOverrides", () => {
  it("a patch override wins over the base slot", () => {
    const slots = [{ id: "s1", weekday: 1 as const, localTime: "09:00", paused: false }];
    const overrides = new Map([["s1", { kind: "patch" as const, seq: 1, weekday: 2 as const, localTime: "10:00", paused: true }]]);
    const result = applyOverrides(slots, overrides, []);
    expect(result).toEqual([{ id: "s1", weekday: 2, localTime: "10:00", paused: true, pending: true }]);
  });

  it("a deleted override removes it", () => {
    const slots = [{ id: "s1", weekday: 1 as const, localTime: "09:00", paused: false }];
    const overrides = new Map([["s1", { kind: "deleted" as const, seq: 1 }]]);
    expect(applyOverrides(slots, overrides, [])).toEqual([]);
  });

  it("an Addition renders until cleared", () => {
    const additions = [{ tempId: "temp-1", seq: 1, weekday: 3 as const, localTime: "11:00" }];
    const result = applyOverrides([], new Map(), additions);
    expect(result).toEqual([{ id: "temp-1", weekday: 3, localTime: "11:00", paused: false, pending: true }]);
  });

  it("an override is only cleared by the sequence number that wrote it", () => {
    const slots = [{ id: "s1", weekday: 1 as const, localTime: "09:00", paused: false }];
    const overrides = new Map([["s1", { kind: "patch" as const, seq: 2, weekday: 1 as const, localTime: "09:30", paused: false }]]);
    // seq 1's answer arrives after seq 2 already wrote: the caller must not clear seq 2's override with seq 1's key.
    // applyOverrides itself only renders what is currently in the map, regardless of seq value.
    expect(applyOverrides(slots, overrides, [])[0]!.localTime).toBe("09:30");
    overrides.delete("s1");
    expect(applyOverrides(slots, overrides, [])[0]!.localTime).toBe("09:00");
  });
});

describe("additionFocusId", () => {
  it("names the created slot's chip from the id the add reported", () => {
    expect(additionFocusId("real-1", "week-slot-grid-add-1")).toBe("slot-real-1");
  });

  it("falls back to the column's add button when the add reported no id", () => {
    expect(additionFocusId(undefined, "week-slot-grid-add-1")).toBe("week-slot-grid-add-1");
  });
});

describe("announcements", () => {
  it("every string names the weekday and the time", () => {
    expect(announceAdded(1, "09:00")).toContain("Monday 09:00");
    expect(announceMoved(2, "10:00")).toContain("Tuesday 10:00");
    expect(announceRetimed(3, "11:00")).toContain("Wednesday 11:00");
    expect(announceDeleted(4, "12:00")).toContain("Thursday 12:00");
    expect(announcePaused(5, "13:00")).toContain("Friday 13:00");
    expect(announceResumed(6, "14:00")).toContain("Saturday 14:00");
    expect(announceRefused(7, "15:00", DUPLICATE_REFUSAL)).toContain("Sunday 15:00");
  });

  it("DUPLICATE_REFUSAL matches the server's ConflictError message verbatim", () => {
    expect(DUPLICATE_REFUSAL).toBe("That account already has a slot at that time.");
  });
});
