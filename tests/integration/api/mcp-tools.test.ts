import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { OPERATIONS, type AnyApiOperation } from "../../../src/server/api/operations";
import { updateProject } from "../../../src/server/dal/projects";
import { setStorageForTests } from "../../../src/server/storage";
import { setLlmForTests } from "../../../src/server/llm";
import { ALL_PERMISSIONS, api, createKey, world } from "../../helpers/api";
import { fill, FIXTURES } from "../../helpers/api-fixtures";
import { closeDb } from "../../helpers/db";
import { createDraftPost, createSlots } from "../../helpers/scheduling";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { mcpCall } from "../../helpers/mcp-bridge";
import { createMemoryStorage } from "../../helpers/storage";

type Project = Awaited<ReturnType<typeof world>>["a"];

const READ_IDS = ["listAccounts", "listActivity", "getPost", "getPostTarget", "listMedia", "getMedia", "listUpcomingSlots"];
const WRITE_IDS = ["createPost", "generatePost", "queuePost", "schedulePost"];
const SETUP_IDS = [
  "createProject",
  "createVoiceProfile",
  "updateVoiceProfile",
  "setAccountPostingInstructions",
  "addSlot",
  "addWeekSlots",
  "updateSlot",
  "deleteSlot",
];
const TOOL_IDS = [...READ_IDS, ...WRITE_IDS, ...SETUP_IDS];

function opFor(id: string): AnyApiOperation {
  return OPERATIONS.find((o) => o.id === id)!;
}

/**
 * The same fixture, over HTTP, with an optional Idempotency-Key — used to build the expectation mcpCall's replay
 * must match. `bodyOverride` lets a caller pin a fixture body computed once (e.g. one with random fields) so an
 * idempotency-key replay sees the same request on both channels.
 */
async function httpCall(op: AnyApiOperation, p: Project, key: string, idem?: string, bodyOverride?: unknown) {
  const fx = FIXTURES[op.id]!;
  const params = fx.params?.(p) ?? {};
  const body = bodyOverride !== undefined ? bodyOverride : fx.body ? await fx.body(p) : undefined;
  return api(op.method, `${fill(op, params)}${fx.query ? `?${fx.query}` : ""}`, {
    key,
    ...(body !== undefined ? { body } : {}),
    ...(idem ? { idem } : {}),
  });
}

let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => {
  setStorageForTests(createMemoryStorage());
  w = await world();
});
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});
afterEach(() => setLlmForTests(null));

