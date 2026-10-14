"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { announcedText } from "@/components/ui/Announce";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CopyField } from "@/components/ui/CopyField";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { Cell, Row, Sub, Table } from "@/components/ui/Table";
import { formatLocal, LocalTime } from "@/components/ui/LocalTime";
import type { ActionResult } from "@/lib/action-result";
import { inviteMember, regenerateInvitation, revokeInvitation, type DeliveryDto } from "./actions";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { ROLE_OPTIONS, roleLabel } from "@/lib/roles/roles";

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

type Link = {
  url: string;
  expiresAt: string;
  /** The invitee's address, for the wording. */
  email: string;
  kind: DeliveryDto["kind"];
  deliveryEmail: DeliveryDto["email"];
};

const tone = { pending: "neutral", expired: "warning", accepted: "success", declined: "neutral", revoked: "danger" } as const;
const label = { pending: "Pending", expired: "Expired", accepted: "Accepted", declined: "Declined", revoked: "Revoked" } as const;

/**
 * One sentence per thing the inviter needs to know: whether the email went out, how the invitee is
 * expected to reach the invitation, and that this is the only time the link is shown. A link now comes
 * back for an invitee who already has an account too (decisions 057), so the in-app case is a wording
 * difference here rather than a panel that renders nothing.
 */
export function linkMessage(link: Link, timeZone: string): string {
  const mail =
    link.deliveryEmail === "sent"
      ? "Invitation emailed."
      : link.deliveryEmail === "failed"
        ? "The invitation was created, but the email did not go out."
        : null;
  const reach =
    link.kind === "in_app"
      ? `${link.email} already has a Docket account and will see this invitation under Invitations.`
      : `Send this link to ${link.email}.`;
  const expiry = `The link is shown only once and expires on ${formatLocal(link.expiresAt, timeZone)}.`;
  return [mail, reach, expiry].filter(Boolean).join(" ");
}

export function InvitationsPanel({
  slug,
  timeZone,
  invitations,
  canInvite,
  canInviteOwner,
}: {
  slug: string;
  timeZone: string;
  invitations: InvitationView[];
  canInvite: boolean;
  canInviteOwner: boolean;
}) {
  const [link, setLink] = useState<Link | null>(null);
  const [message, setMessage] = useState("");
  const announceCount = useRef(0);
  const linkPanel = useRef<HTMLDivElement | null>(null);
  // Set when a link is about to appear, so the effect below focuses it only then — not on an unrelated
  // re-render that happens while the panel is already open.
  const focusWanted = useRef(false);

  /** One live region for the whole panel; identical text is re-announced via `announcedText`. */
  function say(text: string) {
    setMessage(announcedText(text, ++announceCount.current));
  }

  function showLink(next: Link) {
    focusWanted.current = true;
    setLink(next);
  }

  useEffect(() => {
    if (!link || !focusWanted.current) return;
    focusWanted.current = false;
    // The panel renders above the table, so a Regenerate from a row far down a long members page used
    // to put the thing just asked for off-screen with nothing moved and nothing said. Focusing the
    // region scrolls it into view and makes it the next thing read and the next thing tabbed from.
    linkPanel.current?.focus();
  }, [link]);

  return (
    <section aria-labelledby="invitations-heading" className="flex flex-col gap-4">
      <h2 id="invitations-heading" className="text-lg font-semibold">
        Invitations
      </h2>
      {canInvite ? <InviteForm slug={slug} canInviteOwner={canInviteOwner} onLink={showLink} /> : null}
      {link ? (
        <div
          ref={linkPanel}
          tabIndex={-1}
          role="region"
          aria-label="Invitation link"
          className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-5 shadow-card focus:outline-none focus:ring-2 focus:ring-focus"
        >
          <p className="text-sm">{linkMessage(link, timeZone)}</p>
          <CopyField id="invitation-link" label="Invitation link" value={link.url} />
          <Button variant="secondary" className="self-start" onClick={() => setLink(null)}>
            Done, hide link
          </Button>
        </div>
      ) : null}
      {invitations.length === 0 ? (
        <EmptyState message="No invitations yet." />
      ) : (
        <Table caption="Invitations" columns={["Invitation", "Role", "Status", "Actions"]}>
          {invitations.map((inv) => (
            <InvitationRow key={inv.id} slug={slug} timeZone={timeZone} inv={inv} onLink={showLink} say={say} />
          ))}
        </Table>
      )}
      <LiveRegion message={message} />
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
  onLink: (l: Link) => void;
}) {
  const [state, action, pending] = useActionState<ActionResult<DeliveryDto> | null, FormData>(inviteMember, null);
  const [email, setEmail] = useState("");
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const formError = state && !state.ok && Object.keys(errors).length === 0 ? state.message : null;

  useEffect(() => {
    if (state?.ok) onLink({ ...state.data.link, email, kind: state.data.kind, deliveryEmail: state.data.email });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to each new result only
  }, [state]);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="slug" value={slug} />
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="min-w-64 flex-1">
          <Field id="invite-email" name="email" label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        </div>
        <SegmentedControl
          name="role"
          label="Role"
          layout="cards"
          defaultValue="editor"
          error={errors.role}
          options={ROLE_OPTIONS.filter((o) => canInviteOwner || o.value !== "owner").map(({ value, label, description }) => ({ value, label, description }))}
        />
        <Button type="submit" pending={pending} pendingLabel="Inviting…" className="mb-5">
          Invite
        </Button>
      </div>
      {formError ? (
        <p role="alert" className="text-sm text-danger">
          {formError}
        </p>
      ) : null}
    </form>
  );
}

