import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import { createSchedulingRepos } from "../../src/server/dal/scope";
import { mediaAssets } from "../../src/server/db/schema/media";
import { postTargets } from "../../src/server/db/schema/posts";
import { runTick } from "../../src/server/scheduler";
import * as accounts from "../../src/server/services/accounts";
import { setStorageForTests } from "../../src/server/storage";
import { testDb } from "./db";
import { atTime } from "./clock";
import { createFakePds, mintJwt, type FakePds, type FakeResponse, type RecordedRequest, type RouteScript } from "./fake-pds";
import { createVideoAsset, type VideoAssetOptions } from "./factories";
import { postsEnv } from "./posts-env";
import { createDueTarget, parkAllDueTargets } from "./scheduling";
import { createMemoryStorage, type MemoryStorage } from "./storage";

export const SESSION_PATH = "/xrpc/com.atproto.server.createSession";
export const GET_SESSION_PATH = "/xrpc/com.atproto.server.getSession";
export const SERVICE_AUTH_PATH = "/xrpc/com.atproto.server.getServiceAuth";
export const CREATE_RECORD_PATH = "/xrpc/com.atproto.repo.createRecord";
export const VIDEO = {
  limits: "/xrpc/app.bsky.video.getUploadLimits",
  start: "/xrpc/app.bsky.video.startUpload",
  part: "/xrpc/app.bsky.video.uploadPart",
  finish: "/xrpc/app.bsky.video.finishUpload",
  job: "/xrpc/app.bsky.video.getJobStatus",
} as const;
export const VIDEO_HOST = "video.bsky.app";
export const DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
export const CID = "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgzmq2vz2m";
export const ACCESS_JWT = mintJwt(new Date("2030-01-01T01:00:00Z"));
export const REFRESH_JWT = mintJwt(new Date("2030-03-01T00:00:00Z"));
export const MEDIA_ORIGIN = "https://media.example.test";

export const videoBlob = (size = 11_000_000) => ({ $type: "blob", ref: { $link: CID }, mimeType: "video/mp4", size });

export interface VideoScript {
  /** Reply per method; an array is consumed in order and its last entry repeats. Omitted = a sensible success. */
  limits?: RouteScript;
  start?: RouteScript;
  part?: RouteScript;
  finish?: RouteScript;
  job?: RouteScript;
  /** The `getServiceAuth` reply. By default a token that echoes the audience and method it was asked for. */
  serviceAuth?: RouteScript;
  createRecord?: RouteScript;
  partSizeBytes?: number;
}

/**
 * Routes the video service's paths on the same fake as the PDS (the fake matches on method + pathname; tests assert
 * the host from `url`). The service token echoes `<aud>|<lxm>` so a request's token can be traced to its call.
 */
export function routeVideoService(pds: FakePds, script: VideoScript = {}, sizeBytes = 12_000_000): FakePds {
  const partSize = script.partSizeBytes ?? 5_000_000;
  const partCount = Math.ceil(sizeBytes / partSize);
  pds.route("GET", SERVICE_AUTH_PATH, script.serviceAuth ?? ((req) => {
    const q = new URL(req.url).searchParams;
    return { json: { token: `svc.${q.get("aud")}|${q.get("lxm")}` } };
  }));
  pds.route("GET", GET_SESSION_PATH, {
    json: { did: DID, handle: "me.bsky.social", didDoc: { id: DID, service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example.test" }] } },
  });
  pds.route("GET", VIDEO.limits, script.limits ?? { json: { canUpload: true, remainingDailyVideos: 20, remainingDailyBytes: 5_000_000_000 } });
  pds.route("POST", VIDEO.start, script.start ?? { json: { jobId: "job-1", partSizeBytes: partSize, partCount, expiresAt: "2030-01-01T00:00:00.000Z" } });
  pds.route("POST", VIDEO.part, script.part ?? ((req) => ({ json: { partNumber: Number(new URL(req.url).searchParams.get("partNumber")) } })));
  pds.route("POST", VIDEO.finish, script.finish ?? { json: { completedJobId: "job-1", jobStatus: { jobId: "job-1", did: DID, state: "JOB_STATE_CREATED" } } });
  pds.route("GET", VIDEO.job, script.job ?? { json: { jobStatus: { jobId: "job-1", did: DID, state: "JOB_STATE_COMPLETED", blob: videoBlob(sizeBytes) } } });
  pds.route("POST", CREATE_RECORD_PATH, script.createRecord ?? { json: { uri: `at://${DID}/app.bsky.feed.post/3kvid`, cid: CID } });
  return pds;
}

export interface RangeLog {
  /** Every range request answered: `bytes=first-last` → status. */
  calls: { key: string; range: string | null; status: number }[];
}

/** Serves `https://media.example.test/<key>` from memory storage honouring `Range` (206 + `Content-Range`). */
export function rangeFetch(storage: MemoryStorage, next: typeof fetch, opts: { ignoreRanges?: boolean } = {}): { fetch: typeof fetch; log: RangeLog } {
  const log: RangeLog = { calls: [] };
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== MEDIA_ORIGIN) return next(input, init);
    const key = decodeURIComponent(url.pathname.slice(1));
    const body = await storage.get(key);
    const range = new Headers(init?.headers).get("range");
    if (!body) {
      log.calls.push({ key, range, status: 404 });
      return new Response("gone", { status: 404 });
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
    if (!m || opts.ignoreRanges) {
      log.calls.push({ key, range, status: 200 });
      return new Response(new Uint8Array(body), { status: 200, headers: { "content-type": "video/mp4", "content-length": String(body.length) } });
    }
    const first = Number(m[1]);
    const last = Math.min(Number(m[2]), body.length - 1);
    log.calls.push({ key, range, status: 206 });
    return new Response(new Uint8Array(body.subarray(first, last + 1)), {
      status: 206,
      headers: { "content-type": "video/mp4", "content-range": `bytes ${first}-${last}/${body.length}`, "content-length": String(last - first + 1) },
    });
  }) as typeof fetch;
  return { fetch: impl, log };
}

