import { linkStyles } from "@/components/ui/controls";
import type { OperatorContact, PublicSite } from "@/server/public-site";

/** The parts of the installation's public settings the public pages show. */
export type PublicSiteInfo = Pick<PublicSite, "host" | "operatorName" | "operatorContact">;

/** The operator's contact as a link: `mailto:` for an email address, the page itself for an https URL. */
export function OperatorContactLink({ contact }: { contact: OperatorContact }) {
  return (
    <a href={contact.href} className={`${linkStyles} break-all`}>
      {contact.label}
    </a>
  );
}

/**
 * "This installation at <host> is operated by <name>. Contact: <contact>." Only ever states what is configured
 * (`DOCKET_OPERATOR_NAME`, `DOCKET_OPERATOR_CONTACT`); unset, it says "whoever deployed it" and never guesses.
 */
export function OperatorStatement({ site, className = "" }: { site: PublicSiteInfo; className?: string }) {
  return (
    <p className={className}>
      This installation{site.host ? (
        <>
          {" "}at <strong className="font-semibold">{site.host}</strong>
        </>
      ) : null}{" "}
      is operated by {site.operatorName ? <strong className="font-semibold">{site.operatorName}</strong> : "whoever deployed it"}.
      {site.operatorContact ? (
        <>
          {" "}Contact: <OperatorContactLink contact={site.operatorContact} />.
        </>
      ) : null}
    </p>
  );
}
