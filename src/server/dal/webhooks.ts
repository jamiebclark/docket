import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { runCrossProject } from "../db/cross-project";
import {
  projects,
  webhookDeliveries,
  webhookDeliveryAttempts,
  webhookEndpoints,
  webhookEvents,
  type WebhookAttemptRow,
  type WebhookDeliveryRow,
  type WebhookEndpointRow,
  type WebhookEventRow,
  type WebhookEventType,
} from "../db/schema";
import { now } from "./clock";

export type { WebhookEventType };

/** The pool the scheduler's cross-project webhook operations run on. */
export const webhookDb = (): Database => getDb();

export type EndpointRecord = WebhookEndpointRow;
export type EventRecord = WebhookEventRow;
export type DeliveryRecord = WebhookDeliveryRow;
export type AttemptRecord = WebhookAttemptRow;
export type AttemptErrorKind = NonNullable<WebhookAttemptRow["errorKind"]>;

export type NewEndpoint = Pick<
  typeof webhookEndpoints.$inferInsert,
  "id" | "url" | "description" | "events" | "secretEncrypted" | "createdByUserId"
>;
export type EndpointPatch = Partial<Pick<typeof webhookEndpoints.$inferInsert, "url" | "description" | "events">>;

export interface NewAttempt {
  deliveryId: string;
  attempt: number;
  statusCode: number | null;
  errorKind: AttemptErrorKind | null;
  durationMs: number;
  responseExcerpt: string | null;
}

export interface WebhooksRepo {
  readonly projectId: string;
  countEndpoints(): Promise<number>;
  insertEndpoint(input: NewEndpoint): Promise<EndpointRecord>;
  listEndpoints(): Promise<EndpointRecord[]>;
  getEndpoint(id: string): Promise<EndpointRecord | null>;
  updateEndpoint(id: string, patch: EndpointPatch): Promise<EndpointRecord | null>;
  deleteEndpoint(id: string): Promise<boolean>;
  /** Enables (clearing the reason and the failure count) or disables with a reason. */
  setEnabled(id: string, enabled: boolean, reason?: "gone" | "failing" | "manual"): Promise<EndpointRecord | null>;
  /** Moves the current secret to `previous` (expiring at `previousExpiresAt`) and installs the new one. */
  rotateSecret(id: string, newSecretEncrypted: string, previousExpiresAt: Date): Promise<EndpointRecord | null>;
  /** Enabled endpoints subscribed to `type`. One indexed read, no writes. */
  subscribedEndpointIds(type: WebhookEventType): Promise<string[]>;
  projectTimeZone(): Promise<string>;
  insertEvent(input: { type: WebhookEventType; subjectId: string; body: unknown; id?: string }): Promise<EventRecord>;
  insertDeliveries(
    eventId: string,
    endpointIds: readonly string[],
    opts?: { resendOf?: string },
  ): Promise<DeliveryRecord[]>;
  getDelivery(id: string): Promise<DeliveryRecord | null>;
  listDeliveries(endpointId: string, opts: { limit: number; before?: Date }): Promise<DeliveryRecord[]>;
  lastDelivery(endpointId: string): Promise<DeliveryRecord | null>;
  getEvent(id: string): Promise<EventRecord | null>;
  insertAttempt(input: NewAttempt): Promise<void>;
  listAttempts(deliveryIds: readonly string[]): Promise<AttemptRecord[]>;
  /** Marks the endpoint's `pending` deliveries failed with `endpoint_disabled`. */
  failPendingForEndpoint(endpointId: string): Promise<number>;
}