export interface BlueskyVideoOptions {
  /** Stored (and declared) size; default 12,000,000 (three 5,000,000-byte parts). */
  sizeBytes?: number;
  video?: VideoAssetOptions;
  text?: string;
  alt?: string;
  script?: VideoScript;
  ignoreRanges?: boolean;
}

/**
 * An account, a ready video asset whose bytes are stored at the public media URL, and a due Bluesky target, with
 * `fetch` stubbed to the fake PDS + video service + byte-range media server. Call `unstub()` in `afterEach`.
 */
export async function blueskyVideoSetup(opts: BlueskyVideoOptions = {}) {
  await parkAllDueTargets();
  const sizeBytes = opts.sizeBytes ?? 12_000_000;
  const pds = createFakePds();
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const media = rangeFetch(storage, pds.fetch, { ...(opts.ignoreRanges ? { ignoreRanges: true } : {}) });
  vi.stubGlobal("fetch", media.fetch);

  const env = await postsEnv();
  pds.route("POST", SESSION_PATH, { json: { accessJwt: ACCESS_JWT, refreshJwt: REFRESH_JWT, did: DID, handle: "me.bsky.social" } });
  const out = await accounts.connectWithCredentials(env.scope, {
    providerKey: "bluesky",
    fields: { handle: "me.bsky.social", appPassword: "abcd-efgh-ijkl-mnop", pdsUrl: "" },
  });
  if (!out.ok) throw new Error("connect failed");
  routeVideoService(pds, opts.script, sizeBytes);

  const asset = await createVideoAsset(env.project.id, { width: 1080, height: 1920, durationSeconds: 40, ...opts.video, byteSize: sizeBytes });
  const bytes = Buffer.alloc(sizeBytes);
  for (let i = 0; i < sizeBytes; i += 4096) bytes[i] = (i / 4096) % 251;
  await storage.put(asset.storageKey, bytes, "video/mp4");
  const publicUrl = storage.publicUrl(asset.storageKey);
  await testDb().update(mediaAssets).set({ publicUrl }).where(and(eq(mediaAssets.projectId, env.project.id), eq(mediaAssets.id, asset.id)));

  const repos = createSchedulingRepos(testDb(), env.project.id);
  if (opts.alt !== undefined) await repos.media.updateAlt(asset.id, opts.alt);
  const { post, target } = await createDueTarget(env.project.id, out.account.id, { baseText: opts.text ?? "a video" });
  await repos.posts.setMedia(post.id, [asset.id]);

  /** One scheduler tick, optionally with the engine clock fixed at `at`. */
  const tick = async (at?: Date) => {
    const run = async () => (await runTick({ config: {} })).publishing.counts;
    return at ? atTime(at, run) : run();
  };
  const row = async () => (await testDb().select().from(postTargets).where(and(eq(postTargets.projectId, env.project.id), eq(postTargets.id, target.id))))[0]!;
  const requestsTo = (host: string): RecordedRequest[] => pds.requests.filter((r) => new URL(r.url).host === host);
  return {
    env, pds, storage, repos, asset, bytes, post, target, tick, row, ranges: media.log, requestsTo,
    unstub: () => {
      vi.unstubAllGlobals();
      setStorageForTests(undefined);
    },
  };
}

export type { FakeResponse };
