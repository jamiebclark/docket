"use client";

import { useActionState, useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CopyField } from "@/components/ui/CopyField";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Cell, Row, Table } from "@/components/ui/Table";
import type { ActionResult } from "@/lib/action-result";
import { inviteMember, regenerateInvitation, revokeInvitation, type DeliveryDto } from "./actions";

export interface InvitationView {
  id: string;
  email: string;
  role: string;
  status: "pending" | "expired" | "accepted" | "declined" | "revoked";
  inviterName: string;
  expiresAt: string;
  /** Revoke / regenerate are allowed for this row. */
  canManage: boolean;
}

type Link = { url: string; expiresAt: string; email: string };

const tone = { pending: "neutral", expired: "warning", accepted: "success", declined: "neutral", revoked: "danger" } as const;
const label = { pending: "Pending", expired: "Expired", accepted: "Accepted", declined: "Declined", revoked: "Revoked" } as const;
const when = (iso: string) => new Date(iso).toUTCString();

export function InvitationsPanel({
  slug,
  invitations,
  canInvite,
  canInviteOwner,
}: {
  slug: string;
  invitations: InvitationView[];
  canInvite: boolean;
  canInviteOwner: boolean;
}) {
  const [link, setLink] = useState<Link | null>(null);

  return (
    <section aria-labelledby="invitations-heading" className="flex flex-col gap-4">
      <h2 id="invitations-heading" className="text-lg font-semibold">
        Invitations
      </h2>
      {canInvite ? <InviteForm slug={slug} canInviteOwner={canInviteOwner} onLink={setLink} /> : null}
      {link ? (
        <div role="region" aria-label="Invitation link" className="flex flex-col gap-2 rounded-lg border border-foreground/30 p-4">
          <p className="text-sm">
            Send this link to {link.email}. It is shown only once and expires on {when(link.expiresAt)}.
          </p>
          <CopyField id="invitation-link" label="Invitation link" value={link.url} />
          <Button variant="secondary" className="self-start" onClick={() => setLink(null)}>
            Done, hide link
          </Button>
        </div>
      ) : null}
      {invitations.length === 0 ? (
        <EmptyState message="No invitations yet." />
      ) : (
        <Table caption="Invitations" columns={["Email", "Role", "Status", "Invited by", "Expires", "Actions"]}>
          {invitations.map((inv) => (
            <InvitationRow key={inv.id} slug={slug} inv={inv} onLink={setLink} />
          ))}
        </Table>
      )}
    </section>
  );
}

function InviteForm({
  slug,
  canInviteOwner,
  onLink,
}: {
  slug: string;
  canInviteOwner: boolean;
  onLink: (l: Link | null) => void;
}) {
  const [state, action, pending] = useActionState<ActionResult<DeliveryDto> | null, FormData>(inviteMember, null);
  const [email, setEmail] = useState("");
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const formError = state && !state.ok && Object.keys(errors).length === 0 ? state.message : null;

  useEffect(() => {
    if (state?.ok && state.data.link) onLink({ ...state.data.link, email });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to each new result only
  }, [state]);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="slug" value={slug} />
      <div className="flex flex-wrap items-start gap-3">
        <Field id="invite-email" name="email" label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        <Select id="invite-role" name="role" label="Role" defaultValue="editor" error={errors.role}>
          <option value="editor">Editor</option>
          <option value="admin">Admin</option>
          {canInviteOwner ? <option value="owner">Owner</option> : null}
        </Select>
        <Button type="submit" pending={pending} pendingLabel="Inviting…" className="mt-6">
          Invite
        </Button>
      </div>
      {formError ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {formError}
        </p>
      ) : null}
      {state?.ok && !state.data.link ? (
        <p role="status" className="text-sm">
          Invitation sent. They will see it under Invitations when they sign in.
        </p>
      ) : null}
    </form>
  );
}

function InvitationRow({ slug, inv, onLink }: { slug: string; inv: InvitationView; onLink: (l: Link | null) => void }) {
  const [regen, regenAction, regenerating] = useActionState<ActionResult<DeliveryDto> | null, FormData>(regenerateInvitation, null);
  const [revoked, revokeAction, revoking] = useActionState<ActionResult<DeliveryDto> | null, FormData>(revokeInvitation, null);
  const [confirming, setConfirming] = useState(false);
  const open = inv.status === "pending" || inv.status === "expired";
  const error = [regen, revoked].find((s) => s && !s.ok);

  useEffect(() => {
    if (regen?.ok && regen.data.link) onLink({ ...regen.data.link, email: inv.email });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to each new result only
  }, [regen]);

  return (
    <Row>
      <Cell header>{inv.email}</Cell>
      <Cell>{inv.role}</Cell>
      <Cell>
        <Badge tone={tone[inv.status]}>{label[inv.status]}</Badge>
      </Cell>
      <Cell>{inv.inviterName}</Cell>
      <Cell>
        <time dateTime={inv.expiresAt}>{when(inv.expiresAt)}</time>
      </Cell>
      <Cell>
        {open && inv.canManage ? (
          <div className="flex flex-wrap gap-2">
            <form action={regenAction}>
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="invitationId" value={inv.id} />
              <Button type="submit" variant="secondary" pending={regenerating} pendingLabel="Regenerating…" aria-label={`Regenerate invitation for ${inv.email}`}>
                Regenerate
              </Button>
            </form>
            <Button variant="danger" onClick={() => setConfirming(true)} aria-label={`Revoke invitation for ${inv.email}`}>
              Revoke
            </Button>
            <Dialog open={confirming} onClose={() => setConfirming(false)} title={`Revoke invitation for ${inv.email}?`}>
              <p className="mb-4 text-sm">Their link will stop working. You can invite them again later.</p>
              <form action={revokeAction} className="flex gap-2">
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="invitationId" value={inv.id} />
                <Button type="submit" variant="danger" pending={revoking} pendingLabel="Revoking…">
                  Revoke invitation
                </Button>
                <Button variant="secondary" onClick={() => setConfirming(false)}>
                  Keep invitation
                </Button>
              </form>
            </Dialog>
          </div>
        ) : null}
        {error && !error.ok ? (
          <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400">
            {error.message}
          </p>
        ) : null}
      </Cell>
    </Row>
  );
}
