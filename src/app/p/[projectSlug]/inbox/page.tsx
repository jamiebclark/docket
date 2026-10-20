import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AnnounceProvider } from "@/components/ui/Announce";
import { ChoiceField } from "@/components/ui/ChoiceField";
import { EmptyState } from "@/components/ui/EmptyState";
import { InboxItemDetail } from "@/components/engagement/InboxItemDetail";
import { InboxList } from "@/components/engagement/InboxList";
import { PermissionNotice } from "@/components/accounts/PermissionNotice";
import { findProvider } from "@/providers/registry";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { buttonStyles } from "@/components/ui/Button";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { getInboxItem, listEngagementAccounts, listInbox } from "@/server/services/engagement/inbox";
import { docsHref } from "@/lib/docs";

export const metadata: Metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ projectSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const querySchema = z.object({
  account: z.string().uuid().optional().catch(undefined),
  kind: z.enum(["reply", "comment", "mention", "direct_message"]).optional().catch(undefined),
  state: z.enum(["waiting", "answered", "dismissed"]).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(100_000).catch(1).default(1),
  /** The open item, rendered in the pane beside the list (design-system.md §19). */
  item: z.string().uuid().optional().catch(undefined),
});

function hrefFor(
  slug: string,
  params: { account?: string; kind?: string; state?: string; item?: string },
  page?: number,
): string {
  const qs = new URLSearchParams();
  if (params.account) qs.set("account", params.account);
  if (params.kind) qs.set("kind", params.kind);
  if (params.state) qs.set("state", params.state);
  if (params.item) qs.set("item", params.item);
  if (page && page > 1) qs.set("page", String(page));
  const s = qs.toString();
  return `/p/${slug}/inbox${s ? `?${s}` : ""}`;
}

