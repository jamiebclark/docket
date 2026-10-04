"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { LocalTime } from "@/components/ui/LocalTime";
import { Cell, Row, Table } from "@/components/ui/Table";
import type { ApiKeyDto } from "./dto";
import { CreateKeyForm } from "./CreateKeyForm";
import { RevokeKeyDialog } from "./RevokeKeyDialog";

export function ApiKeysPanel({ slug, timeZone, keys }: { slug: string; timeZone: string; keys: ApiKeyDto[] }) {
  const router = useRouter();
  const [announcement, setAnnouncement] = useState("");

  return (
    <div className="flex flex-col gap-6">
      <LiveRegion message={announcement} />
      {keys.length === 0 ? (
        <EmptyState message="No API keys yet. Create one to connect n8n or another tool." />
      ) : (
        <Table
          caption="API keys"
          columns={["Name", "Key", "Permissions", "Rate limit", "Created by", "Created", "Last used", "Expires", "Status", "Actions"]}
        >
          {keys.map((k) => (
            <Row key={k.id}>
              <Cell header>{k.name}</Cell>
              <Cell>
                <code className="font-mono text-xs">{k.display}</code>
              </Cell>
              <Cell>{k.permissions.join(", ")}</Cell>
              <Cell>{k.rateLimitPerMinute}/min</Cell>
              <Cell>
                {k.createdBy.name}
                {k.createdBy.isMember ? "" : " (no longer a member)"}
              </Cell>
              <Cell>
                <LocalTime value={k.createdAt} timeZone={timeZone} />
              </Cell>
              <Cell>{k.lastUsedAt ? <LocalTime value={k.lastUsedAt} timeZone={timeZone} /> : "Never"}</Cell>
              <Cell>{k.expiresAt ? <LocalTime value={k.expiresAt} timeZone={timeZone} /> : "Never"}</Cell>
              <Cell>
                {k.status === "active" ? <Badge tone="success">Active</Badge> : null}
                {k.status === "expired" ? <Badge>Expired</Badge> : null}
                {k.status === "revoked" ? (
                  <Badge>
                    Revoked{k.revokedAt ? ` ${new Date(k.revokedAt).toISOString().slice(0, 10)}` : ""}
                    {k.revokedBy ? ` by ${k.revokedBy}` : ""}
                  </Badge>
                ) : null}
              </Cell>
              <Cell>
                {k.status === "revoked" ? null : (
                  <RevokeKeyDialog
                    slug={slug}
                    id={k.id}
                    name={k.name}
                    onDone={(message) => {
                      setAnnouncement(message);
                      router.refresh();
                    }}
                  />
                )}
              </Cell>
            </Row>
          ))}
        </Table>
      )}
      <section aria-labelledby="create-key-heading" className="flex flex-col gap-3">
        <h2 id="create-key-heading" className="text-lg font-semibold">
          Create a key
        </h2>
        <CreateKeyForm slug={slug} onCreated={() => router.refresh()} />
      </section>
    </div>
  );
}
