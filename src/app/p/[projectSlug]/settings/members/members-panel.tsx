"use client";

import { useActionState, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Cell, Row, Table } from "@/components/ui/Table";
import type { ActionResult } from "@/lib/action-result";
import { changeMemberRole, leaveProject, removeMember, transferOwnership } from "./actions";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

const ROLE_OPTIONS = [
  { value: "editor", label: "Editor" },
  { value: "admin", label: "Admin" },
  { value: "owner", label: "Owner" },
];

export interface MemberItem {
  userId: string;
  name: string;
  email: string;
  role: string;
  joinedAt: string;
  isSelf: boolean;
  canChangeRole: boolean;
  canRemove: boolean;
  canTransfer: boolean;
  canLeave: boolean;
}

type Confirm = "remove" | "leave" | "transfer";
type Action = (prev: ActionResult<null> | null, formData: FormData) => Promise<ActionResult<null>>;

const errorClass = "mt-1 text-xs text-danger";
const joined = (iso: string) => new Date(iso).toISOString().slice(0, 10);

export function MembersPanel({ slug, members }: { slug: string; members: MemberItem[] }) {
  return (
    <section aria-labelledby="members-heading" className="flex flex-col gap-4">
      <h2 id="members-heading" className="text-lg font-semibold">
        Members
      </h2>
      <Table caption="Members" columns={["Name", "Email", "Role", "Joined", "Actions"]}>
        {members.map((m) => (
          <MemberRow key={m.userId} slug={slug} m={m} />
        ))}
      </Table>
    </section>
  );
}

function MemberRow({ slug, m }: { slug: string; m: MemberItem }) {
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [roleState, roleAction, changing] = useActionState<ActionResult<null> | null, FormData>(changeMemberRole, null);
  const error = roleState && !roleState.ok ? roleState.message : null;

  return (
    <Row>
      <Cell header>
        {m.name}
        {m.isSelf ? <span className="ml-2"><Badge>You</Badge></span> : null}
      </Cell>
      <Cell>{m.email}</Cell>
      <Cell>
        {m.canChangeRole ? (
          <form action={roleAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="userId" value={m.userId} />
            <SegmentedControl
              name="role"
              label={`Role for ${m.name}`}
              hideLabel
              size="sm"
              defaultValue={m.role}
              options={ROLE_OPTIONS}
            />
            <Button type="submit" variant="secondary" size="sm" pending={changing} pendingLabel="Saving…">
              Save
            </Button>
          </form>
        ) : (
          <span className="capitalize">{m.role}</span>
        )}
      </Cell>
      <Cell>
        <time dateTime={m.joinedAt}>{joined(m.joinedAt)}</time>
      </Cell>
      <Cell>
        <div className="flex flex-wrap gap-2">
          {m.canTransfer ? (
            <Button variant="secondary" onClick={() => setConfirm("transfer")} aria-label={`Transfer ownership to ${m.name}`}>
              Transfer ownership
            </Button>
          ) : null}
          {m.canRemove ? (
            <Button variant="danger" onClick={() => setConfirm("remove")} aria-label={`Remove ${m.name}`}>
              Remove
            </Button>
          ) : null}
          {m.canLeave ? (
            <Button variant="danger" onClick={() => setConfirm("leave")}>
              Leave project
            </Button>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className={errorClass}>
            {error}
          </p>
        ) : null}
        {m.canTransfer ? (
          <ConfirmDialog
            open={confirm === "transfer"}
            onClose={() => setConfirm(null)}
            slug={slug}
            userId={m.userId}
            action={transferOwnership}
            title={`Transfer ownership to ${m.name}?`}
            body={`${m.name} becomes an owner and you become an admin.`}
            submit="Transfer ownership"
            pendingLabel="Transferring…"
          />
        ) : null}
        {m.canRemove ? (
          <ConfirmDialog
            open={confirm === "remove"}
            onClose={() => setConfirm(null)}
            slug={slug}
            userId={m.userId}
            action={removeMember}
            title={`Remove ${m.name}?`}
            body={`${m.name} loses access to this project immediately.`}
            submit="Remove member"
            pendingLabel="Removing…"
          />
        ) : null}
        {m.canLeave ? (
          <ConfirmDialog
            open={confirm === "leave"}
            onClose={() => setConfirm(null)}
            slug={slug}
            userId={m.userId}
            action={leaveProject}
            title={`Leave this project, ${m.name}?`}
            body="You lose access immediately and need a new invitation to return."
            submit="Leave project"
            pendingLabel="Leaving…"
          />
        ) : null}
      </Cell>
    </Row>
  );
}

function ConfirmDialog({
  open,
  onClose,
  slug,
  userId,
  action,
  title,
  body,
  submit,
  pendingLabel,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  userId: string;
  action: Action;
  title: string;
  body: string;
  submit: string;
  pendingLabel: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult<null> | null, FormData>(action, null);
  const error = state && !state.ok ? state.message : null;
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <p className="mb-4 text-sm">{body}</p>
      {error ? (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <form action={formAction} className="flex gap-2">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="userId" value={userId} />
        <Button type="submit" variant="danger" pending={pending} pendingLabel={pendingLabel}>
          {submit}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </form>
    </Dialog>
  );
}
