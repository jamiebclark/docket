import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startImageServer, type ImageServer } from "../../../tests/helpers/image-server";
import { fetchPublicResource, isAllowedAddress } from "./safe-fetch";

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
