import type { CandidatesResult, ConnectCandidate } from "../types";
import { graphStepError } from "./errors";
import { graphList, type MetaApp } from "./graph";

const MAX_PAGES = 5; // first request + 4 follows (R9): at most 500 Pages at limit=100

const NO_PAGES =
  "No Facebook Pages were found for this login. The token needs pages_show_list, pages_manage_posts, pages_read_engagement, instagram_basic and instagram_content_publish.";

interface PageEntry {
  id?: unknown;
  name?: unknown;
  access_token?: unknown;
  instagram_business_account?: { id?: unknown } | null;
}

const ID = /^\d{1,40}$/;

export async function listPageCandidates(
  app: MetaApp,
  input: { userToken: string; signal: AbortSignal },
): Promise<CandidatesResult> {
  const res = await graphList(
    app,
    {
      method: "GET",
      path: "/me/accounts",
      params: { fields: "id,name,access_token,instagram_business_account", limit: "100" },
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
  for (const raw of res.items) {
    const page = raw as PageEntry | null;
    if (!page || typeof page !== "object") continue;
    const { id, name, access_token: token } = page;
    if (typeof id !== "string" || !ID.test(id)) continue;
    if (typeof name !== "string" || !name) continue;
    if (typeof token !== "string" || !token) continue;
    const igId = page.instagram_business_account?.id;
    const hasIg = typeof igId === "string" && ID.test(igId);
    candidates.push({
      providerKey: "facebook",
      externalId: id,
      displayName: name,
      settings: {},
      credentials: { pageToken: token },
      expiresAt: null,
      ...(hasIg ? {} : { notes: ["No Instagram professional account is linked."] }),
    });
    if (hasIg) {
      candidates.push({
        providerKey: "instagram",
        externalId: igId,
        displayName: `${name} · Instagram`,
        settings: { pageId: id },
        credentials: { pageToken: token },
        expiresAt: null,
        parent: { providerKey: "facebook", externalId: id },
      });
    }
  }
  if (candidates.length === 0) return { ok: false, message: NO_PAGES };
  return {
    ok: true,
    candidates,
    ...(res.truncated ? { notices: ["Only the first 500 Pages are shown."] } : {}),
  };
}

