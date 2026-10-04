import { randomBytes } from "node:crypto";
import { z } from "zod";
import { WEBHOOK_ENDPOINT_CAP, webhookEndpointSchema } from "@/lib/validation/api";
import * as clock from "../../dal/clock";
import { ConflictError, ForbiddenError, NotFoundError } from "../../dal/errors";
import type { ProjectScope } from "../../dal/scope";
import type { EndpointRecord } from "../../dal/webhooks";
import { decryptSecret, encryptSecret } from "../../crypto/secrets";
import { recordAudit } from "../audit";
import { checkWebhookDestination } from "./destination";

export const SECRET_PREFIX = "whsec_";
export const ROTATION_OVERLAP_MS = 24 * 3_600_000;

export interface EndpointView {
  id: string;
  url: string;
  description: string;
  events: EndpointRecord["events"];
  enabled: boolean;
  disabledReason: string | null;
  createdAt: Date;
  /** An overlap from a rotation is active: deliveries carry two signatures. */
  secretRotating: boolean;
  /** When the old secret stops signing; `null` outside an overlap. */
  oldSecretUntil: Date | null;
  lastDelivery: { status: string; at: Date; statusCode: number | null } | null;
}

const aad = (id: string) => `webhook_endpoint:${id}`;
const uuid = z.uuid();

function need(scope: ProjectScope): void {
  if (!scope.can({ webhook: ["manage"] })) throw new ForbiddenError();
}

const newSecret = () => `${SECRET_PREFIX}${randomBytes(24).toString("base64url")}`;
const hostOf = (url: string) => new URL(url).host;

function toView(e: EndpointRecord, at: Date, last: EndpointView["lastDelivery"]): EndpointView {
  return {
    id: e.id,
    url: e.url,
    description: e.description,
    events: e.events,
    enabled: e.enabled,
    disabledReason: e.disabledReason,
    createdAt: e.createdAt,
    secretRotating: e.previousSecretExpiresAt !== null && e.previousSecretExpiresAt > at,
    oldSecretUntil: e.previousSecretExpiresAt !== null && e.previousSecretExpiresAt > at ? e.previousSecretExpiresAt : null,
    lastDelivery: last,
  };
}

async function viewOf(scope: ProjectScope, e: EndpointRecord, at: Date): Promise<EndpointView> {
  const d = await scope.webhooks.lastDelivery(e.id);
  return toView(e, at, d ? { status: d.status, at: d.finishedAt ?? d.createdAt, statusCode: d.lastStatusCode } : null);
}

export async function listEndpoints(scope: ProjectScope): Promise<EndpointView[]> {
  need(scope);
  const at = await clock.now();
  const rows = await scope.webhooks.listEndpoints();
  return Promise.all(rows.map((e) => viewOf(scope, e, at)));
}

export async function getEndpoint(scope: ProjectScope, id: string): Promise<EndpointView> {
  need(scope);
  if (!uuid.safeParse(id).success) throw new NotFoundError();
  const e = await scope.webhooks.getEndpoint(id);
  if (!e) throw new NotFoundError();
  return viewOf(scope, e, await clock.now());
}

/** The plaintext secret is returned here and nowhere else (FR-035). */
export async function createEndpoint(
  scope: ProjectScope,
  input: unknown,
): Promise<{ endpoint: EndpointView; secret: string; httpWarning: boolean; destinationWarning: string | null }> {
  const parsed = webhookEndpointSchema.parse(input);
  need(scope);
  const { warning } = await checkWebhookDestination(parsed.url);
  const id = crypto.randomUUID();
  const secret = newSecret();
  const row = await scope.transaction(
    async (tx) => {
      need(tx);
      if ((await tx.webhooks.countEndpoints()) >= WEBHOOK_ENDPOINT_CAP) {
        throw new ConflictError(`A project can have at most ${WEBHOOK_ENDPOINT_CAP} webhook endpoints. Delete one first.`);
      }
      const created = await tx.webhooks.insertEndpoint({
        id,
        url: parsed.url,
        description: parsed.description,
        events: parsed.events,
        secretEncrypted: encryptSecret(secret, { aad: aad(id) }),
        createdByUserId: tx.membership.userId || null,
      });
      await recordAudit(tx, {
        action: "webhook_create",
        actorUserId: tx.membership.userId || null,
        details: { endpointId: created.id, description: created.description, events: created.events, host: hostOf(created.url) },
      });
      return created;
    },
    { lockProject: true },
  );
  return { endpoint: toView(row, await clock.now(), null), secret, httpWarning: new URL(row.url).protocol === "http:", destinationWarning: warning };
}

export async function updateEndpoint(scope: ProjectScope, id: string, input: unknown): Promise<EndpointView> {
  const parsed = webhookEndpointSchema.parse(input);
  need(scope);
  if (!uuid.safeParse(id).success) throw new NotFoundError();
  await checkWebhookDestination(parsed.url);
  return scope.transaction(async (tx) => {
    need(tx);
    const row = await tx.webhooks.updateEndpoint(id, parsed);
    if (!row) throw new NotFoundError();
    await recordAudit(tx, {
      action: "webhook_update",
      actorUserId: tx.membership.userId || null,
      details: { endpointId: row.id, description: row.description, events: row.events, host: hostOf(row.url) },
    });
    return viewOf(tx, row, await clock.now());
  });
}

