import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("storage docs (SC-010)", () => {
  it("states the public-bucket requirement before the first setup heading", () => {
    const doc = read("docs/storage.md");
    const firstSetup = doc.indexOf("\n## ");
    const requirement = doc.indexOf("publicly readable");
    expect(requirement).toBeGreaterThan(-1);
    expect(firstSetup).toBeGreaterThan(requirement);
    expect(doc.slice(0, firstSetup)).toMatch(/signed/i);
  });
});

describe("docker-compose.yml offline profile", () => {
  const compose = read("docker-compose.yml");
  const block = (name: string) => compose.split(new RegExp(`^  ${name}:\\n`, "m"))[1]?.split(/^  \S/m)[0] ?? "";

  it("puts minio and storage-init under the offline profile", () => {
    for (const s of ["minio", "storage-init"]) expect(block(s)).toContain('profiles: ["offline"]');
  });

  it("leaves default services without profiles and binds MinIO to loopback", () => {
    for (const s of ["postgres", "web", "worker"]) expect(block(s)).not.toContain("profiles:");
    expect(block("minio")).not.toMatch(/- "\d+:\d+"/);
  });
});
