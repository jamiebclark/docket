"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { LocalTime } from "@/components/ui/LocalTime";
import { sendTestEventAction } from "../actions";
import { EVENT_LABELS, type EndpointDto } from "../dto";
import { EndpointForm } from "../EndpointForm";
import { EndpointRowActions } from "../EndpointRowActions";
import { StatusBadge } from "../WebhooksPanel";
import { DeliveryLog, type DeliveryDto } from "./DeliveryLog";
import { RotateSecretDialog } from "./RotateSecretDialog";

export function EndpointDetail({
  slug,
  timeZone,
  endpoint,
  deliveries,
}: {
  slug: string;
  timeZone: string;
  endpoint: EndpointDto;
  deliveries: DeliveryDto[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  const done = (m: string) => {
    setMessage(m);
    setEditing(false);
    router.refresh();
  };

  function test() {
    start(async () => {
      const result = await sendTestEventAction(slug, endpoint.id);
      done(result.ok ? "Test event queued. It is sent on the next scheduler tick." : result.message);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <LiveRegion message={message} />
      <dl className="grid max-w-2xl grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="font-medium">URL</dt>
        <dd className="break-all">{endpoint.url}</dd>
        <dt className="font-medium">Description</dt>
        <dd>{endpoint.description || "—"}</dd>
        <dt className="font-medium">Events</dt>
        <dd>{endpoint.events.map((t) => EVENT_LABELS[t] ?? t).join(", ")}</dd>
        <dt className="font-medium">Status</dt>
        <dd>
          <StatusBadge endpoint={endpoint} />
        </dd>
        {endpoint.oldSecretUntil ? (
          <>
            <dt className="font-medium">Secret</dt>
            <dd>
              Old secret still accepted until <LocalTime value={endpoint.oldSecretUntil} timeZone={timeZone} />
            </dd>
          </>
        ) : null}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
          {editing ? "Cancel edit" : "Edit"}
        </Button>
        <Button variant="secondary" pending={pending} pendingLabel="Queuing…" onClick={test}>
          Send test event
        </Button>
        <RotateSecretDialog slug={slug} id={endpoint.id} onDone={done} />
        <EndpointRowActions
          slug={slug}
          id={endpoint.id}
          host={endpoint.host}
          enabled={endpoint.enabled}
          onDone={done}
          onDeleted={() => router.push(`/p/${slug}/settings/webhooks`)}
        />
      </div>
      {editing ? <EndpointForm slug={slug} endpoint={endpoint} onDone={done} /> : null}
      <section aria-labelledby="deliveries-heading" className="flex flex-col gap-3">
        <h2 id="deliveries-heading" className="text-lg font-semibold">
          Deliveries
        </h2>
        <DeliveryLog slug={slug} timeZone={timeZone} enabled={endpoint.enabled} deliveries={deliveries} onChanged={() => router.refresh()} />
      </section>
    </div>
  );
}
