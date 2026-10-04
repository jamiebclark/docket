import { promises as dns } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { UrlFetchError } from "../dal/errors";

export const FETCH_MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 30_000;

function listOf(ranges: readonly (readonly [string, number, "ipv4" | "ipv6"])[]): BlockList {
  const list = new BlockList();
  for (const [net, bits, family] of ranges) list.addSubnet(net, bits, family);
  return list;
}

/** Refused under every policy (loopback is lifted for tests only). */
const alwaysBlocked = listOf([
  ["0.0.0.0", 8, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"], // documentation
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"], // documentation
  ["203.0.113.0", 24, "ipv4"], // documentation
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
  ["64:ff9b::", 96, "ipv6"], // NAT64
  ["2002::", 16, "ipv6"], // 6to4
  ["2001::", 32, "ipv6"], // Teredo
  ["2001:db8::", 32, "ipv6"], // documentation
]);

/** Private ranges: refused for `public`, allowed for `webhook` (self-hosted receivers live there). */
const privateRanges = listOf([
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["fc00::", 7, "ipv6"],
]);

const loopback = listOf([
  ["127.0.0.0", 8, "ipv4"],
  ["::1", 128, "ipv6"],
]);

/**
 * `public` is what media-by-URL uses; `webhook` additionally allows private ranges; `allow-loopback` exists
 * for tests against a local server.
 */
export type AddressPolicy = "public" | "webhook" | "allow-loopback";

// On globalThis so a test's `vi.resetModules()` does not drop it.
const loopbackFlag = globalThis as { __docketWebhookLoopback?: boolean };
/** Tests only: lets the `webhook` policy reach a receiver on 127.0.0.1. */
export function setWebhookLoopbackForTests(allow: boolean): void {
  loopbackFlag.__docketWebhookLoopback = allow;
}

/** Expands an IPv6 literal to eight 16-bit groups; null if it is not one. */
function groupsOf(address: string): number[] | null {
  let text = address.split("%")[0]!.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const o = tail[1]!.split(".").map(Number);
    text = text.slice(0, -tail[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ":" + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

/** The IPv4 address hidden in an IPv4-mapped (`::ffff:a.b.c.d`) or IPv4-compatible (`::a.b.c.d`) IPv6 address. */
function embeddedIpv4(address: string): string | null {
  const g = groupsOf(address);
  if (!g || g.slice(0, 5).some((x) => x !== 0)) return null;
  const mapped = g[5] === 0xffff;
  const compatible = g[5] === 0 && (g[6]! > 0 || g[7]! > 1);
  if (!mapped && !compatible) return null;
  return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
}

export function isAllowedAddress(address: string, policy: AddressPolicy = "public"): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    // A mapped or compatible form is judged as the IPv4 address it carries.
    const v4 = embeddedIpv4(address);
    if (v4) return isAllowedAddress(v4, policy);
  }
  const type = family === 4 ? "ipv4" : "ipv6";
  if ((policy === "allow-loopback" || (policy === "webhook" && loopbackFlag.__docketWebhookLoopback === true)) && loopback.check(address, type)) {
    return true;
  }
  if (alwaysBlocked.check(address, type)) return false;
  return policy === "webhook" ? true : !privateRanges.check(address, type);
}

export interface FetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  addressPolicy?: AddressPolicy;
}

export interface FetchedResource {
  bytes: Buffer;
  contentType: string;
  finalUrl: string;
}

const notAllowed = () => new UrlFetchError("url_not_allowed", "That address is not allowed.");

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlFetchError("url_not_allowed", "That is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlFetchError("url_not_allowed", "Only http and https URLs are allowed.");
  }
  if (url.username || url.password) throw new UrlFetchError("url_not_allowed", "URLs with credentials are not allowed.");
  return url;
}

function guardedLookup(policy: AddressPolicy) {
  return (
    hostname: string,
    options: { all?: boolean; family?: number },
    callback: (err: Error | null, address?: string | { address: string; family: number }[], family?: number) => void,
  ) => {
    dns
      .lookup(hostname, { all: true, family: options.family ?? 0 })
      .then((addresses) => {
        // One forbidden answer refuses the name: the checked address is the one the socket uses.
        if (addresses.length === 0 || addresses.some((a) => !isAllowedAddress(a.address, policy))) {
          return callback(notAllowed());
        }
        if (options.all) return callback(null, addresses);
        callback(null, addresses[0]!.address, addresses[0]!.family);
      })
      .catch((err: { code?: string }) =>
        // Keep the resolver's own code (ENOTFOUND, EAI_AGAIN) so callers can tell DNS from a refusal.
        callback(err?.code ? (err as Error) : new UrlFetchError("url_fetch_failed", `Could not resolve ${hostname}.`), undefined),
      );
  };
}

