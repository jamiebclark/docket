// Measures one sample generation through the configured provider (FR-037, research D7).
// Without LLM settings it says so and exits 0: an unconfigured install is not a failure.
import { eq } from "drizzle-orm";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { z } from "zod";
import { crossProject } from "../src/server/dal/scope";
import { INSTALL_CREDENTIAL_OWNER } from "../src/server/dal/credential-owners";
import { createProjectLlmRepo } from "../src/server/dal/project-llm";
import { getDb } from "../src/server/db/client";
import { projects } from "../src/server/db/schema";
import { getLlm, getLlmStatus } from "../src/server/llm";
import { runLlmCheck } from "../src/server/services/generation/check";
import { withCreditHold } from "../src/server/services/generation/credit";
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
  const llm = withCreditHold(deps.llm ?? getLlm(), INSTALL_CREDENTIAL_OWNER);
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

/** `--project <slug>`, or nothing. `null` means a usage error (unknown flag, missing value, repeated flag). */
export function parseArgs(argv: readonly string[]): { project: string | null } | null {
  let project: string | null = null;
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] !== "--project" || project !== null) return null;
    const value = argv[i + 1];
    if (value === undefined) return null;
    project = value;
  }
  return { project };
}

/** The same check the settings surface runs, for one project resolved by slug with no session (cli.md §3). */
export async function mainForProject(slug: string, deps: { log?: (line: string) => void } = {}): Promise<number> {
  const log = deps.log ?? console.log;
  if (!process.env.DATABASE_URL) {
    console.error("Set DATABASE_URL to check a project's credential.");
    return 2;
  }
  const projectId = await crossProject("llm:check: resolve project", async () => {
    const rows = await getDb().select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).limit(1);
    return rows[0]?.id ?? null;
  });
  if (!projectId) {
    console.error("project not found");
    return 2;
  }
  const result = await runLlmCheck(projectId, createProjectLlmRepo(getDb(), projectId));
  if (result.ok) {
    log(`source=${result.source} provider=${result.provider} model=${result.model} outcome=ok latency_ms=${Math.round(result.latencyMs)}`);
    return 0;
  }
  if (result.reason === "failed") {
    log(
      `source=${result.source} provider=${result.provider} model=${result.model} outcome=${result.kind} latency_ms=${Math.round(result.latencyMs)}`,
    );
  } else if (result.reason === "not_configured") {
    log(`source=install outcome=not_configured missing=${result.missingSettings.join(",")}`);
  } else {
    log(`source=project outcome=${result.reason}`);
  }
  return 1;
}

// Run only as the entry point; realpath so a symlinked output directory (macOS /tmp) still matches.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    console.error("Usage: llm:check [-- --project <slug>]");
    process.exit(2);
  } else if (parsed.project) {
    mainForProject(parsed.project).then(
      (code) => process.exit(code),
      () => {
        console.error("llm:check failed unexpectedly.");
        process.exit(1);
      },
    );
  } else {
    main().then(
      (code) => process.exit(code),
      () => {
        console.error("llm:check failed unexpectedly.");
        process.exit(1);
      },
    );
  }
}
