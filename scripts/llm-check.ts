// Measures one sample generation through the configured provider (FR-037, research D7).
// Without LLM settings it says so and exits 0: an unconfigured install is not a failure.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { z } from "zod";
import { getLlm, getLlmStatus } from "../src/server/llm";
import { JOB_MIN_CALL_MS, JOB_PERSIST_RESERVE_MS } from "../src/server/scheduler/config";
import type { LlmProvider } from "../src/server/llm/types";

export const UNMEASURED_LINE = "latency: unmeasured; live path verified with mocks only";

// A 64 x 64 solid PNG built on the spot: the "image" job call sends it as bytes.
function tinyPng(): Buffer {
  const size = 64;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  // Each scanline: filter byte 0, then size RGB pixels of one warm colour.
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0xc8)]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Two live calls shaped like a job item (008 research D27), judged against the default tick budget.
 * Returns false when a call fails.
 */
async function jobsReport(llm: LlmProvider, log: (line: string) => void): Promise<boolean> {
  const budgetMs = 20_000;
  const reserveMs = JOB_PERSIST_RESERVE_MS;
  const windowMs = budgetMs - reserveMs;
  let allOk = true;
  for (const kind of ["text", "image"] as const) {
    const result = await llm.generate({
      label: `llm.check.job_${kind}`,
      system: "You write one short, friendly social post.",
      user:
        kind === "text"
          ? "Item: Spring opening. Details: free samples all Saturday. Write one short post."
          : "Write one short post about the attached image.",
      images: kind === "image" ? [{ kind: "bytes", data: tinyPng(), mediaType: "image/png" }] : [],
      schemaName: "check_output",
      schema: z.object({ text: z.string() }),
      timeoutMs: windowMs,
    });
    const outcome = result.ok ? "ok" : result.kind;
    const fits = result.ok && result.latencyMs <= windowMs && windowMs >= JOB_MIN_CALL_MS ? "yes" : "no";
    log(`job_call kind=${kind} outcome=${outcome} latency_ms=${Math.round(result.latencyMs)} window_ms=${windowMs} fits=${fits}`);
    if (!result.ok) allOk = false;
  }
  log(`jobs budget_ms=${budgetMs} reserve_ms=${reserveMs} max_items_per_tick=2`);
  return allOk;
}

export async function main(
  deps: { llm?: LlmProvider; log?: (line: string) => void } = {},
): Promise<number> {
  const log = deps.log ?? console.log;
  if (!deps.llm && !getLlmStatus().configured) {
    log(UNMEASURED_LINE);
    return 0;
  }
  const llm = deps.llm ?? getLlm();
  const result = await llm.generate({
    label: "llm.check",
    system: "You write one short, friendly sentence.",
    user: "Write one sentence welcoming people to a bakery's spring opening.",
    images: [],
    schemaName: "check_output",
    schema: z.object({ text: z.string() }),
    timeoutMs: 30_000,
  });
  const head = `provider=${result.provider} model=${result.model}`;
  const latency = `latency_ms=${Math.round(result.latencyMs)}`;
  if (result.ok) {
    log(`${head} outcome=ok ${latency}`);
    return (await jobsReport(llm, log)) ? 0 : 1;
  }
  log(`${head} outcome=${result.kind} ${latency}`);
  return 1;
}

// Run only as the entry point; realpath so a symlinked output directory (macOS /tmp) still matches.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => process.exit(code),
    () => {
      console.error("llm:check failed unexpectedly.");
      process.exit(1);
    },
  );
}
