// docs: links to the published documentation (docs/ built by mkdocs.yml onto GitHub Pages).

export const DOCS_BASE_URL = "https://jamiebclark.github.io/docket/";

/** A published page: the file name under docs/ without `.md`. */
export type DocPage =
  | "accounts"
  | "adding-a-provider"
  | "deployment"
  | "generator"
  | "getting-started"
  | "insights"
  | "limits"
  | "meta-setup"
  | "n8n"
  | "pinterest-setup"
  | "security"
  | "storage"
  | "tiktok-setup"
  | "x-setup";

/** The published URL of a docs page, optionally at a heading anchor (GitHub-style slug, e.g. "local-https-for-threads"). */
export function docsUrl(page: DocPage, anchor?: string): string {
  return `${DOCS_BASE_URL}${page}/${anchor ? `#${anchor}` : ""}`;
}

const DOC_PAGES = new Set<DocPage>([
  "accounts",
  "adding-a-provider",
  "deployment",
  "generator",
  "getting-started",
  "insights",
  "limits",
  "meta-setup",
  "n8n",
  "pinterest-setup",
  "security",
  "storage",
  "tiktok-setup",
  "x-setup",
]);

function isDocPage(value: string): value is DocPage {
  return DOC_PAGES.has(value as DocPage);
}

/** A provider-declared `page#anchor` docs pointer → its published URL. */
export function docsHref(docsPath: string): string {
  const hashIndex = docsPath.indexOf("#");
  const page = hashIndex === -1 ? docsPath : docsPath.slice(0, hashIndex);
  const anchor = hashIndex === -1 ? undefined : docsPath.slice(hashIndex + 1);
  if (!isDocPage(page)) return DOCS_BASE_URL;
  return docsUrl(page, anchor);
}