export function createWebhooksRepo(db: Database, projectId: string): WebhooksRepo {
  const ep = webhookEndpoints;
  const mine = eq(ep.projectId, projectId);
  return {
    projectId,
    async countEndpoints() {
      const rows = await db.select({ n: count() }).from(ep).where(mine);
      return Number(rows[0]?.n ?? 0);
    },
    async insertEndpoint(input) {
      const [row] = await db.insert(ep).values({ ...input, projectId }).returning();
      return row!;
    },
    async listEndpoints() {
      return db.select().from(ep).where(mine).orderBy(asc(ep.createdAt));
    },
    async getEndpoint(id) {
      const rows = await db.select().from(ep).where(and(mine, eq(ep.id, id))).limit(1);
      return rows[0] ?? null;
    },
    async updateEndpoint(id, patch) {
      const rows = await db
        .update(ep)
        .set({ ...patch, updatedAt: await now() })
        .where(and(mine, eq(ep.id, id)))
        .returning();
      return rows[0] ?? null;
    },
    async deleteEndpoint(id) {
      const rows = await db.delete(ep).where(and(mine, eq(ep.id, id))).returning({ id: ep.id });
      return rows.length === 1;
    },
    async setEnabled(id, enabled, reason) {
      const rows = await db
        .update(ep)
        .set(
          enabled
            ? { enabled: true, disabledReason: null, consecutiveFailures: 0, updatedAt: await now() }
            : { enabled: false, disabledReason: reason ?? "manual", updatedAt: await now() },
        )
        .where(and(mine, eq(ep.id, id)))
        .returning();
      return rows[0] ?? null;
    },
    async rotateSecret(id, newSecretEncrypted, previousExpiresAt) {
      const rows = await db
        .update(ep)
        .set({
          previousSecretEncrypted: ep.secretEncrypted,
          previousSecretExpiresAt: previousExpiresAt,
          secretEncrypted: newSecretEncrypted,
          updatedAt: await now(),
        })
        .where(and(mine, eq(ep.id, id)))
        .returning();
      return rows[0] ?? null;
    },
    async subscribedEndpointIds(type) {
      const rows = await db
        .select({ id: ep.id })
        .from(ep)
        .where(and(mine, eq(ep.enabled, true), sql`${type}::webhook_event_type = ANY(${ep.events})`));
      return rows.map((r) => r.id);
    },
    async projectTimeZone() {
      const rows = await db.select({ tz: projects.timezone }).from(projects).where(eq(projects.id, projectId)).limit(1);
      return rows[0]?.tz ?? "UTC";
    },
    async insertEvent(input) {
      const [row] = await db
        .insert(webhookEvents)
        .values({ ...input, projectId, createdAt: await now() })
        .returning();
      return row!;
    },
    async insertDeliveries(eventId, endpointIds, opts) {
      if (endpointIds.length === 0) return [];
      const at = await now();
      return db
        .insert(webhookDeliveries)
        .values(
          endpointIds.map((endpointId) => ({
            projectId,
            eventId,
            endpointId,
            nextAttemptAt: at,
            createdAt: at,
            ...(opts?.resendOf ? { resendOf: opts.resendOf } : {}),
          })),
        )
        .returning();
    },
    async getDelivery(id) {
      const rows = await db
        .select()
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.projectId, projectId), eq(webhookDeliveries.id, id)))
        .limit(1);
      return rows[0] ?? null;
    },
    async listDeliveries(endpointId, { limit, before }) {
      const d = webhookDeliveries;
      return db
        .select()
        .from(d)
        .where(and(eq(d.projectId, projectId), eq(d.endpointId, endpointId), before ? lt(d.createdAt, before) : undefined))
        .orderBy(desc(d.createdAt), desc(d.id))
        .limit(limit);
    },
    async lastDelivery(endpointId) {
      const d = webhookDeliveries;
      const rows = await db
        .select()
        .from(d)
        .where(and(eq(d.projectId, projectId), eq(d.endpointId, endpointId)))
        .orderBy(desc(d.createdAt), desc(d.id))
        .limit(1);
      return rows[0] ?? null;
    },
    async getEvent(id) {
      const rows = await db
        .select()
        .from(webhookEvents)
        .where(and(eq(webhookEvents.projectId, projectId), eq(webhookEvents.id, id)))
        .limit(1);
      return rows[0] ?? null;
    },
    async insertAttempt(input) {
      await db.insert(webhookDeliveryAttempts).values({ ...input, projectId, at: await now() });
    },
    async listAttempts(deliveryIds) {
      if (deliveryIds.length === 0) return [];
      const a = webhookDeliveryAttempts;
      return db
        .select()
        .from(a)
        .where(and(eq(a.projectId, projectId), inArray(a.deliveryId, [...deliveryIds])))
        .orderBy(asc(a.deliveryId), asc(a.attempt));
    },
    async failPendingForEndpoint(endpointId) {
      const d = webhookDeliveries;
      const at = await now();
      const rows = await db
        .update(d)
        .set({ status: "failed", lastErrorKind: "endpoint_disabled", finishedAt: at })
        .where(and(eq(d.projectId, projectId), eq(d.endpointId, endpointId), eq(d.status, "pending")))
        .returning({ id: d.id });
      return rows.length;
    },
  };
}

// ---- Cross-project operations for the scheduler's webhook section (contracts/webhooks.md) ----

export interface ClaimedDelivery {
  delivery: DeliveryRecord;
  token: string;
}

