// docs: links to the published documentation (docs/ built by mkdocs.yml onto GitHub Pages).

export const DOCS_BASE_URL = "https://jamiebclark.github.io/docket/";

/** A published page: the file name under docs/ without `.md`. */
export type DocPage =
  | "accounts"
  | "adding-a-provider"
  | "deployment"
  | "generator"
  | "limits"
  | "meta-setup"
  | "n8n"
  | "security"
  | "storage"
  | "x-setup";

/** The published URL of a docs page, optionally at a heading anchor (GitHub-style slug, e.g. "local-https-for-threads"). */
export function docsUrl(page: DocPage, anchor?: string): string {
  return `${DOCS_BASE_URL}${page}/${anchor ? `#${anchor}` : ""}`;
}
