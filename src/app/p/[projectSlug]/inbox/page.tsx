import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AnnounceProvider } from "@/components/ui/Announce";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { ChoiceField } from "@/components/ui/ChoiceField";
import { EmptyState } from "@/components/ui/EmptyState";
import { LocalTime } from "@/components/ui/LocalTime";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { Cell, Row, Table } from "@/components/ui/Table";
import { buttonStyles } from "@/components/ui/Button";
import { ENGAGEMENT_ITEM_KINDS, ENGAGEMENT_KIND_LABEL } from "@/lib/engagement/kinds";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { listEngagementAccounts, listInbox, type InboxItemView } from "@/server/services/engagement/inbox";

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
});

const STATE_TONE: Record<InboxItemView["state"], BadgeTone> = { waiting: "info", answered: "success", dismissed: "neutral" };

function hrefFor(slug: string, params: { account?: string; kind?: string; state?: string }, page?: number): string {
  const qs = new URLSearchParams();
  if (params.account) qs.set("account", params.account);
  if (params.kind) qs.set("kind", params.kind);
  if (params.state) qs.set("state", params.state);
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

  const query = querySchema.parse({ account: first(raw.account), kind: first(raw.kind), state: first(raw.state), page: first(raw.page) });
  const [list, accounts] = await Promise.all([
    listInbox(scope, { socialAccountId: query.account, kind: query.kind, state: query.state, page: query.page }),
    listEngagementAccounts(scope),
  ]);
  const tz = scope.project.timezone;
  const filtered = !!query.account || !!query.kind || !!query.state;

  return (
    <AnnounceProvider focusFallbackId="page-title">
      <section>
        <PageHeader title="Inbox" titleId="page-title" description={`Replies and mentions from connected accounts. Times are in ${tz}.`} />

        {accounts.some((a) => a.unavailable) ? (
          <div className="mt-4 space-y-2">
            {accounts
              .filter((a) => a.unavailable)
              .map((a) => (
                <p key={a.id} role="status" className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                  {a.displayName} ({a.providerDisplayName}) is not available for the inbox yet: {a.unavailable!.reason}
                  {a.unavailable!.docsPath ? (
                    <>
                      {" "}
                      <Link href={a.unavailable!.docsPath} className="underline">
                        Learn more
                      </Link>
                    </>
                  ) : null}
                </p>
              ))}
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
            options={[{ value: "", label: "All accounts" }, ...accounts.filter((a) => !a.unavailable).map((a) => ({ value: a.id, label: a.displayName }))]}
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
              ...ENGAGEMENT_ITEM_KINDS.map((kind) => ({ value: kind, label: ENGAGEMENT_KIND_LABEL[kind] })),
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

        <div className="mt-4">
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
              <Table caption="Engagement inbox" columns={["Author", "Said", "On", "State"]}>
                {list.items.map((item) => (
                  <Row key={item.id}>
                    <Cell header>
                      <Link href={`/p/${projectSlug}/inbox/${item.id}`} className="underline">
                        {item.author.displayName ?? item.author.handle ?? "Unknown"}
                      </Link>
                      <p className="mt-0.5 text-sm text-muted-foreground">{item.text || "(no text)"}</p>
                    </Cell>
                    <Cell>
                      <LocalTime value={item.saidAt} timeZone={tz} />
                    </Cell>
                    <Cell>{item.socialAccount.displayName}</Cell>
                    <Cell>
                      <Badge tone={STATE_TONE[item.state]}>{item.state}</Badge>
                      {item.kind === "direct_message" ? <Badge tone="warning">Private</Badge> : null}
                    </Cell>
                  </Row>
                ))}
              </Table>
              <Pagination
                page={list.page}
                pageSize={list.pageSize}
                total={list.total}
                hrefFor={(p) => hrefFor(projectSlug, query, p)}
              />
            </>
          )}
        </div>
      </section>
    </AnnounceProvider>
  );
}
