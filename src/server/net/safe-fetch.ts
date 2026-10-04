import { promises as dns } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { UrlFetchError } from "../dal/errors";

export const FETCH_MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 30_000;

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["64:ff9b::", 96], // NAT64
] as const) {
  blocked.addSubnet(net, bits, "ipv6");
}

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addSubnet("::1", 128, "ipv6");

/** `public` is the only policy production uses; `allow-loopback` exists for tests against a local server. */
export type AddressPolicy = "public" | "allow-loopback";

export function isAllowedAddress(address: string, policy: AddressPolicy = "public"): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  const type = family === 4 ? "ipv4" : "ipv6";
  // IPv4-mapped IPv6 is never a legitimate public destination (and BlockList would conflate it with IPv4).
  if (family === 6 && /^(?:0{0,4}:){2,5}ffff:/i.test(address)) return false;
  if (policy === "allow-loopback" && loopback.check(address, type)) return true;
  return !blocked.check(address, type);
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
      .catch(() => callback(new UrlFetchError("url_fetch_failed", `Could not resolve ${hostname}.`), undefined));
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
    const timer = setTimeout(() => req.destroy(new UrlFetchError("url_timeout", "The image took too long to download.")), remaining);
    req.on("response", (res) => {
      res.on("close", () => clearTimeout(timer));
      resolve(res);
    });
    req.on("error", (err) => {
      clearTimeout(timer);
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
