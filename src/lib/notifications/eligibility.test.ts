import { describe, expect, it } from "vitest";
import {
  ATTENTION_KINDS,
  OFF_SEQ,
  anyKindOn,
  compileEligibility,
  kindOn,
  mayNotify,
  offeredPlatforms,
  platformFloorOf,
  preferencesOf,
  switchesToTurnAllOff,
  switchesToTurnAllOn,
  thresholdOf,
  type PreferenceRow,
} from "./eligibility";

function prefs(rows: PreferenceRow[]) {
  return preferencesOf(rows);
}

describe("preferencesOf / thresholdOf", () => {
  it("absent is on at threshold 0", () => {
    const p = prefs([]);
    expect(thresholdOf(p.kinds, "failed")).toBe(0n);
    expect(thresholdOf(p.platforms, "tiktok")).toBe(0n);
  });

  it("a null onFromSeq becomes OFF_SEQ", () => {
    const p = prefs([{ axis: "kind", switchKey: "failed", onFromSeq: null }]);
    expect(thresholdOf(p.kinds, "failed")).toBe(OFF_SEQ);
  });

  it("a non-null onFromSeq is the threshold", () => {
    const p = prefs([{ axis: "platform", switchKey: "tiktok", onFromSeq: 42n }]);
    expect(thresholdOf(p.platforms, "tiktok")).toBe(42n);
  });

  it("ignores an unknown axis rather than throwing", () => {
    const p = prefs([{ axis: "unknown" as never, switchKey: "x", onFromSeq: null }]);
    expect(p.kinds.size).toBe(0);
    expect(p.platforms.size).toBe(0);
  });
});

describe("kindOn / anyKindOn", () => {
  it.each(ATTENTION_KINDS)("every kind on/off threshold for %s", (outcome) => {
    const on = prefs([]);
    expect(kindOn(on, outcome)).toBe(true);
    const off = prefs([{ axis: "kind", switchKey: outcome, onFromSeq: null }]);
    expect(kindOn(off, outcome)).toBe(false);
  });

  it("rolls up to true when any kind is on", () => {
    const allButOneOff = prefs(
      ATTENTION_KINDS.slice(1).map((switchKey) => ({ axis: "kind" as const, switchKey, onFromSeq: null })),
    );
    expect(anyKindOn(allButOneOff)).toBe(true);
  });

  it("rolls up to false only when every kind is off", () => {
    const allOff = prefs(ATTENTION_KINDS.map((switchKey) => ({ axis: "kind" as const, switchKey, onFromSeq: null })));
    expect(anyKindOn(allOff)).toBe(false);
  });
});

describe("platformFloorOf", () => {
  it("is 0 for the empty-keys case (N30)", () => {
    expect(platformFloorOf(prefs([]), [])).toBe(0n);
  });

  it("is the minimum threshold among the given keys", () => {
    const p = prefs([
      { axis: "platform", switchKey: "tiktok", onFromSeq: null },
      { axis: "platform", switchKey: "facebook", onFromSeq: 10n },
    ]);
    expect(platformFloorOf(p, ["tiktok", "facebook"])).toBe(10n);
    expect(platformFloorOf(p, ["tiktok"])).toBe(OFF_SEQ);
    expect(platformFloorOf(p, ["facebook"])).toBe(10n);
  });

  it("an unrecorded platform defaults to 0, making the event eligible", () => {
    const p = prefs([{ axis: "platform", switchKey: "tiktok", onFromSeq: null }]);
    expect(platformFloorOf(p, ["tiktok", "unregistered"])).toBe(0n);
  });
});

