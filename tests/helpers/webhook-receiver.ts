import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
  at: number;
}

export type ReceiverReply = number | { status: number; body?: string; delayMs?: number; headers?: Record<string, string> };

export interface WebhookReceiver {
  url: string;
  port: number;
  requests: RecordedRequest[];
  /** Script replies in order; once exhausted the default status applies. */
  script(...replies: ReceiverReply[]): void;
  /** Status for requests with no scripted reply (default 200). */
  setDefault(status: number): void;
  /** Stop accepting connections, as in an outage. Pending connections are dropped. */
  down(): Promise<void>;
  /** Start listening again on the same port. */
  up(): Promise<void>;
  close(): Promise<void>;
}

/** A local `node:http` receiver with scriptable statuses and recorded requests (constitution II: no live network). */
export async function startWebhookReceiver(): Promise<WebhookReceiver> {
  const requests: RecordedRequest[] = [];
  const queue: ReceiverReply[] = [];
  let fallback = 200;
  let listening = false;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8"), at: Date.now() });
      const next = queue.shift() ?? fallback;
      const reply = typeof next === "number" ? { status: next } : next;
      const send = () => {
        res.writeHead(reply.status, (typeof next === "object" && next.headers) || {});
        res.end(typeof next === "object" ? (next.body ?? "") : "");
      };
      const delay = typeof next === "object" ? (next.delayMs ?? 0) : 0;
      if (delay > 0) setTimeout(send, delay);
      else send();
    });
  });

  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        listening = true;
        resolve();
      });
    });
  const stop = () =>
    new Promise<void>((resolve) => {
      if (!listening) return resolve();
      listening = false;
      server.close(() => resolve());
      server.closeAllConnections();
    });

  await listen(0);
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    port,
    requests,
    script: (...replies) => void queue.push(...replies),
    setDefault: (status) => void (fallback = status),
    down: stop,
    up: () => (listening ? Promise.resolve() : listen(port)),
    close: stop,
  };
}
