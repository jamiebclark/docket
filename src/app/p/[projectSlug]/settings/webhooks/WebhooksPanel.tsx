"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { LocalTime } from "@/components/ui/LocalTime";
import { Cell, Row, Table } from "@/components/ui/Table";
import { EVENT_LABELS, type EndpointDto } from "./dto";
import { EndpointForm } from "./EndpointForm";
import { EndpointRowActions } from "./EndpointRowActions";

export function StatusBadge({ endpoint }: { endpoint: EndpointDto }) {
  if (endpoint.enabled) return <Badge tone="success">Enabled</Badge>;
  if (endpoint.disabledReason === "gone") return <Badge>Disabled: receiver said it is gone (410)</Badge>;
  if (endpoint.disabledReason === "failing") return <Badge>Disabled: 20 deliveries failed in a row</Badge>;
  return <Badge>Disabled</Badge>;
}

export function WebhooksPanel({ slug, timeZone, endpoints }: { slug: string; timeZone: string; endpoints: EndpointDto[] }) {
  const router = useRouter();
  const [announcement, setAnnouncement] = useState("");
  const done = (message: string) => {
    setAnnouncement(message);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-6">
      <LiveRegion message={announcement} />
      {endpoints.length === 0 ? (
        <EmptyState message="No webhook endpoints yet. Add one to get notified instead of polling." />
      ) : (
        <Table caption="Webhook endpoints" columns={["Endpoint", "Description", "Events", "Status", "Last delivery", "Actions"]}>
          {endpoints.map((e) => (
            <Row key={e.id}>
              <Cell header>
                <Link href={`/p/${slug}/settings/webhooks/${e.id}`} className="underline">
                  {e.host + new URL(e.url).pathname}
                </Link>
              </Cell>
              <Cell>{e.description || "—"}</Cell>
              <Cell>{e.events.map((t) => EVENT_LABELS[t] ?? t).join(", ")}</Cell>
              <Cell>
                <StatusBadge endpoint={e} />
              </Cell>
              <Cell>
                {e.lastDelivery ? (
                  <>
                    {e.lastDelivery.status === "succeeded" ? "Succeeded " : e.lastDelivery.status === "failed" ? "Failed " : "Pending "}
                    <LocalTime value={e.lastDelivery.at} timeZone={timeZone} />
                    {e.lastDelivery.status === "failed" && e.lastDelivery.statusCode ? ` (${e.lastDelivery.statusCode})` : ""}
                  </>
                ) : (
                  "None yet"
                )}
              </Cell>
              <Cell>
                <EndpointRowActions slug={slug} id={e.id} host={e.host} enabled={e.enabled} onDone={done} />
              </Cell>
            </Row>
          ))}
        </Table>
      )}
      <section aria-labelledby="add-endpoint-heading" className="flex flex-col gap-3">
        <h2 id="add-endpoint-heading" className="text-lg font-semibold">
          Add an endpoint
        </h2>
        <EndpointForm slug={slug} onDone={done} />
      </section>
    </div>
  );
}
