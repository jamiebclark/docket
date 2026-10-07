// The only importer of `node:child_process` in the app (tests/lint/no-ffmpeg-in-web.test.ts enforces it).
import { spawn } from "node:child_process";
import { assertWorkerProcess } from "./guard";

export interface RunToolOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Stdout is truncated beyond this many bytes (default 1 MiB). */
  maxStdout?: number;
  /** Bytes of stderr kept, from the end (default 2048). */
  stderrTail?: number;
}

export interface RunToolResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderrTail: string;
  /** True when the timeout or the abort signal ended the process. */
  killed: boolean;
}

const KILL_GRACE_MS = 5000;

export class ToolMissingError extends Error {
  constructor(bin: string) {
    super(`${bin} is not installed or not on PATH`);
    this.name = "ToolMissingError";
  }
}

/** Runs `bin` with an argument array (never a shell). SIGTERM on timeout or abort, SIGKILL after 5 s. */
export function runTool(bin: string, args: readonly string[], options: RunToolOptions): Promise<RunToolResult> {
  assertWorkerProcess();
  const maxStdout = options.maxStdout ?? 1_048_576;
  const tailBytes = options.stderrTail ?? 2048;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let killed = false;
    let hardKill: NodeJS.Timeout | undefined;

    const stop = () => {
      if (killed) return;
      killed = true;
      child.kill("SIGTERM");
      hardKill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      hardKill.unref();
    };
    const timer = setTimeout(stop, options.timeoutMs);
    timer.unref();
    const onAbort = () => stop();
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= maxStdout) return;
      const room = maxStdout - stdoutBytes;
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      stdoutBytes += piece.length;
      stdout += piece.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > tailBytes * 4) stderr = stderr.slice(-tailBytes * 2);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(err.code === "ENOENT" ? new ToolMissingError(bin) : err);
    });
    child.on("close", (code, sig) => {
      cleanup();
      resolve({ code, signal: sig, stdout, stderrTail: stderr.slice(-tailBytes), killed });
    });
  });
}