/** Deliveries stuck in `delivering` past their lease go back to `pending`, the attempt counted as `internal`. */
export async function recoverDeliveries(db: Database, limit = 50): Promise<number> {
  return runCrossProject("scheduler: recover webhook deliveries", async () => {
    const at = await now();
    return db.transaction(async (tx) => {
      const d = webhookDeliveries;
      const stale = await tx
        .select()
        .from(d)
        .where(and(eq(d.status, "delivering"), lte(d.leaseUntil, at)))
        .orderBy(asc(d.leaseUntil))
        .limit(limit)
        .for("update", { skipLocked: true });
      for (const row of stale) {
        const attempt = Math.min(row.attemptCount + 1, 8);
        await tx.insert(webhookDeliveryAttempts).values({
          projectId: row.projectId,
          deliveryId: row.id,
          attempt,
          at,
          errorKind: "internal",
          durationMs: 0,
          responseExcerpt: "Delivery was interrupted",
        });
        const exhausted = attempt >= 8;
        await tx
          .update(d)
          .set({
            status: exhausted ? "failed" : "pending",
            attemptCount: attempt,
            leaseOwner: null,
            leaseUntil: null,
            lastErrorKind: "internal",
            finishedAt: exhausted ? at : null,
            nextAttemptAt: at,
          })
          .where(eq(d.id, row.id));
      }
      return stale.length;
    });
  });
}

/** Claims due deliveries (`SKIP LOCKED`). Deliveries whose endpoint is disabled are failed in the same pass. */
export async function claimDeliveries(
  db: Database,
  opts: { limit: number; leaseSeconds: number },
): Promise<ClaimedDelivery[]> {
  return runCrossProject("scheduler: claim webhook deliveries", async () => {
    const at = await now();
    const token = randomUUID();
    const leaseUntil = new Date(at.getTime() + opts.leaseSeconds * 1000);
    return db.transaction(async (tx) => {
      const d = webhookDeliveries;
      const due = await tx
        .select({ delivery: d, enabled: webhookEndpoints.enabled })
        .from(d)
        .innerJoin(
          webhookEndpoints,
          and(eq(webhookEndpoints.projectId, d.projectId), eq(webhookEndpoints.id, d.endpointId)),
        )
        .where(and(eq(d.status, "pending"), lte(d.nextAttemptAt, at)))
        .orderBy(asc(d.nextAttemptAt), asc(d.createdAt))
        .limit(opts.limit)
        .for("update", { of: d, skipLocked: true });
      const claimed: ClaimedDelivery[] = [];
      for (const { delivery, enabled } of due) {
        if (!enabled) {
          await tx
            .update(d)
            .set({ status: "failed", lastErrorKind: "endpoint_disabled", finishedAt: at })
            .where(eq(d.id, delivery.id));
          continue;
        }
        const [row] = await tx
          .update(d)
          .set({ status: "delivering", leaseOwner: token, leaseUntil })
          .where(eq(d.id, delivery.id))
          .returning();
        claimed.push({ delivery: row!, token });
      }
      return claimed;
    });
  });
}

/** Releases a claimed delivery without counting an attempt (not enough time left in the tick). */
export async function releaseDelivery(db: Database, deliveryId: string, token: string): Promise<void> {
  await runCrossProject("scheduler: release webhook delivery", async () => {
    await db
      .update(webhookDeliveries)
      .set({ status: "pending", leaseOwner: null, leaseUntil: null })
      .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.leaseOwner, token)));
  });
}

export interface AttemptOutcome {
  statusCode: number | null;
  errorKind: AttemptErrorKind | null;
  durationMs: number;
  responseExcerpt: string | null;
  /** 2xx. */
  ok: boolean;
  /** 410 Gone. */
  gone: boolean;
}

export interface RecordConfig {
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  disableAfterFailures: number;
}

