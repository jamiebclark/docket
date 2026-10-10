import type { CandidatesResult, ConnectCandidate } from "../types";
import { graphStepError } from "./errors";
import { graphList, graphRequest, type MetaApp } from "./graph";

const MAX_PAGES = 5; // first request + 4 follows (R9): at most 500 Pages at limit=100
/** Granted ids resolved one by one after the listing; a cap keeps a long grant from fanning out. */
const MAX_GRANTED_LOOKUPS = 50;
const PAGE_FIELDS = "id,name,access_token,instagram_business_account";

/** Granular scopes whose `target_ids` are Page ids. Instagram scopes carry Instagram ids instead. */
const PAGE_SCOPES = new Set(["pages_show_list", "pages_manage_posts", "pages_read_engagement"]);

interface PageEntry {
  id?: unknown;
  name?: unknown;
  access_token?: unknown;
  instagram_business_account?: { id?: unknown } | null;
}

const ID = /^\d{1,40}$/;

/** The Page and, when one is linked, its Instagram account. Empty when the entry is unusable. */
function candidatesForPage(raw: unknown): ConnectCandidate[] {
  const page = raw as PageEntry | null;
  if (!page || typeof page !== "object") return [];
  const { id, name, access_token: token } = page;
  if (typeof id !== "string" || !ID.test(id)) return [];
  if (typeof name !== "string" || !name) return [];
  if (typeof token !== "string" || !token) return [];
  const igId = page.instagram_business_account?.id;
  const hasIg = typeof igId === "string" && ID.test(igId);
  const out: ConnectCandidate[] = [
    {
      providerKey: "facebook",
      externalId: id,
      displayName: name,
      settings: {},
      credentials: { pageToken: token },
      expiresAt: null,
      ...(hasIg ? {} : { notes: ["No Instagram professional account is linked."] }),
    },
  ];
  if (hasIg) {
    out.push({
      providerKey: "instagram",
      externalId: igId,
      displayName: `${name} · Instagram`,
      settings: { pageId: id },
      credentials: { pageToken: token },
      expiresAt: null,
      parent: { providerKey: "facebook", externalId: id },
    });
  }
  return out;
}

/**
 * Page ids the login granted, read from the token's granular scopes.
 *
 * `/me/accounts` lists only Pages the person holds directly: a Page owned by a Business Portfolio is
 * absent from it even when the person has full control and picked that Page in the login dialog
 * (docs/accounts.md). Those Pages still resolve by id, so the ids are taken from `/debug_token`,
 * which needs an app token rather than a user token.
 *
 * Best effort: any failure returns no ids and leaves the `/me/accounts` listing as the only source.
 */
async function grantedPageIds(
  app: MetaApp,
  input: { userToken: string; appId: string; appSecret: string; signal: AbortSignal },
): Promise<string[]> {
  const outcome = await graphRequest(app, {
    method: "GET",
    path: "/debug_token",
    params: { input_token: input.userToken },
    token: `${input.appId}|${input.appSecret}`,
    signal: input.signal,
  });
  if (outcome.kind !== "ok") return [];
  const scopes = (outcome.body as { data?: { granular_scopes?: unknown } } | null)?.data?.granular_scopes;
  if (!Array.isArray(scopes)) return [];
  const ids = new Set<string>();
  for (const entry of scopes) {
    const scope = (entry as { scope?: unknown } | null)?.scope;
    if (typeof scope !== "string" || !PAGE_SCOPES.has(scope)) continue;
    // No `target_ids` means the scope was granted for everything, which the listing already covers.
    const targets = (entry as { target_ids?: unknown }).target_ids;
    if (!Array.isArray(targets)) continue;
    for (const t of targets) if (typeof t === "string" && ID.test(t)) ids.add(t);
  }
  return [...ids];
}

/** One Page by id, for an id the listing did not return. Null when it cannot be read. */
async function pageById(
  app: MetaApp,
  input: { id: string; userToken: string; signal: AbortSignal },
): Promise<unknown | null> {
  const outcome = await graphRequest(app, {
    method: "GET",
    path: `/${input.id}`,
    params: { fields: PAGE_FIELDS },
    token: input.userToken,
    signal: input.signal,
  });
  return outcome.kind === "ok" ? outcome.body : null;
}

export async function listPageCandidates(
  app: MetaApp,
  input: {
    userToken: string;
    signal: AbortSignal;
    /** Both set → Pages missing from the listing are recovered by id. Absent → listing only. */
    appId?: string;
    appSecret?: string;
  },
): Promise<CandidatesResult> {
  const res = await graphList(
    app,
    {
      method: "GET",
      path: "/me/accounts",
      params: { fields: PAGE_FIELDS, limit: "100" },
      token: input.userToken,
      signal: input.signal,
    },
    MAX_PAGES,
  );
  if (res.kind !== "ok") {
    const err = graphStepError(res, { mayPublish: false, platform: "Facebook", secrets: [input.userToken] });
    if (res.kind === "graph_error" && res.error.code === 190) {
      return { ok: false, message: "That token is expired or invalid. Sign in with Facebook again." };
    }
    return { ok: false, message: err?.error ?? "Could not list Facebook Pages." };
  }

  const candidates: ConnectCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of res.items) {
    const mapped = candidatesForPage(raw);
    const page = mapped[0];
    if (page) seen.add(page.externalId);
    candidates.push(...mapped);
  }

  // Pages the listing omits (Business Portfolio-owned) still resolve by id.
  if (input.appId && input.appSecret) {
    const granted = await grantedPageIds(app, {
      userToken: input.userToken,
      appId: input.appId,
      appSecret: input.appSecret,
      signal: input.signal,
    });
    for (const id of granted.filter((g) => !seen.has(g)).slice(0, MAX_GRANTED_LOOKUPS)) {
      const body = await pageById(app, { id, userToken: input.userToken, signal: input.signal });
      if (!body) continue;
      const mapped = candidatesForPage(body);
      const page = mapped[0];
      if (!page) continue;
      seen.add(page.externalId);
      candidates.push(...mapped);
    }
  }

  // No Pages is "no accounts", not a failed sign-in: the callback shows the permissions banner (F1).
  return {
    ok: true,
    candidates,
    ...(res.truncated ? { notices: ["Only the first 500 Pages are shown."] } : {}),
  };
}