describe("mayNotify", () => {
  const p = prefs([{ axis: "kind", switchKey: "failed", onFromSeq: 5n }]);

  it("every combination of floor, kind and platform thresholds", () => {
    expect(mayNotify(p, { outcome: "failed", providerKeys: [], seq: 6n }, 0n)).toBe(true);
    expect(mayNotify(p, { outcome: "failed", providerKeys: [], seq: 5n }, 0n)).toBe(false);
    expect(mayNotify(p, { outcome: "ambiguous", providerKeys: [], seq: 1n }, 0n)).toBe(true);
    expect(mayNotify(p, { outcome: "failed", providerKeys: [], seq: 6n }, 6n)).toBe(false);
  });

  it("a platform switch off blocks even an on kind", () => {
    const withPlatform = prefs([{ axis: "platform", switchKey: "tiktok", onFromSeq: null }]);
    expect(mayNotify(withPlatform, { outcome: "ambiguous", providerKeys: ["tiktok"], seq: 1n }, 0n)).toBe(false);
  });
});

describe("compileEligibility", () => {
  it("groups on member-outcomes sharing a position", () => {
    const p = prefs([
      { axis: "kind", switchKey: "failed", onFromSeq: 10n },
      { axis: "kind", switchKey: "ambiguous", onFromSeq: 10n },
    ]);
    const plan = compileEligibility(p);
    expect(plan.memberGroups).toEqual([{ outcomes: ["failed", "ambiguous"], minSeq: 10n }, { outcomes: ["needs_reauth"], minSeq: 0n }]);
    expect(plan.connectFailed).toEqual({ minSeq: 0n });
    expect(plan.platforms).toBeNull();
  });

  it("is empty when all three member outcomes are off", () => {
    const p = prefs([
      { axis: "kind", switchKey: "failed", onFromSeq: null },
      { axis: "kind", switchKey: "ambiguous", onFromSeq: null },
      { axis: "kind", switchKey: "needs_reauth", onFromSeq: null },
    ]);
    expect(compileEligibility(p).memberGroups).toEqual([]);
  });

  it("connectFailed is null when off", () => {
    const p = prefs([{ axis: "kind", switchKey: "connect_failed", onFromSeq: null }]);
    expect(compileEligibility(p).connectFailed).toBeNull();
  });

  it("platforms is null with no platform switch stored, else one entry per switch", () => {
    expect(compileEligibility(prefs([])).platforms).toBeNull();
    const p = prefs([{ axis: "platform", switchKey: "tiktok", onFromSeq: 7n }]);
    expect(compileEligibility(p).platforms).toEqual([{ key: "tiktok", threshold: 7n }]);
  });
});

describe("offeredPlatforms", () => {
  const registered = [
    { key: "facebook", name: "Facebook" },
    { key: "instagram", name: "Instagram" },
    { key: "tiktok", name: "TikTok" },
  ];

  it("offers a platform with a live account, on by default", () => {
    const offered = offeredPlatforms(prefs([]), ["facebook"], registered);
    expect(offered).toEqual([{ key: "facebook", name: "Facebook", on: true }]);
  });

  it("offers a platform with an off switch even with no live account, in registry order", () => {
    const p = prefs([{ axis: "platform", switchKey: "tiktok", onFromSeq: null }]);
    const offered = offeredPlatforms(p, [], registered);
    expect(offered).toEqual([{ key: "tiktok", name: "TikTok", on: false }]);
  });

  it("omits a platform with neither an account nor a switch", () => {
    expect(offeredPlatforms(prefs([]), [], registered)).toEqual([]);
  });
});

describe("switchesToTurnAllOn / switchesToTurnAllOff", () => {
  it("all-on is the off kinds plus the off offered platforms", () => {
    const p = prefs([
      { axis: "kind", switchKey: "failed", onFromSeq: null },
      { axis: "platform", switchKey: "tiktok", onFromSeq: null },
    ]);
    const offered = [{ key: "tiktok", on: false }, { key: "facebook", on: true }];
    expect(switchesToTurnAllOn(p, offered)).toEqual([
      { axis: "kind", key: "failed" },
      { axis: "platform", key: "tiktok" },
    ]);
  });

  it("all-off is always the four kinds", () => {
    expect(switchesToTurnAllOff()).toEqual(ATTENTION_KINDS.map((key) => ({ axis: "kind", key })));
  });
});