describe("docket_* tools, authentication and permission (FR-012, FR-013, SC-003, SC-009)", () => {
  it("answers invalid_api_key without a key, missing_permission naming the permission for a key without it, and the same result as the HTTP route for the right key", async () => {
    const lackingKeys = new Map<string, string>();
    const holderKeys = new Map<string, string>();
    for (const id of TOOL_IDS) {
      const op = opFor(id);
      const none = await mcpCall(op, w.a, undefined);
      expect(none.status, `${id} without a key`).toBe(401);
      expect((none.body as { error: { code: string } }).error.code).toBe("invalid_api_key");

      const others = ALL_PERMISSIONS.filter((x) => x !== op.permission);
      if (!lackingKeys.has(op.permission!)) {
        lackingKeys.set(op.permission!, (await createKey(w.a.scope, others, { rateLimitPerMinute: 1000 })).secret);
        holderKeys.set(op.permission!, (await createKey(w.a.scope, [op.permission!], { rateLimitPerMinute: 1000 })).secret);
      }
      const lacking = lackingKeys.get(op.permission!)!;
      const confirmOptsForDenied = op.mcp.expose && op.mcp.confirm ? { confirm: true as const } : {};
      const denied = await mcpCall(op, w.a, lacking, confirmOptsForDenied);
      expect(denied.status, `${id} without ${op.permission}`).toBe(403);
      const deniedBody = denied.body as { error: { code: string; details: unknown; message: string } };
      expect(deniedBody.error.code).toBe("missing_permission");
      expect(deniedBody.error.details).toEqual({ permission: op.permission });
      expect(deniedBody.error.message).toContain(op.permission);

      const holder = holderKeys.get(op.permission!)!;
      if (id === "generatePost") setLlmForTests(createFakeLlm([{ ok: { variants: { mock: { text: "A generated post" } } } }]));
      const idem = op.idempotent ? `equiv-${id}-${Math.random().toString(36).slice(2, 8)}` : undefined;
      const confirmOpts = op.mcp.expose && op.mcp.confirm ? { confirm: true as const } : {};
      const fx = FIXTURES[op.id]!;
      const bodyOnce = fx.body ? await fx.body(w.a) : undefined;
      const bodyOverrides =
        bodyOnce !== undefined && !(bodyOnce instanceof FormData) ? (bodyOnce as Record<string, unknown>) : {};
      const expected = await httpCall(op, w.a, holder, idem, bodyOnce);
      const allowed = await mcpCall(op, w.a, holder, {
        ...confirmOpts,
        ...(idem ? { idempotencyKey: idem } : {}),
        overrides: bodyOverrides,
      });
      expect([401, 403], `${id} with ${op.permission}`).not.toContain(allowed.status);
      expect(allowed.status, id).toBe(expected.status);
      expect(allowed.body, id).toEqual(expected.json);
    }
  });

  it("accepts the key presented as X-API-Key, the same as Authorization: Bearer (FR-008, FR-009)", async () => {
    const key = w.a.keys.all.secret;
    const op = opFor("listAccounts");
    const result = await mcpCall(op, w.a, key, { keyHeader: "x-api-key" });
    expect(result.status).toBe(200);
  });
});

