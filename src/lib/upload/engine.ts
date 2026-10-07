import type { ActionResult } from "@/lib/action-result";
import type { LibraryLimits } from "@/server/media/limits";
import { milestonesCrossed, percentOf } from "./milestones";
import { precheck, type PrecheckCode, type PrecheckValues, type VideoMeta } from "./precheck";

/** The queue and state machine of the upload panel (P14). Framework-free: React subscribes to it. */

export const MAX_CONCURRENT = 3;
export const AUTO_RETRY_DELAYS_MS = [1000, 4000] as const; // limit-literal-ok: not a platform limit
export const STATUS_POLL_MS = 2000;
const SIGN_BATCH = 20;

export type RowState =
  | "checking"
  | "refused"
  | "waiting"
  | "uploading"
  | "interrupted"
  | "cancelled"
  | "processing"
  | "ready"
  | "failed";

/** Why a row is refused, interrupted or failed. `upload-ui.ts` words it. */
export type Reason =
  | { kind: "precheck"; code: PrecheckCode; values: PrecheckValues }
  | { kind: "server"; message: string }
  | { kind: "network" }
  | { kind: "docket"; message: string }
  | { kind: "access" }
  | { kind: "storage" }
  | { kind: "parts_missing" }
  | { kind: "deleted" };

export interface AssetLike {
  id: string;
  status: "processing" | "ready" | "failed";
  processingStep: "queued" | "probing" | "poster" | null;
  processingError: string | null;
}

type Refusal = { ok: false; code: string; message: string };
type Res<T> = Promise<ActionResult<T>>;

export interface StatusItem<A> {
  id: string;
  status: "processing" | "ready" | "failed";
  step: "queued" | "probing" | "poster" | null;
  error: string | null;
  waitingForWorker: boolean;
  item: A | null;
}

/** The server actions, bound to a project slug. */
export interface UploadActions<A extends AssetLike> {
  createUpload(input: {
    filename: string;
    kind: "image" | "video";
    declaredType: string;
    bytes: number;
  }): Res<{ ok: true; upload: { id: string; partSize: number; partCount: number; transport: "direct" | "via_app" } } | Refusal>;
  signUploadParts(input: { uploadId: string; partNumbers: number[] }): Res<
    { ok: true; parts: { partNumber: number; url: string; expiresAt: string }[] } | Refusal
  >;
  listUploadedParts(input: { uploadId: string }): Res<
    { ok: true; parts: { partNumber: number; bytes: number }[]; confirmedBytes: number } | Refusal
  >;
  completeUpload(input: { uploadId: string }): Res<{ ok: true; asset: A } | Refusal>;
  cancelUpload(input: { uploadId: string }): Res<{ ok: true } | Refusal>;
  status(input: { ids: string[] }): Res<{ ok: true; items: StatusItem<A>[] }>;
}

export interface Transport {
  /** Status 0 means the request never got an answer. Rejects with an AbortError when `signal` aborts. */
  sendPart(
    url: string,
    blob: Blob,
    opts: { onProgress: (loadedBytes: number) => void; signal: AbortSignal },
  ): Promise<{ status: number; message?: string }>;
}

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type UploadableFile = File;

export type EngineEvent<A> =
  | { type: "started"; id: string; name: string }
  | { type: "milestone"; id: string; name: string; pct: 25 | 50 | 75 }
  | { type: "uploaded"; id: string; name: string; asset: A }
  | { type: "refused" | "interrupted" | "failed"; id: string; name: string; reason: Reason }
  | { type: "ready"; id: string; name: string; asset: A | null };

export interface UploadRowState {
  id: string;
  name: string;
  state: RowState;
  kind: "image" | "video" | null;
  bytesSent: number;
  total: number;
  reason: Reason | null;
  step: AssetLike["processingStep"];
  waitingForWorker: boolean;
  /** The browser could not read the video's metadata, so the checks happen after upload (FR-005). */
  checksAfterUpload: boolean;
  assetId: string | null;
}

export interface EngineDeps<A extends AssetLike> {
  actions: UploadActions<A>;
  transport: Transport;
  readVideo(file: UploadableFile): Promise<VideoMeta | null>;
  readHead(file: UploadableFile): Promise<Uint8Array>;
  limits: LibraryLimits;
  clock: Clock;
  onEvent?(event: EngineEvent<A>): void;
}

export interface UploadEngine {
  add(files: readonly UploadableFile[]): void;
  retry(id: string): void;
  cancel(id: string): void;
  /** Removes a refused, cancelled or failed row. */
  dismiss(id: string): void;
  subscribe(fn: () => void): () => void;
  snapshot(): readonly UploadRowState[];
  /** True while any row is checking, waiting, uploading or finishing: the page must not be left (FR-012). */
  active(): boolean;
}

