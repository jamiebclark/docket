import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { docsUrl } from "../../../src/lib/docs";
import { threadsConnectGroup } from "../../../src/providers/threads/connect-group";

const root = resolve(__dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const THREADS_VAR = /\bTHREADS_[A-Z0-9_]+\b/g;
const varsIn = (text: string) => new Set(text.match(THREADS_VAR) ?? []);

const NEXT_CLI_DOC = "node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md";

/** Every `--flag` and `-H`-style flag in a command line. */
function flagsOf(command: string): string[] {
  return command.split(/\s+/).filter((word) => /^--?[A-Za-z]/.test(word));
}

describe("Threads setup documentation (FR-035 to FR-039)", () => {
  const envExample = read(".env.example");
  const declared = threadsConnectGroup.environment.variables.map((v) => v.name);

  it("names only THREADS_ variables that exist in .env.example", () => {
    const exampleVars = varsIn(envExample);
    for (const file of ["docs/meta-setup.md", "README.md"]) {
      for (const name of varsIn(read(file))) expect(exampleVars, `${name} in ${file}`).toContain(name);
    }
    for (const name of declared) expect(exampleVars, `${name} in the group`).toContain(name);
  });

  it("documents every variable the group declares", () => {
    const documented = varsIn(read("docs/meta-setup.md"));
    for (const name of declared) expect(documented).toContain(name);
  });

  it("has the local HTTPS heading that the G10 message links to", () => {
    const doc = read("docs/meta-setup.md");
    expect(doc).toMatch(/^#+ Local HTTPS for Threads\s*$/m);
    expect(threadsConnectGroup.redirectRequirement?.doc).toBe(docsUrl("meta-setup", "local-https-for-threads"));
  });

  it("starts the dev server over HTTPS with flags documented by the installed Next.js", () => {
    const nextDoc = read(NEXT_CLI_DOC);
    const script = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts["dev:https"];
    expect(script).toBeDefined();
    const flags = flagsOf(script ?? "");
    expect(flags.length).toBeGreaterThan(0);
    for (const flag of flags) expect(nextDoc, flag).toContain(`\`${flag}`);
    expect(read("docs/meta-setup.md")).toContain("pnpm dev:https");
  });
});
