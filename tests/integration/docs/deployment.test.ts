import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const doc = readFileSync("docs/deployment.md", "utf8");
const compose = readFileSync("docker-compose.yml", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

function composeServices(): string[] {
  const block = compose.split(/^services:\s*$/m)[1]?.split(/^volumes:\s*$/m)[0] ?? "";
  return [...block.matchAll(/^ {2}([a-z][\w-]*):\s*$/gm)].map((m) => m[1]!);
}

describe("docs/deployment.md", () => {
  it("mentions every docker-compose service", () => {
    const services = composeServices();
    expect(services).toEqual(expect.arrayContaining(["postgres", "web", "worker"]));
    for (const name of services) expect(doc, name).toContain(name);
  });

  it("names the tick endpoint, the encryption-key backup warning and Netlify", () => {
    expect(doc).toContain("/api/internal/tick");
    expect(doc).toMatch(/CREDENTIALS_ENCRYPTION_KEY/);
    expect(doc).toMatch(/Back up this key|Back this key up/i);
    expect(doc).toContain("Netlify");
  });

  it("never claims a verified run without one", () => {
    expect(doc).toMatch(/### Verified run/);
    expect(doc).toMatch(/NOT VERIFIED|Verified on \d{4}-\d{2}-\d{2}/);
  });

  it("cites only pnpm scripts that exist", () => {
    const cited = [...doc.matchAll(/pnpm (?:run )?([a-z][\w:-]*)/g)].map((m) => m[1]!);
    expect(cited.length).toBeGreaterThan(0);
    for (const script of cited) expect(pkg.scripts[script], script).toBeDefined();
  });
});
