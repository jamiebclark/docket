import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { LocalTime } from "@/components/ui/LocalTime";
import { Cell, Row, Table } from "@/components/ui/Table";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as accounts from "@/server/services/accounts";
import { CONNECT_BANNER, HINTED_CODES, connectBannerText } from "@/lib/accounts/connect-banner-text";
import { findConnectGroup } from "@/providers/registry";
import * as connect from "@/server/services/connect";
import { openBannerMessage } from "@/server/services/connect-banner";
import * as slots from "@/server/services/slots";
import { askManagers, askOwners } from "@/lib/roles/names";
import { listManagers } from "@/server/services/members";
import { ConnectGroupSection } from "./ConnectGroupSection";
import { ConnectCredentialsForm } from "./ConnectCredentialsForm";
import { ConnectMockForm } from "./ConnectMockForm";
import { ReconnectGroupButton } from "./ReconnectGroupButton";
import { RemoveAccountDialog } from "./RemoveAccountDialog";
import { PostingInstructionsForm } from "./PostingInstructionsForm";
import { MockBehaviourForm, ReconnectMockButton, SlotEditor, SlotRowActions } from "./SlotEditor";
import { alertStyles } from "@/components/ui/Alert";
import { buttonStyles } from "@/components/ui/Button";
import { Icon, ProviderIcon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = { title: "Accounts" };
export const dynamic = "force-dynamic";

const WEEKDAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

const STATUS: Record<accounts.AccountView["status"], { label: string; tone: "success" | "danger" | "neutral" }> = {
  active: { label: "Connected", tone: "success" },
  needs_reauth: { label: "Needs reconnecting", tone: "danger" },
};

export default async function AccountsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectSlug: string }>;
  searchParams?: Promise<{ connect?: string | string[]; group?: string | string[]; notice?: string | string[] }>;
}) {
  const { projectSlug } = await params;
  const query = await searchParams;
  const connectParam = query?.connect;
  // The platform's own message replaces the generic text only when Docket sealed it for this project, group and code (G18).
  const own =
    typeof connectParam === "string" && connectParam in CONNECT_BANNER && typeof query?.group === "string" && typeof query.notice === "string"
      ? openBannerMessage({ projectSlug, groupKey: query.group, code: connectParam }, query.notice, new Date())
      : null;
  // The hint comes from the registered group, never from platform text; an unknown group value shows nothing.
  const hint =
    typeof connectParam === "string" && typeof query?.group === "string" && HINTED_CODES.has(connectParam)
      ? findConnectGroup(query.group)?.group.callbackHint
      : undefined;
  const banner = typeof connectParam === "string" ? connectBannerText({ code: connectParam, own, hint }) : undefined;
  let scope;
  try {
    scope = await forProject(await getSession(), projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const canManage = scope.can({ account: ["manage"] });
  const isOwner = scope.membership.role === "owner";
  const timeZone = scope.project.timezone;
  const [list, providers] = await Promise.all([accounts.listAccounts(scope), accounts.listConnectableProviders(scope)]);
  const mockEnabled = providers.some((p) => p.key === "mock");
  // The mock keeps its own form; every other provider with `connectAccount` gets the generic credentials form.
  const credentialProviders = providers.flatMap((p) =>
    p.key !== "mock" && p.credentialConnect && p.connect.strategy !== "oauth" ? [{ ...p, fields: [...p.connect.fields] }] : [],
  );
  const groups = await connect.listConnectGroups(scope);
  const managers = await listManagers(scope);
  const configuredGroups = groups.filter((g) => g.configured);
  // Only owners can set a platform up on the server, so only they see the groups that aren't.
  const unconfiguredGroups = isOwner ? groups.filter((g) => !g.configured) : [];
  const nothingConnectable = configuredGroups.length === 0 && !mockEnabled && credentialProviders.length === 0 && unconfiguredGroups.length === 0;
  const groupSection = (g: (typeof groups)[number]) => (
    <ConnectGroupSection
      key={g.key}
      slug={projectSlug}
      groupKey={g.key}
      displayName={g.displayName}
      providerKeys={g.providerKeys}
      providerNames={g.providerNames}
      configured={g.configured}
      setupDoc={g.setupDoc}
      redirectUri={g.redirectUri}
      canManage={canManage}
      paste={g.paste}
      unavailable={g.unavailable}
    />
  );
  const withSlots = await Promise.all(list.map(async (account) => ({ account, slots: await slots.listSlots(scope, account.id) })));

  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        title="Accounts"
        description={`Connected social accounts and their weekly posting slots. Times are in ${timeZone}.`}
        actions={
          canManage ? (
            <a href="#add-account" className={buttonStyles({ variant: "secondary" })}>
              <Icon name="plus" size={16} />
              Add an account
            </a>
          ) : null
        }
      />
      {banner ? (
        <p role="alert" className={alertStyles("warning")}>
          {banner}
        </p>
      ) : null}
      <section aria-labelledby="connected-heading" className="flex flex-col gap-4">
        <h2 id="connected-heading" className="text-lg font-semibold">
          Connected accounts{withSlots.length > 0 ? ` (${withSlots.length})` : ""}
        </h2>
        {withSlots.length > 0 ? (
          <p id="posting-slots-definition" className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Posting slots:</span> Weekly times this account posts at. Add to queue fills the next free slot.
          </p>
        ) : null}
        {withSlots.length === 0 ? (
          <EmptyState
            icon="accounts"
            message={
              canManage
                ? "You don't have any accounts yet. Connect one below to start scheduling posts."
                : `No accounts yet. Ask ${askManagers(managers, "or")} to connect one.`
            }
          />
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
                className="flex scroll-mt-[calc(var(--sticky-top)+1rem)] flex-col gap-3 rounded-xl border border-border bg-surface p-5 shadow-card"
              >
                <header className="flex flex-wrap items-center gap-3">
                  <ProviderIcon providerKey={account.providerKey} size={40} />
                  <div className="flex min-w-0 flex-col">
                    <h3 id={`account-${account.id}-name`} className="text-lg font-semibold">
                      {account.displayName}
                    </h3>
                    <span className="text-sm text-muted-foreground">{account.providerName}</span>
                  </div>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </header>
                {account.lastError ? (
                  <p className="text-sm text-danger">Last error: {account.lastError}</p>
                ) : null}
                <p className="text-sm text-muted-foreground">
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
                        <details key={p.key} className="rounded-lg border border-border bg-surface p-3">
                          <summary className="cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
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
                <h4 className="text-sm font-semibold">Posting instructions</h4>
                {canManage ? (
                  <PostingInstructionsForm
                    slug={projectSlug}
                    accountId={account.id}
                    accountName={account.displayName}
                    initial={account.postingInstructions}
                  />
                ) : account.postingInstructions ? (
                  <p className="whitespace-pre-wrap text-sm">{account.postingInstructions}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">No posting instructions.</p>
                )}
                <h4 id={`account-${account.id}-slots`} className="scroll-mt-[calc(var(--sticky-top)+1rem)] text-sm font-semibold">Posting slots ({timeZone})</h4>
                {rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No posting slots yet.</p>
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
                  <div className="flex flex-col gap-4 border-t border-border pt-4">
                    <SlotEditor slug={projectSlug} accountId={account.id} />
                    <div className="flex justify-end">
                      <RemoveAccountDialog slug={projectSlug} id={account.id} name={account.displayName} />
                    </div>
                  </div>
                ) : null}
              </section>
            );
          })
        )}
      </section>
      {canManage ? (
        <section id="add-account" aria-labelledby="add-account-heading" className="flex scroll-mt-[calc(var(--sticky-top)+1rem)] flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 id="add-account-heading" className="text-lg font-semibold">
              Add an account
            </h2>
            <p className="text-sm text-muted-foreground">Each connection brings in the accounts you choose; posting slots are set per account afterwards.</p>
          </div>
          <div className="grid items-start gap-4 lg:grid-cols-2">
            {configuredGroups.map(groupSection)}
            {canManage && mockEnabled ? (
              <section aria-labelledby="connect-mock-heading" className="flex flex-col gap-3 rounded-xl border border-dashed border-input bg-surface p-5">
                <div className="flex items-center gap-3">
                  <ProviderIcon providerKey="mock" size={32} />
                  <h3 id="connect-mock-heading" className="text-base font-semibold">
                    Mock account (offline testing)
                  </h3>
                </div>
                <ConnectMockForm slug={projectSlug} />
              </section>
            ) : null}
            {canManage
              ? credentialProviders.map((p) => (
                  <section key={p.key} aria-labelledby={`connect-${p.key}-heading`} className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 shadow-card">
                    <div className="flex items-center gap-3">
                      <ProviderIcon providerKey={p.key} size={32} />
                      <h3 id={`connect-${p.key}-heading`} className="text-lg font-semibold">
                        Connect a {p.displayName} account
                      </h3>
                    </div>
                    <ConnectCredentialsForm slug={projectSlug} providerKey={p.key} providerName={p.displayName} fields={p.fields} submitLabel="Connect" />
                  </section>
                ))
              : null}
          </div>
          {unconfiguredGroups.length > 0 ? (
            <details className="rounded-lg border border-border bg-surface p-3">
              <summary className="cursor-pointer rounded-md text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                Not set up on this server ({unconfiguredGroups.length})
              </summary>
              <div className="mt-3 flex flex-col gap-4">{unconfiguredGroups.map(groupSection)}</div>
            </details>
          ) : null}
          {nothingConnectable ? (
            <p className="text-sm text-muted-foreground">
              No platforms are set up on this server yet. Ask {askOwners(managers, "or")} to set one up.
            </p>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
