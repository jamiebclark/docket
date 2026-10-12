// US6 §2: `docs/deployment.md` §7 states the proxy requirements the stream needs, the install's
// connection ceiling, the HTTP/1.1 per-origin note, and that a buffering proxy still works on the
// fallback (FR-030, contracts/server.md, stream-protocol.ts).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HEARTBEAT_MS, MAX_STREAMS_PER_PROCESS } from "../../../src/lib/notifications/stream-protocol";

const doc = readFileSync("docs/deployment.md", "utf8");
const section = doc.split(/^## 7\. /m)[1]?.split(/^## 8\. /m)[0] ?? "";

describe("docs/deployment.md §7 — the stream's proxy requirements", () => {
  it("states buffering must be off for the stream", () => {
    expect(section).toMatch(/buffer/i);
  });

  it("states the read/idle timeout must exceed the heartbeat interval", () => {
    expect(section).toMatch(/timeout/i);
    expect(section).toContain(`${HEARTBEAT_MS / 1000}`);
  });

  it("states HTTP/1.1-or-better with no response transformation", () => {
    expect(section).toMatch(/HTTP\/1\.1/);
  });

  it("states the install ceiling as the per-process cap times the number of web processes", () => {
    expect(section).toContain(`${MAX_STREAMS_PER_PROCESS}`);
    expect(section).toMatch(/web process/i);
  });

  it("notes the HTTP/1.1 six-connections-per-origin limit", () => {
    expect(section).toMatch(/six connections|6 connections/i);
  });

  it("says a proxy that cannot be changed still works on the 60-second fallback", () => {
    expect(section).toMatch(/60.second/i);
    expect(section).toMatch(/fallback|fall back|still works/i);
  });
});
