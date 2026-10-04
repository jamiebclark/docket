import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { LocalTime } from "@/components/ui/LocalTime";
import { Cell, Row, Table } from "@/components/ui/Table";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as accounts from "@/server/services/accounts";
import { findConnectGroup } from "@/providers/registry";
import * as connect from "@/server/services/connect";
import * as slots from "@/server/services/slots";
import { ConnectGroupSection } from "./ConnectGroupSection";
import { ConnectCredentialsForm } from "./ConnectCredentialsForm";
import { ConnectMockForm } from "./ConnectMockForm";
import { ReconnectGroupButton } from "./ReconnectGroupButton";
import { RemoveAccountDialog } from "./RemoveAccountDialog";
import { MockBehaviourForm, ReconnectMockButton, SlotEditor, SlotRowActions } from "./SlotEditor";

export const metadata: Metadata = { title: "Accounts" };
export const dynamic = "force-dynamic";

const WEEKDAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

const STATUS: Record<accounts.AccountView["status"], { label: string; tone: "success" | "danger" | "neutral" }> = {
  active: { label: "Connected", tone: "success" },
  needs_reauth: { label: "Needs reconnecting", tone: "danger" },
};

const CONNECT_BANNER: Record<string, string> = {
  cancelled: "Connecting was cancelled. Nothing changed.",
  platform_error: "The platform returned an error. Nothing changed. Try again.",
  exchange_failed: "Could not finish signing in. Check the app id, secret and redirect address in the setup guide.",
  no_candidates: "No accounts were found for this login. Check the permissions you granted and try again.",
  too_many: "That login found too many accounts to list. Narrow the permissions you granted and try again.",
  not_allowed: "Only project owners and admins can connect accounts.",
};

const HINTED_CODES: ReadonlySet<string> = new Set(["platform_error", "exchange_failed", "no_candidates"]);