interface Row {
  view: UploadRowState;
  file: UploadableFile;
  seq: number;
  /** Bumped by cancel and retry, so a superseded run stops silently. */
  run: number;
  abort: AbortController | null;
  session: { id: string; partSize: number; partCount: number } | null;
  confirmed: Map<number, number>;
  urls: Map<number, string>;
  announcedPct: number;
  started: boolean;
  completing: boolean;
  declaredType: string;
}

const isTerminal = (s: RowState) => s === "refused" || s === "cancelled" || s === "ready" || s === "failed";
const isAbort = (e: unknown) => e instanceof Error && e.name === "AbortError";

export function createUploadEngine<A extends AssetLike>(deps: EngineDeps<A>): UploadEngine {
  const { actions, transport, limits, clock } = deps;
  const rows = new Map<string, Row>();
  const listeners = new Set<() => void>();
  let seq = 0;
  let nextId = 0;
  let cached: readonly UploadRowState[] = [];
  let checkChain: Promise<void> = Promise.resolve();
  let pollHandle: unknown = null;

  const emit = (e: EngineEvent<A>) => deps.onEvent?.(e);
  const changed = () => {
    cached = [...rows.values()].sort((a, b) => a.view.id.localeCompare(b.view.id, undefined, { numeric: true })).map((r) => r.view);
    listeners.forEach((fn) => fn());
  };
  const patch = (row: Row, p: Partial<UploadRowState>) => {
    row.view = { ...row.view, ...p };
    changed();
  };
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const handle = clock.setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clock.clearTimeout(handle);
        reject(new DOMException("Aborted", "AbortError"));
      });
    });

  function interrupt(row: Row, reason: Reason) {
    patch(row, { state: "interrupted", reason, bytesSent: confirmedBytes(row) });
    emit({ type: "interrupted", id: row.view.id, name: row.view.name, reason });
    pump();
  }

  /** Words an action failure for the row. Returns null when the call succeeded at the transport level. */
  function failureOf(res: ActionResult<unknown>): Reason | null {
    if (res.ok) return null;
    return res.error === "not_found" ? { kind: "access" } : { kind: "docket", message: res.message };
  }

  function progress(row: Row, sent: number) {
    const total = row.view.total;
    const pct = percentOf(sent, total);
    patch(row, { bytesSent: sent });
    for (const m of milestonesCrossed(row.announcedPct, pct)) {
      if (m === 25 || m === 50 || m === 75) emit({ type: "milestone", id: row.view.id, name: row.view.name, pct: m });
    }
    row.announcedPct = Math.max(row.announcedPct, pct);
  }

  const partBytes = (row: Row, n: number) => {
    const s = row.session!;
    return n < s.partCount ? s.partSize : row.view.total - (s.partCount - 1) * s.partSize;
  };
  const confirmedBytes = (row: Row) => [...row.confirmed.values()].reduce((a, b) => a + b, 0);

  async function ensureUrl(row: Row, n: number, force = false): Promise<string | Reason> {
    const known = row.urls.get(n);
    if (known && !force) return known;
    const missing: number[] = [];
    for (let p = n; p <= row.session!.partCount && missing.length < (force ? 1 : SIGN_BATCH); p++) {
      if (!row.confirmed.has(p)) missing.push(p);
    }
    const res = await actions.signUploadParts({ uploadId: row.session!.id, partNumbers: missing });
    const failure = failureOf(res);
    if (failure) return failure;
    if (!res.ok) return { kind: "network" };
    if (!res.data.ok) return { kind: "docket", message: res.data.message };
    for (const p of res.data.parts) row.urls.set(p.partNumber, p.url);
    return row.urls.get(n) ?? { kind: "docket", message: "The upload could not be signed." };
  }

  /** Sends one part with the automatic retries and the one re-sign of a 403 (P3, P14). Null on success. */
  async function sendOne(row: Row, n: number, run: number, signal: AbortSignal): Promise<Reason | null> {
    const start = (n - 1) * row.session!.partSize;
    const blob = row.file.slice(start, start + partBytes(row, n));
    const base = confirmedBytes(row);
    let resigned = false;
    for (let attempt = 0; ; attempt++) {
      const url = await ensureUrl(row, n);
      if (typeof url !== "string") return url;
      if (row.run !== run) return null;
      const { status, message } = await transport.sendPart(url, blob, {
        signal,
        onProgress: (loaded) => {
          if (row.run === run) progress(row, base + loaded);
        },
      });
      if (row.run !== run) return null;
      if (status >= 200 && status < 300) return null; // limit-literal-ok: not a platform limit
      if (status === 403 && !resigned) {
        resigned = true;
        row.urls.delete(n);
        const fresh = await ensureUrl(row, n, true);
        if (typeof fresh !== "string") return fresh;
        row.urls.set(n, fresh);
        attempt--;
        continue;
      }
      if (status === 0) {
        const delay = AUTO_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) return { kind: "network" };
        await sleep(delay, signal);
        continue;
      }
      if (status === 403 || status >= 500) return { kind: "storage" }; // limit-literal-ok: not a platform limit
      return { kind: "docket", message: message ?? `The server answered ${status}.` };
    }
  }

  async function runUpload(row: Row) {
    const run = ++row.run;
    const controller = new AbortController();
    row.abort = controller;
    const alive = () => row.run === run;
    try {
      patch(row, { state: "uploading", reason: null });
      if (!row.started) {
        row.started = true;
        emit({ type: "started", id: row.view.id, name: row.view.name });
      }
      if (!row.session) {
        const res = await actions.createUpload({
          filename: row.file.name,
          kind: row.view.kind!,
          declaredType: row.declaredType,
          bytes: row.file.size,
        });
        if (!alive()) return;
        const failure = failureOf(res);
        if (failure) return interrupt(row, failure);
        if (!res.ok) return interrupt(row, { kind: "network" });
        if (!res.data.ok) {
          const reason: Reason = { kind: "server", message: res.data.message };
          if (res.data.code === "too_many_open" || res.data.code === "storage_unavailable") return interrupt(row, reason);
          patch(row, { state: "refused", reason });
          emit({ type: "refused", id: row.view.id, name: row.view.name, reason });
          return pump();
        }
        row.session = res.data.upload;
      } else {
        const res = await actions.listUploadedParts({ uploadId: row.session.id });
        if (!alive()) return;
        const failure = failureOf(res);
        if (failure) return interrupt(row, failure);
        if (!res.ok) return interrupt(row, { kind: "network" });
        if (!res.data.ok) {
          // A finished session may be one whose completion succeeded but whose answer was lost: ask completeUpload,
          // which returns the asset for a completed session and refuses otherwise.
          if (res.data.code === "upload_finished") return complete(row, run);
          return interrupt(row, { kind: "docket", message: res.data.message });
        }
        row.confirmed = new Map(res.data.parts.map((p) => [p.partNumber, p.bytes]));
        row.urls.clear();
      }
      progress(row, confirmedBytes(row));
      for (let n = 1; n <= row.session.partCount; n++) {
        if (row.confirmed.has(n)) continue;
        const failure = await sendOne(row, n, run, controller.signal);
        if (!alive()) return;
        if (failure) return interrupt(row, failure);
        row.confirmed.set(n, partBytes(row, n));
        progress(row, confirmedBytes(row));
      }
      await complete(row, run);
    } catch (e) {
      if (!alive() || isAbort(e)) return;
      interrupt(row, { kind: "network" });
    }
  }

  async function complete(row: Row, run: number) {
    const alive = () => row.run === run;
    row.completing = true;
    patch(row, { state: "processing", step: null });
    try {
      const res = await actions.completeUpload({ uploadId: row.session!.id });
      if (!alive()) return;
      const failure = failureOf(res);
      if (failure) return interrupt(row, failure);
      if (!res.ok) return interrupt(row, { kind: "network" });
      if (!res.data.ok) {
        if (res.data.code === "parts_missing") return interrupt(row, { kind: "parts_missing" });
        if (res.data.code === "upload_finished") return interrupt(row, { kind: "docket", message: res.data.message });
        const reason: Reason = { kind: "server", message: res.data.message };
        patch(row, { state: "refused", reason });
        emit({ type: "refused", id: row.view.id, name: row.view.name, reason });
        return pump();
      }
      const asset = res.data.asset;
      emit({ type: "uploaded", id: row.view.id, name: row.view.name, asset });
      patch(row, { assetId: asset.id });
      applyAsset(row, asset);
    } catch {
      if (alive()) interrupt(row, { kind: "network" });
    } finally {
      row.completing = false;
      changed();
    }
  }

  function applyAsset(row: Row, asset: AssetLike & Partial<A>, waiting = false) {
    if (asset.status === "ready") {
      patch(row, { state: "ready", step: null, waitingForWorker: false });
      emit({ type: "ready", id: row.view.id, name: row.view.name, asset: asset as A });
    } else if (asset.status === "failed") {
      const reason: Reason = { kind: "server", message: asset.processingError ?? "Docket could not read this video." };
      patch(row, { state: "failed", reason, step: null });
      emit({ type: "failed", id: row.view.id, name: row.view.name, reason });
    } else {
      patch(row, { state: "processing", step: asset.processingStep, waitingForWorker: waiting });
      schedulePoll();
    }
    pump();
  }

  function schedulePoll() {
    if (pollHandle !== null) return;
    pollHandle = clock.setTimeout(() => {
      pollHandle = null;
      void poll();
    }, STATUS_POLL_MS);
  }

  async function poll() {
    const waiting = [...rows.values()].filter((r) => r.view.state === "processing" && r.view.assetId && !r.completing);
    if (waiting.length === 0) return;
    try {
      const res = await actions.status({ ids: waiting.map((r) => r.view.assetId!) });
      if (res.ok && res.data.ok) {
        const byId = new Map(res.data.items.map((i) => [i.id, i]));
        for (const row of waiting) {
          if (row.view.state !== "processing") continue;
          const item = byId.get(row.view.assetId!);
          if (!item) {
            const reason: Reason = { kind: "deleted" };
            patch(row, { state: "failed", reason, step: null });
            emit({ type: "failed", id: row.view.id, name: row.view.name, reason });
          } else if (item.status === "ready") {
            patch(row, { state: "ready", step: null, waitingForWorker: false });
            emit({ type: "ready", id: row.view.id, name: row.view.name, asset: item.item });
          } else if (item.status === "failed") {
            const reason: Reason = { kind: "server", message: item.error ?? "Docket could not read this video." };
            patch(row, { state: "failed", reason, step: null });
            emit({ type: "failed", id: row.view.id, name: row.view.name, reason });
          } else {
            patch(row, { step: item.step, waitingForWorker: item.waitingForWorker });
          }
        }
      }
    } catch {
      // A lost poll is retried on the next tick.
    }
    if ([...rows.values()].some((r) => r.view.state === "processing" && r.view.assetId)) schedulePoll();
  }

  function pump() {
    let running = [...rows.values()].filter((r) => r.view.state === "uploading").length;
    const queue = [...rows.values()].filter((r) => r.view.state === "waiting").sort((a, b) => a.seq - b.seq);
    for (const row of queue) {
      if (running >= MAX_CONCURRENT) break;
      running++;
      void runUpload(row);
    }
  }

  async function check(row: Row) {
    if (row.view.state !== "checking") return;
    try {
      const head = await deps.readHead(row.file);
      const result = await precheck({ size: row.file.size, head }, limits, () => deps.readVideo(row.file));
      if (row.view.state !== "checking") return;
      if (!result.ok) {
        const reason: Reason = { kind: "precheck", code: result.code, values: result.values };
        patch(row, { state: "refused", reason });
        emit({ type: "refused", id: row.view.id, name: row.view.name, reason });
        return;
      }
      row.declaredType = result.mimeType;
      patch(row, { state: "waiting", kind: result.kind, checksAfterUpload: result.checksAfterUpload });
      pump();
    } catch {
      if (row.view.state !== "checking") return;
      const reason: Reason = { kind: "precheck", code: "unsupported_type", values: {} };
      patch(row, { state: "refused", reason });
      emit({ type: "refused", id: row.view.id, name: row.view.name, reason });
    }
  }

  return {
    add(files) {
      for (const file of files) {
        const id = String(++nextId).padStart(6, "0");
        const row: Row = {
          view: {
            id,
            name: file.name,
            state: "checking",
            kind: null,
            bytesSent: 0,
            total: file.size,
            reason: null,
            step: null,
            waitingForWorker: false,
            checksAfterUpload: false,
            assetId: null,
          },
          file,
          seq: ++seq,
          run: 0,
          abort: null,
          session: null,
          confirmed: new Map(),
          urls: new Map(),
          announcedPct: -1,
          started: false,
          completing: false,
          declaredType: "",
        };
        rows.set(id, row);
        // Checks run in the order chosen, so uploads also start in that order.
        checkChain = checkChain.then(() => check(row));
      }
      changed();
    },
    retry(id) {
      const row = rows.get(id);
      if (!row || row.view.state !== "interrupted") return;
      row.run++;
      row.seq = ++seq;
      patch(row, { state: "waiting", reason: null });
      pump();
    },
    cancel(id) {
      const row = rows.get(id);
      if (!row || isTerminal(row.view.state)) return;
      if (row.view.state === "processing" && !row.completing) return;
      row.run++;
      row.abort?.abort();
      patch(row, { state: "cancelled", reason: null });
      if (row.session) void actions.cancelUpload({ uploadId: row.session.id }).catch(() => undefined);
      pump();
    },
    dismiss(id) {
      const row = rows.get(id);
      if (!row || !["refused", "cancelled", "failed"].includes(row.view.state)) return;
      rows.delete(id);
      changed();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    snapshot: () => cached,
    active() {
      return [...rows.values()].some(
        (r) => r.view.state === "checking" || r.view.state === "waiting" || r.view.state === "uploading" || r.completing,
      );
    },
  };
}