function hop(url: URL, opts: Required<Omit<FetchOptions, "maxRedirects">>, deadline: number): Promise<IncomingMessage> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && !isAllowedAddress(host, opts.addressPolicy)) return Promise.reject(notAllowed());
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new UrlFetchError("url_timeout", "The image took too long to download."));
    const req = send(url, { method: "GET", headers: { accept: "image/*", "user-agent": "Docket" }, lookup: guardedLookup(opts.addressPolicy) as never });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy(new UrlFetchError("url_timeout", "The image took too long to download."));
    }, remaining);
    req.on("response", (res) => {
      // The body read has its own deadline timer; a second one here would race it and
      // destroy the socket first, surfacing a generic error instead of url_timeout.
      clearTimeout(timer);
      resolve(res);
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      if (timedOut) return reject(new UrlFetchError("url_timeout", "The image took too long to download."));
      reject(err instanceof UrlFetchError ? err : new UrlFetchError("url_fetch_failed", "The image could not be downloaded."));
    });
    req.end();
  });
}

async function readBody(res: IncomingMessage, maxBytes: number, deadline: number): Promise<Buffer> {
  const declared = Number(res.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.destroy();
    throw new UrlFetchError("payload_too_large", "The image is too large.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  // The stream may surface a generic close error rather than the one passed to destroy(),
  // so remember that the deadline fired and report it as a timeout either way.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    res.destroy(new UrlFetchError("url_timeout", "The image took too long to download."));
  }, Math.max(1, deadline - Date.now()));
  try {
    for await (const chunk of res as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > maxBytes) {
        res.destroy();
        throw new UrlFetchError("payload_too_large", "The image is too large.");
      }
      chunks.push(chunk);
    }
  } catch (err) {
    if (timedOut) throw new UrlFetchError("url_timeout", "The image took too long to download.");
    if (err instanceof UrlFetchError) throw err;
    throw new UrlFetchError("url_fetch_failed", "The image could not be downloaded.");
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks);
}

/**
 * Downloads a public image URL. Redirects are followed by hand (at most 3) and every hop is re-validated;
 * the destination address is checked inside the socket's `lookup`, so DNS rebinding cannot swap it afterwards.
 */
export async function fetchPublicResource(rawUrl: string, options: FetchOptions): Promise<FetchedResource> {
  const opts = { maxBytes: options.maxBytes, timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS, addressPolicy: options.addressPolicy ?? "public" } as const;
  const maxRedirects = options.maxRedirects ?? FETCH_MAX_REDIRECTS;
  const deadline = Date.now() + opts.timeoutMs;
  let url = parseUrl(rawUrl);
  for (let redirects = 0; ; redirects++) {
    const res = await hop(url, opts, deadline);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (redirects >= maxRedirects) throw new UrlFetchError("url_too_many_redirects", "The URL redirected too many times.");
      url = parseUrl(new URL(res.headers.location, url).toString());
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new UrlFetchError("url_fetch_failed", `The server answered ${status}.`);
    }
    const contentType = String(res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!contentType.startsWith("image/")) {
      res.resume();
      throw new UrlFetchError("unsupported_media_type", "That URL is not an image.");
    }
    return { bytes: await readBody(res, opts.maxBytes, deadline), contentType, finalUrl: url.toString() };
  }
}

export interface GuardedPostOptions {
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  policy: AddressPolicy;
  /** How much of the response to keep; the rest is dropped and the connection closed. */
  excerptBytes?: number;
}

/**
 * POSTs to a URL without following redirects. The destination address is checked before connecting (IP literals)
 * and inside the socket's `lookup` on every connection (host names), so a DNS answer that changes cannot bypass it.
 * Refusals reject with `UrlFetchError("url_not_allowed")`; a timeout rejects with a `TimeoutError`.
 */
export function postGuarded(rawUrl: string, options: GuardedPostOptions): Promise<{ status: number; excerpt: string }> {
  const url = parseUrl(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && !isAllowedAddress(host, options.policy)) return Promise.reject(notAllowed());
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  const cap = options.excerptBytes ?? 4000;
  return new Promise((resolve, reject) => {
    const timeout = () => Object.assign(new Error("The request timed out."), { name: "TimeoutError" });
    const req = send(url, {
      method: "POST",
      // A fresh connection per delivery, so the address check runs every time rather than once per pooled socket.
      agent: false,
      headers: { ...options.headers, "content-length": String(Buffer.byteLength(options.body)) },
      lookup: guardedLookup(options.policy) as never,
    });
    const timer = setTimeout(() => req.destroy(timeout()), options.timeoutMs);
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, excerpt: Buffer.concat(chunks).toString("utf8") });
      };
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= cap) {
          res.destroy();
          finish();
        }
      });
      res.on("end", finish);
      res.on("error", finish);
      res.on("close", finish);
    });
    req.end(options.body);
  });
}