export default async function AccountsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectSlug: string }>;
  searchParams?: Promise<{ connect?: string | string[]; group?: string | string[] }>;
}) {
  const { projectSlug } = await params;
  const query = await searchParams;
  const connectParam = query?.connect;
  const baseBanner = typeof connectParam === "string" ? CONNECT_BANNER[connectParam] : undefined;
  // The hint comes from the registered group, never from platform text; an unknown group value shows nothing.
  const hint =
    typeof connectParam === "string" && typeof query?.group === "string" && HINTED_CODES.has(connectParam)
      ? findConnectGroup(query.group)?.group.callbackHint
      : undefined;
  const banner = baseBanner && hint ? `${baseBanner} ${hint}` : baseBanner;
  let scope;
  try {
    scope = await forProject(await getSession(), projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const canManage = scope.can({ account: ["manage"] });
  const timeZone = scope.project.timezone;
  const [list, providers] = await Promise.all([accounts.listAccounts(scope), accounts.listConnectableProviders(scope)]);
  const mockEnabled = providers.some((p) => p.key === "mock");
  // The mock keeps its own form; every other provider with `connectAccount` gets the generic credentials form.
  const credentialProviders = providers.flatMap((p) =>
    p.key !== "mock" && p.credentialConnect && p.connect.strategy !== "oauth" ? [{ ...p, fields: [...p.connect.fields] }] : [],
  );
  const groups = await connect.listConnectGroups(scope);
  const withSlots = await Promise.all(list.map(async (account) => ({ account, slots: await slots.listSlots(scope, account.id) })));

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Accounts</h1>
      {banner ? (
        <p role="alert" className="rounded-md border border-foreground/30 p-3 text-sm">
          {banner}
        </p>
      ) : null}
      {groups.map((g) => (
        <ConnectGroupSection
          key={g.key}
          slug={projectSlug}
          groupKey={g.key}
          displayName={g.displayName}
          providerNames={g.providerNames}
          configured={g.configured}
          setupDoc={g.setupDoc}
          redirectUri={g.redirectUri}
          canManage={canManage}
          paste={g.paste}
          unavailable={g.unavailable}
        />
      ))}
      {canManage && mockEnabled ? <ConnectMockForm slug={projectSlug} /> : null}
      {canManage
        ? credentialProviders.map((p) => (
            <section key={p.key} aria-labelledby={`connect-${p.key}-heading`} className="flex flex-col gap-3 rounded-lg border border-foreground/20 p-4">
              <h2 id={`connect-${p.key}-heading`} className="text-lg font-semibold">
                Connect a {p.displayName} account
              </h2>
              <ConnectCredentialsForm slug={projectSlug} providerKey={p.key} providerName={p.displayName} fields={p.fields} submitLabel="Connect" />
            </section>
          ))
        : null}
      {withSlots.length === 0 ? (
        <EmptyState message="No accounts are connected yet." />
      ) : (
        withSlots.map(({ account, slots: rows }) => {
          const status = STATUS[account.status];
          const isMock = account.providerKey === "mock";
          const behaviour = (account.settings as { behaviour?: string } | null)?.behaviour ?? "succeed";
          return (
            <section
              key={account.id}
              id={`account-${account.id}`}
              aria-labelledby={`account-${account.id}-name`}
              className="flex flex-col gap-3 rounded-lg border border-foreground/20 p-4"
            >
              <header className="flex flex-wrap items-center gap-2">
                <h2 id={`account-${account.id}-name`} className="text-lg font-semibold">
                  {account.displayName}
                </h2>
                <span className="text-sm text-foreground/70">{account.providerName}</span>
                <Badge tone={status.tone}>{status.label}</Badge>
              </header>
              {account.lastError ? (
                <p className="text-sm text-red-700 dark:text-red-400">Last error: {account.lastError}</p>
              ) : null}
              <p className="text-sm text-foreground/70">
                Connected <LocalTime value={account.connectedAt} timeZone={timeZone} />
              </p>
              {account.notes.map((note, i) => (
                <p key={i} className="text-sm">
                  {note}
                </p>
              ))}
              {canManage && isMock ? (
                <div className="flex flex-wrap items-end gap-4">
                  {account.status === "needs_reauth" ? <ReconnectMockButton slug={projectSlug} id={account.id} /> : null}
                  <MockBehaviourForm slug={projectSlug} id={account.id} behaviour={behaviour} />
                </div>
              ) : null}
              {canManage && account.status === "needs_reauth"
                ? groups
                    .filter((g) => g.available && g.providerKeys.includes(account.providerKey))
                    .map((g) => <ReconnectGroupButton key={g.key} slug={projectSlug} groupKey={g.key} displayName={g.displayName} />)
                : null}
              {canManage && account.status === "needs_reauth"
                ? groups
                    .filter((g) => g.unavailable && g.paste && g.providerKeys.includes(account.providerKey))
                    .map((g) => (
                      <p key={g.key} className="text-sm">
                        Paste a new token in Connect {g.displayName} to reconnect.
                      </p>
                    ))
                : null}
              {canManage && account.status === "needs_reauth"
                ? credentialProviders
                    .filter((p) => p.key === account.providerKey)
                    .map((p) => (
                      <details key={p.key} className="rounded-md border border-foreground/20 p-3">
                        <summary className="cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground">
                          Reconnect
                        </summary>
                        <div className="mt-3">
                          <ConnectCredentialsForm
                            slug={projectSlug}
                            providerKey={p.key}
                            providerName={p.displayName}
                            fields={p.fields}
                            accountId={account.id}
                            submitLabel="Reconnect"
                          />
                        </div>
                      </details>
                    ))
                : null}
              <h3 className="text-base font-medium">Posting slots ({timeZone})</h3>
              {rows.length === 0 ? (
                <p className="text-sm text-foreground/70">No posting slots yet.</p>
              ) : (
                <Table caption={`Posting slots for ${account.displayName}`} columns={canManage ? ["Day", "Time", "Status", "Actions"] : ["Day", "Time", "Status"]}>
                  {rows.map((slot) => (
                    <Row key={slot.id}>
                      <Cell>{WEEKDAYS[slot.weekday]}</Cell>
                      <Cell>
                        {slot.localTime.slice(0, 5)} {timeZone}
                      </Cell>
                      <Cell>{slot.paused ? <Badge tone="warning">Paused</Badge> : <Badge>Active</Badge>}</Cell>
                      {canManage ? (
                        <Cell>
                          <SlotRowActions slug={projectSlug} id={slot.id} paused={slot.paused} label={`${WEEKDAYS[slot.weekday]} ${slot.localTime.slice(0, 5)}`} />
                        </Cell>
                      ) : null}
                    </Row>
                  ))}
                </Table>
              )}
              {canManage ? (
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <SlotEditor slug={projectSlug} accountId={account.id} />
                  <RemoveAccountDialog slug={projectSlug} id={account.id} name={account.displayName} />
                </div>
              ) : null}
            </section>
          );
        })
      )}
    </section>
  );
}
