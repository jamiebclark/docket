import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPOSE_ONLY_VARIABLES, INTERNAL_VARIABLES } from "../../src/server/config-registry";
import { ENV_VARIABLES } from "../../src/server/env";
import { LLM_VARIABLES } from "../../src/server/llm/config";
import { listConnectGroups } from "../../src/providers/registry";
import { validateConfiguration } from "../../src/server/startup/validate";

// Research D27 / SC-007: every variable the code reads is validated, registered and documented.

const ROOT = process.cwd();
const SCAN_ROOTS = ["src", "scripts", "drizzle.config.ts", "next.config.ts", "docker-compose.yml", "Dockerfile"];
const NAME = "[A-Z][A-Z0-9_]{2,}";
const READ_PATTERNS = [
  new RegExp(`process\\.env\\.(${NAME})`, "g"),
  new RegExp(`process\\.env\\[["'](${NAME})["']\\]`, "g"),
  new RegExp(`\\b(?:source|src|env)\\.(${NAME})`, "g"),
];
const COMPOSE_PATTERN = new RegExp(`\\$\\{(${NAME})`, "g");

function files(path: string): string[] {
  const full = join(ROOT, path);
  if (statSync(full).isFile()) return [path];
  return readdirSync(full).flatMap((n) => files(join(path, n)));
}

const isTest = (p: string) => /\.test\.[cm]?[tj]sx?$|\/tests?\//.test(p);

function variablesRead(): Map<string, string> {
  const found = new Map<string, string>();
  for (const f of SCAN_ROOTS.flatMap(files).filter((p) => !isTest(p) && /\.(m?[tj]sx?|ya?ml)$|Dockerfile$/.test(p))) {
    const text = readFileSync(join(ROOT, f), "utf8");
    for (const re of READ_PATTERNS) for (const m of text.matchAll(re)) if (m[1] && !found.has(m[1])) found.set(m[1], f);
    if (f.endsWith(".yml")) for (const m of text.matchAll(COMPOSE_PATTERN)) if (m[1] && !found.has(m[1])) found.set(m[1], f);
    if (f === "Dockerfile") {
      for (const line of text.split("\n").filter((l) => /^ENV\s/.test(l))) {
        for (const m of line.matchAll(new RegExp(`(${NAME})=`, "g"))) if (m[1] && !found.has(m[1])) found.set(m[1], f);
      }
    }
  }
  return found;
}

const PROVIDER_VARIABLES = listConnectGroups().flatMap(({ group }) => group.environment.variables.map((v) => v.name));
const CONFIGURABLE = [...new Set([...ENV_VARIABLES, ...LLM_VARIABLES, ...PROVIDER_VARIABLES])];
const KNOWN = new Set([
  ...CONFIGURABLE,
  ...Object.keys(INTERNAL_VARIABLES),
  ...Object.keys(COMPOSE_ONLY_VARIABLES),
]);
const EXAMPLE = readFileSync(join(ROOT, ".env.example"), "utf8");
const LINES = EXAMPLE.split("\n");

const ASSIGN = (name: string) => new RegExp(`^(?:# )?${name}=`);

describe("environment variable coverage", () => {
  it("finds the variables the code reads (the scan itself works)", () => {
    const read = variablesRead();
    for (const n of ["DATABASE_URL", "BETTER_AUTH_SECRET", "LLM_PROVIDER", "NEXT_RUNTIME", "MINIO_IMAGE"]) {
      expect(read.has(n), n).toBe(true);
    }
  });

  it("every variable read is validated, registered as internal, or compose-only", () => {
    const unknown = [...variablesRead()].filter(([n]) => !KNOWN.has(n)).map(([n, f]) => `${n} (${f})`);
    expect(unknown).toEqual([]);
  });

  it("every configurable and compose-only variable is in .env.example with description, marker and default", () => {
    const problems: string[] = [];
    for (const name of [...CONFIGURABLE, ...Object.keys(COMPOSE_ONLY_VARIABLES)]) {
      const at = LINES.findIndex((l) => ASSIGN(name).test(l));
      if (at < 0) {
        problems.push(`${name}: missing`);
        continue;
      }
      const block: string[] = [];
      for (let i = at - 1; i >= 0 && LINES[i]?.startsWith("#") && !LINES[i]?.startsWith("# ---"); i--) block.push(LINES[i] ?? "");
      const text = block.join("\n");
      if (text.replace(/\b(Required|Optional|Group)\./g, "").trim().length < 20) problems.push(`${name}: needs a description comment`);
      if (!/\b(Required|Optional|Group)\./.test(text)) problems.push(`${name}: needs Required., Optional. or Group.`);
      if (!/Default\b|No default\./.test(text)) problems.push(`${name}: needs Default … or No default.`);
    }
    expect(problems).toEqual([]);
  });

  it("lists the groups in the contract order", () => {
    const order = [
      "Core",
      "Auth",
      "Scheduler",
      "Media storage",
      "Generator (LLM)",
      "Meta",
      "Threads",
      "Public API and webhooks",
      "Compose-only",
      "Smoke script",
    ];
    const at = order.map((g) => LINES.findIndex((l) => l.startsWith(`# --- ${g}`)));
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  // Free text, or members of an all-or-none group, are accepted on their own; the group is checked as a whole.
  const ACCEPTED_AS_IS = new Set([
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_REGION",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "LLM_PROVIDER",
    "TRUSTED_IP_HEADERS",
    "TRUSTED_PROXIES",
    "NODE_ENV_PLACEHOLDER",
    ...PROVIDER_VARIABLES.filter((n) => /_APP_ID$|_APP_SECRET$|_LOGIN_CONFIG_ID$/.test(n)),
  ]);
  const GOOD = {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    BETTER_AUTH_SECRET: "x".repeat(40),
    BETTER_AUTH_URL: "http://localhost:3000",
    CREDENTIALS_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  };

  it("the validator reports a malformed value of every checked variable by name", () => {
    const missed: string[] = [];
    for (const name of CONFIGURABLE.filter((n) => !ACCEPTED_AS_IS.has(n))) {
      // The generator group is judged once it has a provider.
      const base: Record<string, string | undefined> = LLM_VARIABLES.includes(name)
        ? { ...GOOD, LLM_PROVIDER: "openai", LLM_MODEL: "m", OPENAI_API_KEY: "k" }
        : { ...GOOD };
      delete base[name];
      const named = ["bad value", "x".repeat(400), "-1"].some((probe) =>
        validateConfiguration({ ...base, [name]: probe }).issues.some((i) => i.name === name),
      );
      if (!named) missed.push(name);
    }
    expect(missed).toEqual([]);
  });

  it("contains no real-looking secret", () => {
    const bad = LINES.filter((l) => /[A-Za-z0-9+/]{43}=|\bEAA[A-Za-z0-9]{10,}|\bsk-[A-Za-z0-9_-]{10,}/.test(l));
    expect(bad).toEqual([]);
  });
});