describe("docket_* tools, project isolation (FR-017, FR-018)", () => {
  it("answers another project's resource id exactly as it answers an unknown one", async () => {
    const key = w.a.keys.all.secret;
    const random = "00000000-0000-4000-8000-0000000000ab";
    const foreign: Record<string, string> = {
      postId: w.b.post.id,
      targetId: w.b.targets[0]!.id,
      mediaId: w.b.media.id,
      accountId: w.b.account.id,
      profileId: w.b.voiceProfile.id,
      slotId: w.b.slot!.id,
    };
    let checked = 0;
    for (const id of TOOL_IDS) {
      const op = opFor(id);
      for (const name of op.resourceParams ?? []) {
        if (!(name in foreign)) throw new Error(`no foreign fixture for resourceParam ${name} on ${id}`);
        const confirmOpts = op.mcp.expose && op.mcp.confirm ? { confirm: true as const } : {};
        const other = await mcpCall(op, w.a, key, { ...confirmOpts, overrides: { [name]: foreign[name]! } });
        const unknown = await mcpCall(op, w.a, key, { ...confirmOpts, overrides: { [name]: random } });
        expect(other.status, `${id}.${name}`).toBe(404);
        const strip = (b: unknown) => {
          const e = (b as { error: { code: string; message: string; details?: unknown } }).error;
          return { code: e.code, message: e.message, details: e.details };
        };
        expect(strip(other.body), `${id}.${name}`).toEqual(strip(unknown.body));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("docket_queue_post / docket_schedule_post confirmation (FR-020, FR-021, SC-005)", () => {
  async function freshPost() {
    const { post, targets } = await createDraftPost(w.a.project.id, { accountIds: [w.a.account.id] });
    return { post, targets };
  }

  it("refuses without confirm: true, naming the effect and the argument; leaves the post untouched; accepts with confirm: true", async () => {
    const { post } = await freshPost();
    const op = opFor("queuePost");
    const key = w.a.keys.write.secret;

    for (const bad of ["true", 1, false, undefined]) {
      const overrides: Record<string, unknown> = { postId: post.id };
      if (bad !== undefined) overrides.confirm = bad;
      const r = await mcpCall(op, w.a, key, { overrides });
      expect(r.status, `confirm=${String(bad)}`).toBe(400);
      const body = r.body as { error: { code: string; details: unknown; message: string } };
      expect(body.error.code).toBe("confirmation_required");
      expect(body.error.details).toMatchObject({ argument: "confirm" });
      expect(body.error.message.toLowerCase()).toContain("queue");
      const before = await api("GET", `/posts/${post.id}`, { key });
      expect(before.json.targets.every((t: { status: string }) => t.status !== "queued")).toBe(true);
    }

    const accepted = await mcpCall(op, w.a, key, { confirm: true, overrides: { postId: post.id } });
    expect(accepted.status).toBe(200);
    expect(accepted.isError).toBe(false);
  });

  it("refuses docket_schedule_post without confirm: true and accepts it with confirm: true", async () => {
    const { post } = await freshPost();
    const op = opFor("schedulePost");
    const key = w.a.keys.write.secret;

    const refused = await mcpCall(op, w.a, key, { overrides: { postId: post.id } });
    expect(refused.status).toBe(400);
    expect((refused.body as { error: { code: string } }).error.code).toBe("confirmation_required");

    const accepted = await mcpCall(op, w.a, key, { confirm: true, overrides: { postId: post.id } });
    expect(accepted.status).toBe(200);
    expect(accepted.isError).toBe(false);
  });
});

describe("docket_generate_post conditional confirmation (research D9, data-model.md §2 C*)", () => {
  it("demands no confirmation only for an explicit leave_as_draft, but does for an absent policy or any other policy, accepted with confirm: true", async () => {
    const op = opFor("generatePost");
    const key = w.a.keys.generate.secret;
    const good: FakeStep = { ok: { variants: { mock: { text: "A generated post" } } } };

    setLlmForTests(createFakeLlm([good]));
    const draftPolicy = await mcpCall(op, w.a, key, { overrides: { schedulingPolicy: "leave_as_draft" } });
    expect(draftPolicy.isError, JSON.stringify(draftPolicy.body)).toBe(false);

    setLlmForTests(createFakeLlm([good]));
    const plain = await mcpCall(op, w.a, key);
    expect(plain.status).toBe(400);
    expect((plain.body as { error: { code: string } }).error.code).toBe("confirmation_required");

    setLlmForTests(createFakeLlm([good]));
    const refused = await mcpCall(op, w.a, key, { overrides: { schedulingPolicy: "add_to_queue" } });
    expect(refused.status).toBe(400);
    expect((refused.body as { error: { code: string } }).error.code).toBe("confirmation_required");

    setLlmForTests(createFakeLlm([good]));
    const confirmed = await mcpCall(op, w.a, key, { confirm: true, overrides: { schedulingPolicy: "add_to_queue" } });
    expect(confirmed.isError, JSON.stringify(confirmed.body)).toBe(false);
  });

  it("demands confirmation for an absent schedulingPolicy when the project's default would queue unreviewed (review F2)", async () => {
    const op = opFor("generatePost");
    const key = w.a.keys.generate.secret;
    const good: FakeStep = { ok: { variants: { mock: { text: "A generated post" } } } };

    await updateProject(w.a.project.id, {
      name: w.a.project.name,
      slug: w.a.project.slug,
      timezone: w.a.project.timezone,
      defaultApprovalPolicy: "auto_approve",
      defaultSchedulingPolicy: "add_to_queue",
    });
    try {
      setLlmForTests(createFakeLlm([good]));
      const plain = await mcpCall(op, w.a, key);
      expect(plain.status).toBe(400);
      expect((plain.body as { error: { code: string } }).error.code).toBe("confirmation_required");

      setLlmForTests(createFakeLlm([good]));
      const confirmed = await mcpCall(op, w.a, key, { confirm: true, overrides: { confirmUnreviewedQueue: true } });
      expect(confirmed.isError, JSON.stringify(confirmed.body)).toBe(false);
    } finally {
      await updateProject(w.a.project.id, {
        name: w.a.project.name,
        slug: w.a.project.slug,
        timezone: w.a.project.timezone,
        defaultApprovalPolicy: "review_required",
        defaultSchedulingPolicy: "leave_as_draft",
      });
    }
  });
});

describe("docket_create_project confirmation and slug conflict (FR-020, FR-021, spec US2 acceptance 1-3)", () => {
  it("refuses without confirm: true, naming the slug's permanence, and creates nothing", async () => {
    const op = opFor("createProject");
    const key = w.a.keys.manageSetup.secret;
    const body = { name: "Nope", slug: `p-${Math.random().toString(36).slice(2, 8)}`, timezone: "America/New_York" };

    const refused = await mcpCall(op, w.a, key, { overrides: body });
    expect(refused.status).toBe(400);
    const refusedBody = refused.body as { error: { code: string; message: string; details: unknown } };
    expect(refusedBody.error.code).toBe("confirmation_required");
    expect(refusedBody.error.message.toLowerCase()).toContain("slug");
    expect(refusedBody.error.message.toLowerCase()).toContain("permanent");
    expect(refusedBody.error.message.toLowerCase()).toContain("cannot be removed");
  });

  it("creates the project with confirm: true and an unused slug, matching the HTTP response body", async () => {
    const op = opFor("createProject");
    const key = w.a.keys.manageSetup.secret;
    const body = { name: "Yep", slug: `p-${Math.random().toString(36).slice(2, 8)}`, timezone: "America/New_York" };

    const created = await mcpCall(op, w.a, key, { confirm: true, overrides: body });
    expect(created.isError, JSON.stringify(created.body)).toBe(false);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: body.name, slug: body.slug, timezone: body.timezone });
  });

  it("answers the same 409 slug_taken conflict for a slug held by a project the calling key cannot see", async () => {
    const op = opFor("createProject");
    const slug = `p-${Math.random().toString(36).slice(2, 8)}`;
    const body = { name: "Dup", slug, timezone: "America/New_York" };
    await mcpCall(op, w.a, w.a.keys.manageSetup.secret, { confirm: true, overrides: body });

    const visible = await mcpCall(op, w.a, w.a.keys.manageSetup.secret, { confirm: true, overrides: body });
    const invisible = await mcpCall(op, w.b, w.b.keys.manageSetup.secret, { confirm: true, overrides: body });
    expect(visible.status).toBe(409);
    expect(invisible.status).toBe(409);
    const strip = (b: unknown) => {
      const e = (b as { error: { code: string; message: string; details?: unknown } }).error;
      return { code: e.code, message: e.message, details: e.details };
    };
    expect(strip(visible.body)).toEqual(strip(invisible.body));
    expect((visible.body as { error: { details: unknown } }).error.details).toEqual({ reason: "slug_taken" });
  });
});

describe("docket_delete_slot confirmation (spec US2 acceptance 5)", () => {
  it("refuses without confirm: true, leaving the slot in place; deletes it with confirm: true", async () => {
    const op = opFor("deleteSlot");
    const key = w.a.keys.manageSetup.secret;
    const [slot] = await createSlots(w.a.project.id, w.a.account.id, [{ weekday: 2, localTime: "07:00" }]);

    const refused = await mcpCall(op, w.a, key, { overrides: { slotId: slot!.id } });
    expect(refused.status).toBe(400);
    expect((refused.body as { error: { code: string } }).error.code).toBe("confirmation_required");
    const stillThere = await api("GET", `/slots/upcoming`, { key });
    expect(stillThere.status).toBe(200);

    const accepted = await mcpCall(op, w.a, key, { confirm: true, overrides: { slotId: slot!.id } });
    expect(accepted.isError, JSON.stringify(accepted.body)).toBe(false);
    expect(accepted.body).toEqual({ id: slot!.id, deleted: true });
  });
});

describe("docket_add_week_slots idempotency replay (FR-025, spec US2 acceptance 4)", () => {
  it("books a full week once and replays the same result for the same idempotencyKey", async () => {
    const op = opFor("addWeekSlots");
    const key = w.a.keys.manageSetup.secret;
    const idem = `mcp-week-${Math.random().toString(36).slice(2, 8)}`;
    const overrides = { accountId: w.a.account.id, localTime: "05:30" };

    const first = await mcpCall(op, w.a, key, { idempotencyKey: idem, overrides });
    expect(first.isError, JSON.stringify(first.body)).toBe(false);
    const firstAdded = (first.body as { added: unknown[] }).added;
    expect(firstAdded.length).toBe(7);

    const replay = await mcpCall(op, w.a, key, { idempotencyKey: idem, overrides });
    expect(replay.body).toEqual(first.body);
    expect(replay.headers["Idempotent-Replayed"]).toBe("true");
  });
});

describe("docket_* tools, idempotency replay (FR-025)", () => {
  it("a replayed write with the same idempotencyKey produces one effect and carries the replay marker", async () => {
    const op = opFor("createPost");
    const key = w.a.keys.write.secret;
    const idem = `mcp-replay-${Math.random().toString(36).slice(2, 8)}`;
    const first = await mcpCall(op, w.a, key, { idempotencyKey: idem });
    expect(first.isError, JSON.stringify(first.body)).toBe(false);
    const second = await mcpCall(op, w.a, key, { idempotencyKey: idem });
    expect(second.body).toEqual(first.body);
    expect(second.headers["Idempotent-Replayed"]).toBe("true");
  });

  it("answers idempotency_key_reused for the same key with a different body, exactly as runIdempotent does over HTTP", async () => {
    const op = opFor("createPost");
    const key = w.a.keys.write.secret;
    const idem = `mcp-mismatch-${Math.random().toString(36).slice(2, 8)}`;
    const first = await mcpCall(op, w.a, key, { idempotencyKey: idem });
    expect(first.isError, JSON.stringify(first.body)).toBe(false);
    const second = await mcpCall(op, w.a, key, { idempotencyKey: idem, overrides: { text: "a different draft" } });
    expect(second.status).toBe(422);
    expect((second.body as { error: { code: string } }).error.code).toBe("idempotency_key_reused");
  });

  it("answers idempotency_in_progress with a wait for an in-flight duplicate, exactly as runIdempotent does over HTTP", async () => {
    const op = opFor("createPost");
    const key = w.a.keys.write.secret;
    const idem = `mcp-inflight-${Math.random().toString(36).slice(2, 8)}`;
    const results = await Promise.all(Array.from({ length: 10 }, () => mcpCall(op, w.a, key, { idempotencyKey: idem })));
    const created = results.filter((r) => r.status === 201 && r.headers["Idempotent-Replayed"] === undefined);
    expect(created.length).toBe(1);
    for (const r of results) {
      expect([201, 409]).toContain(r.status);
      if (r.status === 409) {
        expect((r.body as { error: { code: string } }).error.code).toBe("idempotency_in_progress");
        expect(Number(r.headers["Retry-After"])).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe("docket_* tools, rate limiting (FR-015, research D16)", () => {
  it("counts one request per tool call and answers rate_limited on the second, with a wait", async () => {
    const key = (await createKey(w.a.scope, ["read"], { rateLimitPerMinute: 1 })).secret;
    const op = opFor("listAccounts");
    const first = await mcpCall(op, w.a, key);
    expect(first.isError).toBe(false);
    const second = await mcpCall(op, w.a, key);
    expect(second.status).toBe(429);
    expect((second.body as { error: { code: string } }).error.code).toBe("rate_limited");
    expect(second.headers["Retry-After"]).toBeDefined();
  });
});
