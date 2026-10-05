import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listConnectGroups } from "../../../src/providers/registry";
import { ENV_VARIABLES } from "../../../src/server/env";
import { LLM_VARIABLES } from "../../../src/server/llm/config";

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

describe("unraid/docket.xml", () => {
  const template = readFileSync("unraid/docket.xml", "utf8");
  const configs = [...template.matchAll(/<Config\s([\s\S]*?)>([^<]*)<\/Config>/g)].map(([, attrs, value]) => {
    const attr = (n: string) => new RegExp(`\\b${n}="([^"]*)"`).exec(attrs!)?.[1];
    return { target: attr("Target")!, type: attr("Type"), def: attr("Default"), required: attr("Required"), value };
  });
  const variables = configs.filter((c) => c.type === "Variable");
  const providers = listConnectGroups().flatMap(({ group }) => group.environment.variables.map((v) => v.name));
  const known = new Set([...ENV_VARIABLES, ...LLM_VARIABLES, ...providers]);

  it("runs the published image", () => {
    expect(template).toContain("<Repository>ghcr.io/jamiebclark/docket:latest</Repository>");
  });

  it("sets only variables Docket reads", () => {
    expect(variables.length).toBeGreaterThan(0);
    for (const { target } of variables) expect(known.has(target), target).toBe(true);
  });

  it("requires the core settings and runs the scheduler in process", () => {
    for (const name of ["DATABASE_URL", "BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "CREDENTIALS_ENCRYPTION_KEY"]) {
      expect(variables.find((c) => c.target === name)?.required, name).toBe("true");
    }
    const worker = variables.find((c) => c.target === "RUN_WORKER_IN_PROCESS");
    expect([worker?.def, worker?.value]).toEqual(["true", "true"]);
  });

  // An optional field with a default would switch its group on (e.g. S3_REGION alone is an error).
  it("leaves every optional field empty", () => {
    for (const c of variables.filter((v) => v.required !== "true")) expect([c.target, c.def, c.value]).toEqual([c.target, "", ""]);
  });
});
