import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../src/server/crypto/secrets";
import { getDb } from "../src/server/db/client";
import { createProjectLlmRepo } from "../src/server/dal/project-llm";
import { setLlmFactoryForTests, setLlmForTests } from "../src/server/llm";
import type { LlmConfig } from "../src/server/llm/config";
import type { LlmProvider } from "../src/server/llm/types";
import { closeDb } from "../tests/helpers/db";
import { createFakeLlm } from "../tests/helpers/fake-llm";
import { createProjectWithMembers } from "../tests/helpers/factories";
import { clearHolds } from "../tests/helpers/jobs-env";
import { main, mainForProject, parseArgs, UNMEASURED_LINE } from "./llm-check";

const NAMES = ["LLM_PROVIDER", "LLM_MODEL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];

afterEach(async () => {
  setLlmForTests(null);
  setLlmFactoryForTests(null);
  await clearHolds();
});
afterAll(async () => {
  await closeDb();
});

describe("llm-check main()", () => {
  it("prints the measured line with an injected LLM", async () => {
    const lines: string[] = [];
    const ok = { ok: { text: "Hello" } };
    const code = await main({ llm: createFakeLlm([ok, ok, ok]), log: (l) => void lines.push(l) });
    expect(code).toBe(0);
    expect(lines).toEqual([
      "provider=openai model=fake-model outcome=ok latency_ms=5",
      "job_call kind=text outcome=ok latency_ms=5 window_ms=17000 fits=yes",
      "job_call kind=image outcome=ok latency_ms=5 window_ms=17000 fits=yes",
      "jobs budget_ms=20000 reserve_ms=3000 max_items_per_tick=2",
    ]);
  });

  it("prints the failure kind and exits non-zero when the call fails", async () => {
    const lines: string[] = [];
    const code = await main({ llm: createFakeLlm([{ fail: "auth" }]), log: (l) => void lines.push(l) });
    expect(code).toBe(1);
    expect(lines[0]).toContain("outcome=auth");
  });

  it("prints outcome=credit_exhausted and exits non-zero when the call is refused on billing", async () => {
    const lines: string[] = [];
    const code = await main({ llm: createFakeLlm([{ fail: "credit_exhausted" }]), log: (l) => void lines.push(l) });
    expect(code).toBe(1);
    expect(lines[0]).toContain("outcome=credit_exhausted");
  });

  it("behaves identically for a credit_exhausted call with no DATABASE_URL", async () => {
    vi.resetModules();
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const fresh = await import("./llm-check");
      const lines: string[] = [];
      const code = await fresh.main({ llm: createFakeLlm([{ fail: "credit_exhausted" }]), log: (l) => void lines.push(l) });
      expect(code).toBe(1);
      expect(lines[0]).toContain("outcome=credit_exhausted");
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });

  it("prints the unmeasured line and exits 0 with no configuration", async () => {
    const saved = NAMES.map((n) => [n, process.env[n]] as const);
    for (const n of NAMES) delete process.env[n];
    try {
      const lines: string[] = [];
      expect(await main({ log: (l) => void lines.push(l) })).toBe(0);
      expect(lines).toEqual([UNMEASURED_LINE]);
    } finally {
      for (const [n, v] of saved) if (v !== undefined) process.env[n] = v;
    }
  });
});

describe("parseArgs()", () => {
  it("accepts no arguments", () => {
    expect(parseArgs([])).toEqual({ project: null });
  });

  it("accepts --project <slug>", () => {
    expect(parseArgs(["--project", "acme"])).toEqual({ project: "acme" });
  });

  it("refuses --project with no value", () => {
    expect(parseArgs(["--project"])).toBeNull();
  });

  it("refuses an unknown flag", () => {
    expect(parseArgs(["--bogus"])).toBeNull();
  });

  it("refuses --project given twice", () => {
    expect(parseArgs(["--project", "acme", "--project", "other"])).toBeNull();
  });
});

describe("mainForProject()", () => {
  const aadFor = (projectId: string) => `project_llm_credential:${projectId}`;

  it("prints project not found and exits 2 for an unknown slug", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((l) => void errors.push(String(l)));
    try {
      const code = await mainForProject("no-such-project");
      expect(code).toBe(2);
      expect(errors).toEqual(["project not found"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("prints source=project on a project with its own credential", async () => {
    const { project } = await createProjectWithMembers();
    await createProjectLlmRepo(getDb(), project.id).save({
      provider: "openai",
      model: "fake-model",
      keyCiphertext: encryptSecret("sk-good", { aad: aadFor(project.id) }),
      updatedByUserId: null,
    });
    setLlmFactoryForTests((config: LlmConfig): LlmProvider =>
      config.apiKey === "sk-good" ? createFakeLlm([{ ok: { text: "Hello" } }]) : createFakeLlm([{ fail: "unavailable" }]),
    );

    const lines: string[] = [];
    const code = await mainForProject(project.slug, { log: (l) => void lines.push(l) });

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^source=project provider=openai model=fake-model outcome=ok latency_ms=\d+$/);
  });

  it("prints source=install for a project with no credential, and exits non-zero on failure", async () => {
    const { project } = await createProjectWithMembers();
    setLlmForTests(createFakeLlm([{ fail: "auth" }], { provider: "openai", model: "install-model" }));

    const lines: string[] = [];
    const code = await mainForProject(project.slug, { log: (l) => void lines.push(l) });

    expect(code).toBe(1);
    expect(lines).toEqual(["source=install provider=openai model=install-model outcome=auth latency_ms=5"]);
  });

  it("requires DATABASE_URL and exits 2 without one", async () => {
    vi.resetModules();
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const fresh = await import("./llm-check");
      const errors: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((l) => void errors.push(String(l)));
      try {
        const code = await fresh.mainForProject("anything");
        expect(code).toBe(2);
        expect(errors).toEqual(["Set DATABASE_URL to check a project's credential."]);
      } finally {
        spy.mockRestore();
      }
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
});