function InvitationRow({
  slug,
  timeZone,
  inv,
  onLink,
  say,
}: {
  slug: string;
  timeZone: string;
  inv: InvitationView;
  onLink: (l: Link) => void;
  say: (text: string) => void;
}) {
  const [regen, regenAction, regenerating] = useActionState<ActionResult<DeliveryDto> | null, FormData>(regenerateInvitation, null);
  const [revoked, revokeAction, revoking] = useActionState<ActionResult<null> | null, FormData>(revokeInvitation, null);
  const [confirming, setConfirming] = useState(false);
  const [copying, setCopying] = useState(false);
  // What Copy new link did, shown in the row. Deliberately not a live region: `say()` does the
  // announcing, and an `aria-live` node here would say the same thing twice.
  const [copyNote, setCopyNote] = useState<{ bad: boolean; text: string } | null>(null);
  const open = inv.status === "pending" || inv.status === "expired";
  const error = [regen, revoked].find((s) => s && !s.ok);

  const linkOf = (data: DeliveryDto): Link => ({
    ...data.link,
    email: inv.email,
    kind: data.kind,
    deliveryEmail: data.email,
  });

  useEffect(() => {
    if (regen?.ok) onLink(linkOf(regen.data));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to each new result only
  }, [regen]);

  /**
   * Regenerate and copy in one activation. The action is awaited directly rather than dispatched
   * through `useActionState`, because the URL it returns is needed here and now to hand to the
   * clipboard — a dispatch only lands the result in state a render later.
   */
  async function copyNewLink() {
    setCopying(true);
    setCopyNote(null);
    try {
      const formData = new FormData();
      formData.set("slug", slug);
      formData.set("invitationId", inv.id);
      const result = await regenerateInvitation(null, formData);
      if (!result.ok) {
        setCopyNote({ bad: true, text: result.message });
        say(result.message);
        return;
      }
      const next = linkOf(result.data);
      try {
        await navigator.clipboard.writeText(next.url);
      } catch {
        // No clipboard write: an insecure origin, a denied permission, or a browser without the API.
        // The old link is already dead, so this must not read as a failure — fall back to the panel's
        // CopyField, which the inviter can select and copy by hand.
        onLink(next);
        setCopyNote({ bad: false, text: "Could not copy automatically. The new link is ready to copy above." });
        say(`A new invitation link for ${inv.email} is ready to copy above. The previous link has stopped working.`);
        return;
      }
      setCopyNote({ bad: false, text: "New link copied. The previous link stopped working." });
      say(`New invitation link for ${inv.email} copied to the clipboard. The previous link has stopped working.`);
    } finally {
      setCopying(false);
    }
  }

  return (
    <Row>
      <Cell header>
        {inv.email}
        <Sub>Invited by {inv.inviterName}</Sub>
      </Cell>
      <Cell>{roleLabel(inv.role)}</Cell>
      <Cell>
        <Badge tone={tone[inv.status]}>{label[inv.status]}</Badge>
        <Sub>
          Expires <LocalTime value={inv.expiresAt} timeZone={timeZone} />
        </Sub>
      </Cell>
      <Cell>
        {open && inv.canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              pending={copying}
              pendingLabel="Copying…"
              onClick={copyNewLink}
              aria-label={`Copy a new invitation link for ${inv.email}`}
            >
              Copy new link
            </Button>
            {/* Kept beside Copy new link as the path that works without client JavaScript, and the one
                that shows the link rather than putting it straight on the clipboard. */}
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
          <p role="alert" className="mt-1 text-xs text-danger">
            {error.message}
          </p>
        ) : null}
        {copyNote ? (
          <p className={`mt-1 text-xs ${copyNote.bad ? "text-danger" : "text-muted-foreground"}`}>{copyNote.text}</p>
        ) : null}
      </Cell>
    </Row>
  );
}