export default async function InboxPage({ params, searchParams }: Props) {
  const { projectSlug } = await params;
  const raw = await searchParams;
  let scope;
  try {
    scope = await forProject(await getSession(), projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  if (!scope.can({ engagement: ["view"] })) notFound();

  const query = querySchema.parse({
    account: first(raw.account),
    kind: first(raw.kind),
    state: first(raw.state),
    page: first(raw.page),
    item: first(raw.item),
  });
  const [list, accounts] = await Promise.all([
    listInbox(scope, { socialAccountId: query.account, kind: query.kind, state: query.state, page: query.page }),
    listEngagementAccounts(scope),
  ]);
  // An item that has been removed, or belongs to another project, closes the pane rather than
  // failing the whole page — the list is still worth showing.
  const openItem = query.item
    ? await getInboxItem(scope, query.item).catch((error) => {
        if (error instanceof NotFoundError) return null;
        throw error;
      })
    : null;
  const openProvider = openItem ? findProvider(openItem.providerKey) : undefined;
  const openCaps = openProvider?.capabilities.text ?? { maxLength: 0, countingRule: "code_points" as const };
  const canReply = scope.can({ engagement: ["reply"] });
  const tz = scope.project.timezone;
  const filtered = !!query.account || !!query.kind || !!query.state;

  return (
    <AnnounceProvider focusFallbackId="page-title">
      <section>
        <PageHeader title="Inbox" titleId="page-title" description={`Replies and mentions from connected accounts. Times are in ${tz}.`} />

        {accounts.some((a) => a.unavailable) ? (
          <div className="mt-4 flex flex-col gap-2">
            {accounts
              .filter((a) => a.unavailable)
              .map((a) => (
                <PermissionNotice
                  key={a.id}
                  tone="info"
                  title={`${a.displayName} (${a.providerDisplayName}) is not available for the inbox yet.`}
                  reason={a.unavailable!.reason}
                  {...(a.unavailable!.docsPath ? { docsPath: a.unavailable!.docsPath } : {})}
                />
              ))}
          </div>
        ) : null}

        {accounts.some((a) => !a.unavailable && a.readPermission && a.readPermission.kind !== "ok") ? (
          <div className="mt-4 space-y-2">
            {accounts.flatMap((a) => {
              const permission = a.readPermission;
              if (a.unavailable || !permission || permission.kind === "ok") return [];
              return [
                <PermissionNotice
                  key={a.id}
                  title={`${a.displayName} (${a.providerDisplayName}) needs a reconnect to read its comments.`}
                  reason={permission.reason}
                  {...(permission.docsPath ? { docsPath: permission.docsPath } : {})}
                  action={
                    <Link href={`/p/${projectSlug}/accounts#account-${a.id}`} className={buttonStyles({ variant: "secondary" })}>
                      Go to the account
                    </Link>
                  }
                />,
              ];
            })}
          </div>
        ) : null}

        <form method="get" action={`/p/${projectSlug}/inbox`} className="mt-4 flex flex-wrap items-end gap-3">
          <ChoiceField
            id="inbox-account"
            name="account"
            label="Account"
            compact
            autoSubmit
            defaultValue={query.account ?? ""}
            options={[
              { value: "", label: "All accounts" },
              ...accounts
                .filter((a) => !a.unavailable && !(a.readPermission && a.readPermission.kind !== "ok"))
                .map((a) => ({ value: a.id, label: a.displayName })),
            ]}
          />
          <ChoiceField
            id="inbox-kind"
            name="kind"
            label="Kind"
            compact
            autoSubmit
            defaultValue={query.kind ?? ""}
            options={[
              { value: "", label: "All kinds" },
              { value: "reply", label: "Reply" },
              { value: "comment", label: "Comment" },
              { value: "mention", label: "Mention" },
              { value: "direct_message", label: "Direct message" },
            ]}
          />
          <ChoiceField
            id="inbox-state"
            name="state"
            label="State"
            compact
            autoSubmit
            defaultValue={query.state ?? ""}
            options={[
              { value: "", label: "All" },
              { value: "waiting", label: "Waiting" },
              { value: "answered", label: "Answered" },
              { value: "dismissed", label: "Dismissed" },
            ]}
          />
          <noscript>
            <button type="submit" className={buttonStyles({ variant: "secondary" })}>
              Apply
            </button>
          </noscript>
        </form>

        {/*
          List and detail side by side from `lg` up, so opening an item keeps the reader's place
          (design-system.md §19). Narrower than that there is only room for one, so the open item
          replaces the list — and `/inbox/[itemId]` stays the route a direct link uses.
        */}
        <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-start">
          <div className={`min-w-0 flex-1 ${openItem ? "hidden lg:block" : ""}`}>
            {list.items.length === 0 ? (
              <EmptyState
                message={filtered ? "No items match this filter." : "Replies and mentions will show up here."}
                action={
                  filtered ? (
                    <Link href={`/p/${projectSlug}/inbox`} className={buttonStyles({ variant: "secondary" })}>
                      Clear filters
                    </Link>
                  ) : undefined
                }
              />
            ) : (
              <>
                <InboxList
                  items={list.items}
                  hrefForItem={(id) => hrefFor(projectSlug, { ...query, item: id }, query.page)}
                  timeZone={tz}
                  selectedId={openItem?.id}
                  now={new Date()}
                />
                <Pagination
                  page={list.page}
                  pageSize={list.pageSize}
                  total={list.total}
                  hrefFor={(p) => hrefFor(projectSlug, { ...query, item: undefined }, p)}
                />
              </>
            )}
          </div>

          {openItem ? (
            <aside
              aria-labelledby="inbox-open-item"
              className="min-w-0 rounded-xl border border-border bg-surface p-4 lg:sticky lg:top-4 lg:w-[26rem] xl:w-[32rem]"
            >
              <p className="lg:hidden">
                <Link href={hrefFor(projectSlug, { ...query, item: undefined }, query.page)} className="text-sm underline">
                  ← Back to inbox
                </Link>
              </p>
              <div className="lg:mt-0 mt-3">
                <InboxItemDetail
                  item={openItem}
                  projectSlug={projectSlug}
                  tz={tz}
                  canReply={canReply}
                  maxLength={openCaps.maxLength}
                  countingRule={openCaps.countingRule}
                  headingLevel={2}
                  headingId="inbox-open-item"
                />
              </div>
            </aside>
          ) : null}
        </div>
      </section>
    </AnnounceProvider>
  );
}