/** Records one attempt and moves the delivery on, in one transaction guarded by the lease token. */
export async function recordAttempt(
  db: Database,
  claimed: ClaimedDelivery,
  outcome: AttemptOutcome,
  cfg: RecordConfig,
): Promise<"stale" | "succeeded" | "retry" | "failed"> {
  return runCrossProject("scheduler: record webhook attempt", async () => {
    const at = await now();
    return db.transaction(async (tx) => {
      const d = webhookDeliveries;
      const { delivery, token } = claimed;
      const attempt = delivery.attemptCount + 1;
      const locked = await tx
        .select({ id: d.id })
        .from(d)
        .where(and(eq(d.id, delivery.id), eq(d.leaseOwner, token), eq(d.status, "delivering")))
        .for("update");
      if (locked.length === 0) return "stale";

      await tx.insert(webhookDeliveryAttempts).values({
        projectId: delivery.projectId,
        deliveryId: delivery.id,
        attempt,
        at,
        statusCode: outcome.statusCode,
        errorKind: outcome.ok ? null : (outcome.errorKind ?? "http_status"),
        durationMs: outcome.durationMs,
        responseExcerpt: outcome.responseExcerpt,
      });
      const base = { attemptCount: attempt, leaseOwner: null, leaseUntil: null, lastStatusCode: outcome.statusCode };
      const ep = webhookEndpoints;
      const endpointWhere = and(eq(ep.projectId, delivery.projectId), eq(ep.id, delivery.endpointId));

      if (outcome.ok) {
        await tx.update(d).set({ ...base, status: "succeeded", lastErrorKind: null, finishedAt: at }).where(eq(d.id, delivery.id));
        await tx.update(ep).set({ consecutiveFailures: 0 }).where(endpointWhere);
        return "succeeded";
      }
      const kind = outcome.errorKind ?? "http_status";
      if (outcome.gone) {
        await tx.update(d).set({ ...base, status: "failed", lastErrorKind: kind, finishedAt: at }).where(eq(d.id, delivery.id));
        await tx.update(ep).set({ enabled: false, disabledReason: "gone" }).where(endpointWhere);
        await tx
          .update(d)
          .set({ status: "failed", lastErrorKind: "endpoint_disabled", finishedAt: at })
          .where(and(eq(d.projectId, delivery.projectId), eq(d.endpointId, delivery.endpointId), eq(d.status, "pending")));
        return "failed";
      }
      if (attempt < cfg.maxAttempts) {
        const delay = Math.min(cfg.backoffBaseMs * 2 ** (attempt - 1), cfg.backoffMaxMs);
        await tx
          .update(d)
          .set({ ...base, status: "pending", lastErrorKind: kind, nextAttemptAt: new Date(at.getTime() + delay) })
          .where(eq(d.id, delivery.id));
        return "retry";
      }
      await tx.update(d).set({ ...base, status: "failed", lastErrorKind: kind, finishedAt: at }).where(eq(d.id, delivery.id));
      const bumped = await tx
        .update(ep)
        .set({ consecutiveFailures: sql`${ep.consecutiveFailures} + 1` })
        .where(endpointWhere)
        .returning({ n: ep.consecutiveFailures });
      if ((bumped[0]?.n ?? 0) >= cfg.disableAfterFailures) {
        await tx.update(ep).set({ enabled: false, disabledReason: "failing" }).where(and(endpointWhere, eq(ep.enabled, true)));
        await tx
          .update(d)
          .set({ status: "failed", lastErrorKind: "endpoint_disabled", finishedAt: at })
          .where(and(eq(d.projectId, delivery.projectId), eq(d.endpointId, delivery.endpointId), eq(d.status, "pending")));
      }
      return "failed";
    });
  });
}

/** Reads an endpoint across projects for the sender (the claim already pinned it to a delivery). */
export async function readEndpointForDelivery(db: Database, projectId: string, endpointId: string) {
  return runCrossProject("scheduler: read webhook endpoint", async () => {
    const rows = await db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.projectId, projectId), eq(webhookEndpoints.id, endpointId)))
      .limit(1);
    return rows[0] ?? null;
  });
}

export async function readEventForDelivery(db: Database, projectId: string, eventId: string) {
  return runCrossProject("scheduler: read webhook event", async () => {
    const rows = await db
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.projectId, projectId), eq(webhookEvents.id, eventId)))
      .limit(1);
    return rows[0] ?? null;
  });
}

/** Retention cleanup, bounded per statement. Returns the number of rows removed. */
export async function purgeWebhookHistory(db: Database, retentionDays: number, limit = 500): Promise<number> {
  return runCrossProject("scheduler: webhook housekeeping", async () => {
    const at = await now();
    const cutoff = new Date(at.getTime() - retentionDays * 86_400_000);
    let removed = 0;
    const a = webhookDeliveryAttempts;
    const oldAttempts = await db.select({ id: a.id }).from(a).where(lt(a.at, cutoff)).limit(limit);
    if (oldAttempts.length > 0) {
      const r = await db.delete(a).where(inArray(a.id, oldAttempts.map((x) => x.id))).returning({ id: a.id });
      removed += r.length;
    }
    const d = webhookDeliveries;
    const oldDeliveries = await db
      .select({ id: d.id })
      .from(d)
      .where(and(inArray(d.status, ["succeeded", "failed"]), lt(d.finishedAt, cutoff)))
      .limit(limit);
    if (oldDeliveries.length > 0) {
      const r = await db.delete(d).where(inArray(d.id, oldDeliveries.map((x) => x.id))).returning({ id: d.id });
      removed += r.length;
    }
    const e = webhookEvents;
    const oldEvents = await db
      .select({ id: e.id })
      .from(e)
      .where(
        and(
          lt(e.createdAt, cutoff),
          sql`NOT EXISTS (SELECT 1 FROM webhook_deliveries wd WHERE wd.event_id = ${e.id})`,
        ),
      )
      .limit(limit);
    if (oldEvents.length > 0) {
      const r = await db.delete(e).where(inArray(e.id, oldEvents.map((x) => x.id))).returning({ id: e.id });
      removed += r.length;
    }
    return removed;
  });
}