export async function setEndpointEnabled(scope: ProjectScope, id: string, enabled: boolean): Promise<EndpointView> {
  need(scope);
  if (!uuid.safeParse(id).success) throw new NotFoundError();
  return scope.transaction(async (tx) => {
    need(tx);
    const row = await tx.webhooks.setEnabled(id, enabled, "manual");
    if (!row) throw new NotFoundError();
    if (!enabled) await tx.webhooks.failPendingForEndpoint(id);
    await recordAudit(tx, {
      action: enabled ? "webhook_enable" : "webhook_disable",
      actorUserId: tx.membership.userId || null,
      details: { endpointId: row.id, host: hostOf(row.url) },
    });
    return viewOf(tx, row, await clock.now());
  });
}

export async function deleteEndpoint(scope: ProjectScope, id: string): Promise<void> {
  need(scope);
  if (!uuid.safeParse(id).success) throw new NotFoundError();
  await scope.transaction(async (tx) => {
    need(tx);
    const row = await tx.webhooks.getEndpoint(id);
    if (!row) throw new NotFoundError();
    await tx.webhooks.deleteEndpoint(id);
    await recordAudit(tx, {
      action: "webhook_delete",
      actorUserId: tx.membership.userId || null,
      details: { endpointId: row.id, description: row.description, host: hostOf(row.url) },
    });
  });
}

/**
 * Installs a new secret; the old one keeps signing for 24 h. Rotating again drops the earlier
 * previous secret (only the one just replaced overlaps).
 */
export async function rotateSecret(scope: ProjectScope, id: string): Promise<{ secret: string }> {
  need(scope);
  if (!uuid.safeParse(id).success) throw new NotFoundError();
  const secret = newSecret();
  const expires = new Date((await clock.now()).getTime() + ROTATION_OVERLAP_MS);
  await scope.transaction(async (tx) => {
    need(tx);
    const row = await tx.webhooks.rotateSecret(id, encryptSecret(secret, { aad: aad(id) }), expires);
    if (!row) throw new NotFoundError();
    await recordAudit(tx, {
      action: "webhook_rotate_secret",
      actorUserId: tx.membership.userId || null,
      details: { endpointId: row.id, host: hostOf(row.url) },
    });
  });
  return { secret };
}

/** Secrets that currently sign for the endpoint: the current one, then the previous while its overlap lasts. */
export function activeSecrets(e: EndpointRecord, at: Date): string[] {
  const out = [decryptSecret(e.secretEncrypted, { aad: aad(e.id) })];
  if (e.previousSecretEncrypted && e.previousSecretExpiresAt && e.previousSecretExpiresAt > at) {
    out.push(decryptSecret(e.previousSecretEncrypted, { aad: aad(e.id) }));
  }
  return out;
}

export async function listDeliveries(scope: ProjectScope, endpointId: string, opts: { limit?: number; before?: Date } = {}) {
  need(scope);
  if (!uuid.safeParse(endpointId).success || !(await scope.webhooks.getEndpoint(endpointId))) throw new NotFoundError();
  const rows = await scope.webhooks.listDeliveries(endpointId, { limit: opts.limit ?? 25, before: opts.before });
  const events = new Map<string, string>();
  for (const r of rows) {
    if (!events.has(r.eventId)) events.set(r.eventId, (await scope.webhooks.getEvent(r.eventId))?.type ?? "");
  }
  const attempts = await scope.webhooks.listAttempts(rows.map((r) => r.id));
  return rows.map((r) => ({
    ...r,
    eventType: events.get(r.eventId) ?? "",
    attempts: attempts.filter((a) => a.deliveryId === r.id),
  }));
}

export async function resendDelivery(scope: ProjectScope, deliveryId: string): Promise<void> {
  need(scope);
  if (!uuid.safeParse(deliveryId).success) throw new NotFoundError();
  await scope.transaction(async (tx) => {
    need(tx);
    const d = await tx.webhooks.getDelivery(deliveryId);
    if (!d) throw new NotFoundError();
    const endpoint = await tx.webhooks.getEndpoint(d.endpointId);
    if (!endpoint) throw new NotFoundError();
    if (!endpoint.enabled) throw new ConflictError("This endpoint is disabled. Enable it before resending.");
    await tx.webhooks.insertDeliveries(d.eventId, [endpoint.id], { resendOf: d.id });
  });
}

export async function sendTestEvent(scope: ProjectScope, endpointId: string): Promise<void> {
  need(scope);
  if (!uuid.safeParse(endpointId).success) throw new NotFoundError();
  await scope.transaction(async (tx) => {
    need(tx);
    const endpoint = await tx.webhooks.getEndpoint(endpointId);
    if (!endpoint) throw new NotFoundError();
    const id = crypto.randomUUID();
    const event = await tx.webhooks.insertEvent({
      id,
      type: "ping",
      subjectId: endpoint.id,
      body: {
        id,
        type: "ping",
        createdAt: (await clock.now()).toISOString(),
        projectId: tx.webhooks.projectId,
        data: { endpointId: endpoint.id },
      },
    });
    await tx.webhooks.insertDeliveries(event.id, [endpoint.id]);
  });
}
