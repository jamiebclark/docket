import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnreadSummary } from "@/lib/notifications/types";
import { type PollEnv, POLL_INTERVAL_MS, startPolling } from "./poll";

const summary = (count: number): UnreadSummary => ({ count, display: String(count), label: `${count} problems` });

function setup(initial: number, next: Array<number | Error>) {
  let visible = true;
  const visListeners = new Set<() => void>();
  const changedListeners = new Set<() => void>();
  const queue = [...next];
  const fetchSummary = vi.fn(async () => {
    const value = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (value instanceof Error) throw value;
    return summary(value);
  });
  const env: PollEnv = {
    fetchSummary,
    isVisible: () => visible,
    onVisibilityChange: (l) => (visListeners.add(l), () => visListeners.delete(l)),
    onChanged: (l) => (changedListeners.add(l), () => changedListeners.delete(l)),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };
  const onSummary = vi.fn();
  const onAnnounce = vi.fn();
  const stop = startPolling(initial, env, { onSummary, onAnnounce });
  return {
    stop, fetchSummary, onSummary, onAnnounce,
    setVisible(v: boolean) { visible = v; visListeners.forEach((l) => l()); },
    changed: () => changedListeners.forEach((l) => l()),
  };
}

describe("startPolling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("polls every 60 s while visible", async () => {
    const p = setup(0, [0]);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect(p.fetchSummary).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it("does not poll while hidden, and fetches once on becoming visible", async () => {
    const p = setup(0, [0]);
    p.setVisible(false);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(p.fetchSummary).not.toHaveBeenCalled();
    p.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(p.fetchSummary).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it("fetches once on the changed event", async () => {
    const p = setup(0, [0]);
    p.changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.fetchSummary).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it("keeps the last count silently on failure", async () => {
    const p = setup(2, [new Error("boom")]);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(p.onSummary).not.toHaveBeenCalled();
    expect(p.onAnnounce).not.toHaveBeenCalled();
    p.stop();
  });

  it("announces only when the count rises", async () => {
    const p = setup(2, [3, 3, 1]);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(p.onAnnounce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(p.onAnnounce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(p.onAnnounce).toHaveBeenCalledTimes(1);
    expect(p.onSummary).toHaveBeenCalledTimes(3);
    p.stop();
  });

  it("stops polling after stop()", async () => {
    const p = setup(0, [0]);
    p.stop();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect(p.fetchSummary).not.toHaveBeenCalled();
  });
});
