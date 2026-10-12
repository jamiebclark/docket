import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnreadSummary } from "@/lib/notifications/types";
import { fakeStreamHandle, type FakeStreamHandle } from "../../../tests/helpers/stream";
import {
  CLEAN_RECONNECT_DELAY_MS,
  FAILURE_BACKOFF_MS,
  FLAPPING_MS,
  LOCAL_CHANGE_YIELD_MS,
  MAX_CONNECT_ATTEMPTS,
  OPENING_SNAPSHOT_DEADLINE_MS,
} from "@/lib/notifications/stream-protocol";
import { type FetchResult, type RefreshEnv, startRefreshing } from "./refresh";

const summary = (count: number, nextChangeAt: string | null = null): UnreadSummary => ({
  count,
  display: String(count),
  label: `${count} problems`,
  nextChangeAt,
});

function setup(opts: { hasEventSource?: boolean; fallbackMemo?: boolean } = {}) {
  let visible = true;
  let fallbackMemo = opts.fallbackMemo ?? false;
  const visListeners = new Set<() => void>();
  const changedListeners = new Set<() => void>();
  const streams: FakeStreamHandle[] = [];
  const pollStops: Array<() => void> = [];
  const fetchSummary = vi.fn<() => Promise<FetchResult>>(async () => ({ kind: "failed" }));
  const pollFetchSummary = vi.fn<() => Promise<UnreadSummary>>(async () => summary(0));

  const env: RefreshEnv = {
    hasEventSource: () => opts.hasEventSource ?? true,
    openStream: () => {
      const handle = fakeStreamHandle();
      streams.push(handle);
      return handle;
    },
    pollEnv: () => ({
      fetchSummary: pollFetchSummary,
      isVisible: () => visible,
      onVisibilityChange: (l) => (visListeners.add(l), () => visListeners.delete(l)),
      onChanged: (l) => (changedListeners.add(l), () => changedListeners.delete(l)),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
    }),
    fetchSummary,
    isVisible: () => visible,
    onVisibilityChange: (l) => (visListeners.add(l), () => visListeners.delete(l)),
    getFallbackMemo: () => fallbackMemo,
    setFallbackMemo: (v) => {
      fallbackMemo = v;
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    random: () => 0,
  };

  const onSummary = vi.fn();
  const onAnnounce = vi.fn();
  const onPanelRefresh = vi.fn();
  const handle = startRefreshing(summary(0), env, { onSummary, onAnnounce, onPanelRefresh });

  return {
    handle,
    streams,
    onSummary,
    onAnnounce,
    onPanelRefresh,
    fetchSummary,
    pollFetchSummary,
    latestStream: () => streams[streams.length - 1]!,
    setVisible(v: boolean) {
      visible = v;
      visListeners.forEach((l) => l());
    },
    getFallbackMemo: () => fallbackMemo,
  };
}

describe("startRefreshing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("falls straight to polling with no EventSource: no stream attempt is ever made", async () => {
    const r = setup({ hasEventSource: false });
    expect(r.streams.length).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.streams.length).toBe(0);
    r.handle.stop();
  });

  it("falls to polling with no attempt when the fallback is already memoized for this tab", async () => {
    const r = setup({ fallbackMemo: true });
    expect(r.streams.length).toBe(0);
    r.handle.stop();
  });

  it("the opening-snapshot deadline elapsing falls to polling and remembers the fallback", async () => {
    const r = setup();
    expect(r.streams.length).toBe(1);
    await vi.advanceTimersByTimeAsync(OPENING_SNAPSHOT_DEADLINE_MS);
    expect(r.latestStream().closed).toBe(true);
    expect(r.getFallbackMemo()).toBe(true);
    r.handle.stop();
  });

  it("an `unavailable` event (busy) falls to polling and remembers the fallback", async () => {
    const r = setup();
    r.latestStream().emit("unavailable", JSON.stringify({ reason: "busy" }));
    expect(r.latestStream().closed).toBe(true);
    expect(r.getFallbackMemo()).toBe(true);
    r.handle.stop();
  });

  it("an `unavailable` event (displaced) falls to polling and remembers the fallback", async () => {
    const r = setup();
    r.latestStream().emit("unavailable", JSON.stringify({ reason: "displaced" }));
    expect(r.getFallbackMemo()).toBe(true);
    r.handle.stop();
  });

  it("delivers a snapshot once connected, and announces only on a rise", async () => {
    const r = setup();
    r.latestStream().emit("snapshot", JSON.stringify(summary(3)));
    expect(r.onSummary).toHaveBeenCalledTimes(1);
    expect(r.onAnnounce).toHaveBeenCalledTimes(1);
    expect(r.onPanelRefresh).toHaveBeenCalledTimes(1);
    r.latestStream().emit("snapshot", JSON.stringify(summary(1)));
    expect(r.onAnnounce).toHaveBeenCalledTimes(1);
    r.handle.stop();
  });

  it("the per-tab fallback memory persists across a navigation in the same tab, and resets in a fresh tab", async () => {
    vi.resetModules();
    const mod1 = await import("./refresh");
    const first = mod1.browserRefreshEnv();
    first.setFallbackMemo(true);
    const second = mod1.browserRefreshEnv();
    expect(second.getFallbackMemo()).toBe(true);

    vi.resetModules();
    const mod2 = await import("./refresh");
    const fresh = mod2.browserRefreshEnv();
    expect(fresh.getFallbackMemo()).toBe(false);
  });

  it("pulls the poll's trigger once immediately on entering polling, rather than waiting for the interval", async () => {
    const r = setup({ hasEventSource: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(r.onSummary).toHaveBeenCalledTimes(1);
    r.handle.stop();
  });

  it("`reconnect` closes immediately, reopens after CLEAN_RECONNECT_DELAY_MS, and leaves the failure count at zero", async () => {
    const r = setup();
    r.fetchSummary.mockResolvedValue({ kind: "failed" });
    r.latestStream().emit("reconnect");
    expect(r.latestStream().closed).toBe(true);
    await vi.advanceTimersByTimeAsync(CLEAN_RECONNECT_DELAY_MS - 1);
    expect(r.streams.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.streams.length).toBe(2);

    // Exhausting from here still takes the full MAX_CONNECT_ATTEMPTS: the count was not left elevated.
    for (let i = 0; i < MAX_CONNECT_ATTEMPTS - 1; i++) {
      r.latestStream().fail();
      await vi.advanceTimersByTimeAsync(0);
      expect(r.getFallbackMemo()).toBe(false);
      await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MS[i]! * 1.2);
    }
    r.latestStream().fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.getFallbackMemo()).toBe(true);
    r.handle.stop();
  });

  it("onError then a 401 probe ends the session: no reconnect, no fallback poll, ever", async () => {
    const r = setup();
    r.fetchSummary.mockResolvedValueOnce({ kind: "unauthenticated" });
    const before = r.streams.length;
    r.latestStream().fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.fetchSummary).toHaveBeenCalledTimes(1);
    expect(r.streams.length).toBe(before);
    expect(r.onSummary).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.streams.length).toBe(before);
    expect(r.onSummary).not.toHaveBeenCalled();
    r.handle.stop();
  });

  it("onError with a live session (the probe says `ok`) delivers the fresh summary and still counts a failure", async () => {
    const r = setup();
    r.fetchSummary.mockResolvedValueOnce({ kind: "ok", summary: summary(4) });
    r.latestStream().fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.onSummary).toHaveBeenCalledWith(summary(4));
    // Counted as a failure: the next attempt waits for the backoff, not an immediate reconnect.
    expect(r.streams.length).toBe(1);
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MS[0]!);
    expect(r.streams.length).toBe(2);
    r.handle.stop();
  });

  it("a failure within FLAPPING_MS of the opening snapshot counts as a failure, not a clean reconnect", async () => {
    const r = setup();
    r.latestStream().emit("snapshot", JSON.stringify(summary(0)));
    r.fetchSummary.mockResolvedValueOnce({ kind: "failed" });
    await vi.advanceTimersByTimeAsync(FLAPPING_MS - 1);
    r.latestStream().fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.streams.length).toBe(1);
    await vi.advanceTimersByTimeAsync(CLEAN_RECONNECT_DELAY_MS);
    expect(r.streams.length).toBe(1); // the clean-reconnect delay alone is not enough: this was a failure
    await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MS[0]! - CLEAN_RECONNECT_DELAY_MS);
    expect(r.streams.length).toBe(2);
    r.handle.stop();
  });

  it("a failure long after the opening snapshot is not counted: it reconnects at CLEAN_RECONNECT_DELAY_MS", async () => {
    const r = setup();
    r.latestStream().emit("snapshot", JSON.stringify(summary(0)));
    r.fetchSummary.mockResolvedValueOnce({ kind: "failed" });
    await vi.advanceTimersByTimeAsync(FLAPPING_MS + 1);
    r.latestStream().fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.streams.length).toBe(1);
    await vi.advanceTimersByTimeAsync(CLEAN_RECONNECT_DELAY_MS);
    expect(r.streams.length).toBe(2);
    r.handle.stop();
  });

  it("`MAX_CONNECT_ATTEMPTS` failures in a row exhausts into a remembered fallback for the life of the tab", async () => {
    const r = setup();
    r.fetchSummary.mockResolvedValue({ kind: "failed" });
    for (let i = 0; i < MAX_CONNECT_ATTEMPTS; i++) {
      r.latestStream().fail();
      await vi.advanceTimersByTimeAsync(0);
      if (i < MAX_CONNECT_ATTEMPTS - 1) {
        expect(r.getFallbackMemo()).toBe(false);
        await vi.advanceTimersByTimeAsync(FAILURE_BACKOFF_MS[i]!);
      }
    }
    expect(r.getFallbackMemo()).toBe(true);
    const attemptsSoFar = r.streams.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.streams.length).toBe(attemptsSoFar); // stays in polling for the life of the tab
    r.handle.stop();
  });

  it("noteLocalChange drops a snapshot arriving within LOCAL_CHANGE_YIELD_MS, then delivers normally after it", async () => {
    const r = setup();
    r.handle.noteLocalChange(summary(2));
    expect(r.onSummary).toHaveBeenCalledTimes(1);
    expect(r.onSummary).toHaveBeenCalledWith(summary(2));

    await vi.advanceTimersByTimeAsync(LOCAL_CHANGE_YIELD_MS - 1);
    r.latestStream().emit("snapshot", JSON.stringify(summary(5)));
    expect(r.onSummary).toHaveBeenCalledTimes(1); // the stale snapshot was dropped
    expect(r.onAnnounce).not.toHaveBeenCalled();
    expect(r.onPanelRefresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    r.latestStream().emit("snapshot", JSON.stringify(summary(5)));
    expect(r.onSummary).toHaveBeenCalledTimes(2); // the window has elapsed: delivered normally
    expect(r.onSummary).toHaveBeenLastCalledWith(summary(5));
    expect(r.onAnnounce).toHaveBeenCalledTimes(1);
    r.handle.stop();
  });

  it("noteLocalChange with no summary yields the window without touching what is shown", async () => {
    const r = setup();
    r.handle.noteLocalChange();
    expect(r.onSummary).not.toHaveBeenCalled();
    r.latestStream().emit("snapshot", JSON.stringify(summary(9)));
    expect(r.onSummary).not.toHaveBeenCalled(); // still inside the yield window
    r.handle.stop();
  });

  it("shares one `lastShown` announcement baseline across both legs: switching legs neither re-announces nor misses a rise", async () => {
    const r = setup();
    r.latestStream().emit("snapshot", JSON.stringify(summary(3)));
    expect(r.onAnnounce).toHaveBeenCalledTimes(1);

    // Fall to polling: the poll leg must start from the same baseline (3), not the original initial (0),
    // so the unchanged count delivered on entering polling does not look like a rise from 0.
    r.pollFetchSummary.mockResolvedValueOnce(summary(3));
    r.latestStream().emit("unavailable", JSON.stringify({ reason: "busy" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.onAnnounce).toHaveBeenCalledTimes(1);

    // And a genuine rise from that same baseline is still caught.
    r.pollFetchSummary.mockResolvedValueOnce(summary(4));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.onAnnounce).toHaveBeenCalledTimes(2);
    r.handle.stop();
  });
});
