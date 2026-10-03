import { afterEach, describe, expect, it, vi } from "vitest";
import { resetInProcessGuard, startInProcessLoop } from "./in-process";

afterEach(resetInProcessGuard);

const on = { RUN_WORKER_IN_PROCESS: true, WORKER_INTERVAL_SECONDS: 60 };

describe("startInProcessLoop", () => {
  it("does nothing unless RUN_WORKER_IN_PROCESS is set", () => {
    const tick = vi.fn(async () => ({}));
    expect(startInProcessLoop({ tick, env: { ...on, RUN_WORKER_IN_PROCESS: false } })).toBeNull();
    expect(tick).not.toHaveBeenCalled();
  });

  it("starts one loop even when called twice", async () => {
    const tick = vi.fn(async () => ({}));
    const first = startInProcessLoop({ tick, env: on });
    const second = startInProcessLoop({ tick, env: on });
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(1));
  });

  it("aborts the loop on SIGTERM", () => {
    const listeners = vi.spyOn(process, "once");
    const controller = startInProcessLoop({ tick: async () => ({}), env: on })!;
    const handler = listeners.mock.calls.find(([event]) => event === "SIGTERM")![1] as () => void;
    handler();
    expect(controller.signal.aborted).toBe(true);
    listeners.mockRestore();
  });
});
