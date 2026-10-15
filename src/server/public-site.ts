import { emailSchema } from "@/lib/validation";
import type { EnvIssue } from "./env";

type Source = Record<string, string | undefined>;

/** Optional settings shown on the public pages (`/` and `/privacy`); none of them can stop Docket starting. */
export const PUBLIC_SITE_VARIABLES: readonly string[] = [
  "DOCKET_OPERATOR_NAME",
  "DOCKET_OPERATOR_CONTACT",
  "PINTEREST_DOMAIN_VERIFY",
];

const NAME_MAX = 100;
const CONTACT_MAX = 2048;
const CONTROL = /\p{Cc}/u;

/** How to reach the operator: an email address (rendered as `mailto:`) or an https page. */
export type OperatorContact = { kind: "email"; label: string; href: string } | { kind: "url"; label: string; href: string };

export interface PublicSite {
  /** Hostname (and port, if any) of `BETTER_AUTH_URL`; null when it is unset or unreadable. */
  host: string | null;
  /** Who runs this installation, exactly as configured; null means "whoever deployed it". */
  operatorName: string | null;
  operatorContact: OperatorContact | null;
  /** Content of Pinterest's `p:domain_verify` meta tag, for claiming the website. */
  pinterestDomainVerify: string | null;
  /** Values that were set but ignored. Names and reasons only, never values. */
  problems: EnvIssue[];
}

/** Trimmed; empty means unset. */
function read(source: Source, name: string): string | undefined {
  const v = source[name]?.trim();
  return v ? v : undefined;
}

function hostOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).host || null;
  } catch {
    return null;
  }
}

function contactOf(raw: string): OperatorContact | null {
  if (raw.length > CONTACT_MAX || /\s/.test(raw)) return null;
  if (!raw.includes("://")) {
    const email = emailSchema.safeParse(raw);
    return email.success ? { kind: "email", label: email.data, href: `mailto:${email.data}` } : null;
  }
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
    return { kind: "url", label: raw, href: u.href };
  } catch {
    return null;
  }
}

/** Pure. A malformed value is ignored (the page falls back to generic wording) and reported in `problems`. */
export function parsePublicSite(source: Source): PublicSite {
  const problems: EnvIssue[] = [];

  let operatorName: string | null = null;
  const name = read(source, "DOCKET_OPERATOR_NAME");
  if (name) {
    if (name.length > NAME_MAX || CONTROL.test(name)) {
      problems.push({ name: "DOCKET_OPERATOR_NAME", reason: `ignored: must be 1–${NAME_MAX} characters on one line` });
    } else {
      operatorName = name;
    }
  }

  let operatorContact: OperatorContact | null = null;
  const contact = read(source, "DOCKET_OPERATOR_CONTACT");
  if (contact) {
    operatorContact = contactOf(contact);
    if (!operatorContact) {
      problems.push({ name: "DOCKET_OPERATOR_CONTACT", reason: "ignored: must be an email address or an https:// URL" });
    }
  }

  let pinterestDomainVerify: string | null = null;
  const verify = read(source, "PINTEREST_DOMAIN_VERIFY");
  if (verify) {
    if (/^[A-Za-z0-9]{1,128}$/.test(verify)) pinterestDomainVerify = verify;
    else problems.push({ name: "PINTEREST_DOMAIN_VERIFY", reason: "ignored: must be letters and digits only" });
  }

  return { host: hostOf(read(source, "BETTER_AUTH_URL")), operatorName, operatorContact, pinterestDomainVerify, problems };
}

let cached: PublicSite | undefined;

/** Lazy and memoised, like `getEnv()`. Never evaluated at import so `next build` works unconfigured. */
export function getPublicSite(): PublicSite {
  cached ??= parsePublicSite(process.env);
  return cached;
}
