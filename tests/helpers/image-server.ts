import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { jpeg } from "./images";

export interface ImageServer {
  /** e.g. `http://127.0.0.1:PORT` */
  origin: string;
  /** A valid JPEG. */
  ok: string;
  /** A chain of `hops` redirects ending at the valid JPEG. */
  redirectChain(hops: number): string;
  /** Redirects once to `target` (any absolute URL, e.g. a private address). */
  redirectTo(target: string): string;
  /** Sends headers then stalls for `ms` before the body. */
  slow(ms?: number): string;
  /** Declares a `Content-Length` of `bytes` and streams that many bytes. */
  oversize(bytes: number): string;
  /** Responds with a status and no image (e.g. 404, 500). */
  status(code: number): string;
  /** Number of requests seen per pathname. */
  hits: Map<string, number>;
  close(): Promise<void>;
}

/** A local image server with redirect chains, slow and oversize modes for URL-import tests. */
export async function startImageServer(): Promise<ImageServer> {
  const image = await jpeg(200, 100);
  const hits = new Map<string, number>();
  const timers = new Set<NodeJS.Timeout>();

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    const [, kind, arg] = url.pathname.split("/");

    if (kind === "ok") {
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": image.length });
      return void res.end(image);
    }
    if (kind === "hop") {
      const left = Number(arg);
      res.writeHead(302, { location: left <= 1 ? "/ok" : `/hop/${left - 1}` });
      return void res.end();
    }
    if (kind === "to") {
      res.writeHead(302, { location: decodeURIComponent(arg ?? "") });
      return void res.end();
    }
    if (kind === "slow") {
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": image.length });
      res.write(image.subarray(0, 10));
      const t = setTimeout(() => res.end(image.subarray(10)), Number(arg) || 10_000);
      timers.add(t);
      return;
    }
    if (kind === "oversize") {
      const total = Number(arg);
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": total });
      const chunk = Buffer.alloc(64 * 1024, 1);
      let sent = 0;
      const pump = () => {
        while (sent < total) {
          const n = Math.min(chunk.length, total - sent);
          sent += n;
          if (!res.write(chunk.subarray(0, n))) return void res.once("drain", pump);
        }
        res.end();
      };
      res.on("error", () => {});
      return pump();
    }
    if (kind === "status") {
      res.writeHead(Number(arg) || 500, { "content-type": "text/plain" });
      return void res.end("no image");
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    ok: `${origin}/ok`,
    redirectChain: (hops) => `${origin}/hop/${hops}`,
    redirectTo: (target) => `${origin}/to/${encodeURIComponent(target)}`,
    slow: (ms = 10_000) => `${origin}/slow/${ms}`,
    oversize: (bytes) => `${origin}/oversize/${bytes}`,
    status: (code) => `${origin}/status/${code}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearTimeout(t);
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
