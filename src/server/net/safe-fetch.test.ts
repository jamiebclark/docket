import { promises as dns } from "node:dns";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startImageServer, type ImageServer } from "../../../tests/helpers/image-server";
import { fetchPublicResource, isAllowedAddress, postGuarded, setWebhookLoopbackForTests } from "./safe-fetch";

let server: ImageServer;
beforeAll(async () => {
  server = await startImageServer();
});
afterAll(() => server.close());

const local = { maxBytes: 5_000_000, addressPolicy: "allow-loopback" } as const;
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);

describe("isAllowedAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.0.1", "172.16.5.5", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1"])(
    "refuses %s",
    (ip) => expect(isAllowedAddress(ip)).toBe(false),
  );
  it.each(["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"])("allows %s", (ip) => expect(isAllowedAddress(ip)).toBe(true));
  it("allows loopback only under the test policy", () => {
    expect(isAllowedAddress("127.0.0.1", "allow-loopback")).toBe(true);
    expect(isAllowedAddress("169.254.169.254", "allow-loopback")).toBe(false);
  });
});

describe("fetchPublicResource", () => {
  it("fetches an image", async () => {
    const r = await fetchPublicResource(server.ok, local);
    expect(r.contentType).toBe("image/jpeg");
    expect(r.bytes.length).toBeGreaterThan(100);
  });

  it("follows 3 redirects and refuses a 4th", async () => {
    await expect(fetchPublicResource(server.redirectChain(3), local)).resolves.toMatchObject({ contentType: "image/jpeg" });
    expect(await code(fetchPublicResource(server.redirectChain(4), local))).toBe("url_too_many_redirects");
  });

  it("refuses loopback under the production policy, including literal hosts", async () => {
    expect(await code(fetchPublicResource(server.ok, { maxBytes: 1e6 }))).toBe("url_not_allowed");
    expect(await code(fetchPublicResource("http://[::1]:1/x", { maxBytes: 1e6 }))).toBe("url_not_allowed");
    expect(await code(fetchPublicResource("http://169.254.169.254/latest", { maxBytes: 1e6 }))).toBe("url_not_allowed");
  });

  it("re-validates every redirect target", async () => {
    expect(await code(fetchPublicResource(server.redirectTo("http://169.254.169.254/x"), local))).toBe("url_not_allowed");
    expect(await code(fetchPublicResource(server.redirectTo("http://[::1]:9/x"), { ...local, addressPolicy: "allow-loopback" }))).not.toBe("ok");
  });

  it("refuses other schemes and credentials", async () => {
    expect(await code(fetchPublicResource("file:///etc/passwd", local))).toBe("url_not_allowed");
    expect(await code(fetchPublicResource("http://user:pw@127.0.0.1/x", local))).toBe("url_not_allowed");
  });

  it("maps a bad status, size and timeout", async () => {
    expect(await code(fetchPublicResource(server.status(404), local))).toBe("url_fetch_failed");
    expect(await code(fetchPublicResource(server.oversize(2_000_000), { ...local, maxBytes: 1000 }))).toBe("payload_too_large");
    expect(await code(fetchPublicResource(server.slow(3000), { ...local, timeoutMs: 300 }))).toBe("url_timeout");
  });
});

// One row per refused range (contracts/http-security.md §5): [address, public, webhook].
const TABLE: [string, boolean, boolean][] = [
  ["127.0.0.1", false, false],
  ["::1", false, false],
  ["169.254.169.254", false, false],
  ["0.0.0.0", false, false],
  ["::", false, false],
  ["fe80::1", false, false],
  ["224.0.0.1", false, false],
  ["198.18.0.1", false, false],
  ["2002:7f00:1::", false, false], // 6to4 wrapping 127.0.0.1
  ["2002:0808:0808::1", false, false], // 6to4 wrapping 8.8.8.8: the whole range is refused
  ["2001:0:4136:e378:8000:63bf:3fff:fdd2", false, false], // Teredo
  ["2001:db8::1", false, false],
  ["192.0.2.5", false, false],
  ["198.51.100.5", false, false],
  ["203.0.113.5", false, false],
  ["::ffff:127.0.0.1", false, false],
  ["::ffff:7f00:1", false, false],
  ["::127.0.0.1", false, false], // IPv4-compatible
  ["::ffff:169.254.169.254", false, false],
  ["10.1.2.3", false, true],
  ["172.16.5.5", false, true],
  ["192.168.1.10", false, true],
  ["100.64.0.1", false, true],
  ["fc00::1", false, true],
  ["::ffff:192.168.1.10", false, true],
  ["8.8.8.8", true, true],
  ["::ffff:8.8.8.8", true, true],
  ["2606:4700:4700::1111", true, true],
];

describe("address policies", () => {
  it.each(TABLE)("%s: public=%s webhook=%s", (address, forPublic, forWebhook) => {
    setWebhookLoopbackForTests(false);
    try {
      expect(isAllowedAddress(address, "public")).toBe(forPublic);
      expect(isAllowedAddress(address, "webhook")).toBe(forWebhook);
    } finally {
      setWebhookLoopbackForTests(true);
    }
  });

  it("refuses text that is not an address", () => {
    expect(isAllowedAddress("localhost", "webhook")).toBe(false);
    expect(isAllowedAddress("", "public")).toBe(false);
  });

  it("allow-loopback lifts loopback only, including its mapped form", () => {
    expect(isAllowedAddress("::ffff:127.0.0.1", "allow-loopback")).toBe(true);
    expect(isAllowedAddress("10.0.0.1", "allow-loopback")).toBe(false);
    expect(isAllowedAddress("2002:7f00:1::", "allow-loopback")).toBe(false);
  });
});

describe("postGuarded", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setWebhookLoopbackForTests(true);
  });
  const opts = { headers: { "content-type": "application/json" }, body: "{}", timeoutMs: 2000 } as const;
  const refused = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);

  it("refuses IP literals before connecting", async () => {
    setWebhookLoopbackForTests(false);
    for (const url of ["http://127.0.0.1:1/x", "http://[::1]:1/x", "http://169.254.169.254/x", "http://[::ffff:127.0.0.1]:1/x", "http://[2002:7f00:1::]/x"]) {
      expect(await refused(postGuarded(url, { ...opts, policy: "webhook" }))).toBe("url_not_allowed");
    }
  });

  it("checks the address a host name resolves to on every connection (rebinding)", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as never);
    const url = server.ok.replace("127.0.0.1", "rebind.test");
    setWebhookLoopbackForTests(true);
    const first = await postGuarded(url, { ...opts, policy: "webhook" }).catch((e) => e);
    // The server only answers GET, but reaching it at all proves the first answer was accepted.
    expect(first).toMatchObject({ status: expect.any(Number) });
    // The name now resolves to an address the policy refuses: the new connection is refused.
    setWebhookLoopbackForTests(false);
    expect(await refused(postGuarded(url, { ...opts, policy: "webhook" }))).toBe("url_not_allowed");
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("does not follow redirects", async () => {
    setWebhookLoopbackForTests(true);
    const res = await postGuarded(server.redirectTo("http://169.254.169.254/x"), { ...opts, policy: "webhook" });
    expect(res.status).toBe(302);
  });
});
