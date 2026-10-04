"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { LocalTime } from "@/components/ui/LocalTime";
import { Cell, Row, Table } from "@/components/ui/Table";
import { resendDeliveryAction } from "../actions";
import { EVENT_LABELS } from "../dto";

export interface DeliveryDto {
  id: string;
  eventId: string;
  eventType: string;
  status: "pending" | "delivering" | "succeeded" | "failed";
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
  nextAttemptAt: string | null;
  result: string;
  attempts: { attempt: number; at: string; result: string; durationMs: number; excerpt: string | null }[];
}

const STATUS_LABEL = { pending: "Pending", delivering: "Sending", succeeded: "Succeeded", failed: "Failed" } as const;
const STATUS_TONE = { pending: "neutral", delivering: "info", succeeded: "success", failed: "danger" } as const;

export function DeliveryLog({
  slug,
  timeZone,
  enabled,
  deliveries,
  onChanged,
}: {
  slug: string;
  timeZone: string;
  enabled: boolean;
  deliveries: DeliveryDto[];
  onChanged: () => void;
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState("");

  function resend(id: string) {
    start(async () => {
      const result = await resendDeliveryAction(slug, id);
      setMessage(result.ok ? "Resend queued. It is sent on the next scheduler tick." : result.message);
      if (result.ok) onChanged();
    });
  }

  if (deliveries.length === 0) {
    return <EmptyState message="No deliveries yet. Send a test event to check the receiver." />;
  }
  return (
    <div className="flex flex-col gap-2">
      <LiveRegion message={message} />
      <Table
        caption="Deliveries, newest first"
        columns={["Event", "Created", "Status", "Attempts", "Next attempt", "Last result", "Resend"]}
      >
        {deliveries.map((d) => (
          <Row key={d.id}>
            <Cell header>
              {EVENT_LABELS[d.eventType] ?? d.eventType} <code className="font-mono text-xs">{d.eventId.slice(0, 8)}</code>
              {d.attempts.length > 0 ? (
                <details className="mt-1 text-xs font-normal">
                  <summary className="cursor-pointer">Attempts</summary>
                  <ol className="mt-1 flex flex-col gap-1">
                    {d.attempts.map((a) => (
                      <li key={a.attempt}>
                        #{a.attempt} <LocalTime value={a.at} timeZone={timeZone} /> — {a.result} ({a.durationMs} ms)
                        {a.excerpt ? <pre className="mt-0.5 whitespace-pre-wrap font-mono">{a.excerpt}</pre> : null}
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
            </Cell>
            <Cell>
              <LocalTime value={d.createdAt} timeZone={timeZone} />
            </Cell>
            <Cell>
              <Badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Badge>
            </Cell>
            <Cell>
              {d.attemptCount} of {d.maxAttempts}
            </Cell>
            <Cell>{d.nextAttemptAt ? <LocalTime value={d.nextAttemptAt} timeZone={timeZone} /> : "—"}</Cell>
            <Cell>{d.result}</Cell>
            <Cell>
              {enabled && d.status !== "pending" && d.status !== "delivering" ? (
                <Button variant="secondary" pending={pending} onClick={() => resend(d.id)} aria-label={`Resend delivery ${d.eventId.slice(0, 8)}`}>
                  Resend
                </Button>
              ) : null}
            </Cell>
          </Row>
        ))}
      </Table>
    </div>
  );
}
