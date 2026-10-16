import type { ReactNode } from "react";
import { OperatorContactLink, OperatorStatement, type PublicSiteInfo } from "@/components/public/OperatorStatement";
import { linkStyles } from "@/components/ui/controls";

/**
 * The privacy policy every installation serves at `/privacy`. This module is the policy's text in code;
 * `docs/privacy.md` is the same policy for the repository, and `policy.test.tsx` fails when a `## ` heading
 * there has no section here. Change the two together and move `POLICY_LAST_UPDATED`.
 */
export const POLICY_TITLE = "Privacy Policy";
export const POLICY_LAST_UPDATED = "14 October 2026";

const REPOSITORY = "https://github.com/jamiebclark/docket";

export interface PolicySection {
  /** Fragment id, so a reviewer can be pointed at one section (`/privacy#what-docket-sends`). */
  id: string;
  title: string;
  body: (site: PublicSiteInfo) => ReactNode;
}

function List({ children }: { children: ReactNode }) {
  return <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-muted-foreground">{children}</ul>;
}

function Scope({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 text-xs">{children}</code>;
}

export const POLICY_SECTIONS: readonly PolicySection[] = [
  {
    id: "who-runs-this-installation",
    title: "Who runs this installation",
    body: (site) => (
      <>
        <OperatorStatement site={site} />
        <p>
          The operator controls the server, the database, the backups and who can sign in. Questions about how long
          data is kept, deleting it or disclosing it on this installation are for the operator, not for the authors of
          the Docket software, who have no access to it.
        </p>
      </>
    ),
  },
  {
    id: "what-docket-stores",
    title: "What Docket stores",
    body: () => (
      <List>
        <li>
          <strong>Content members give it:</strong> projects, posts and their text, scheduling times, media uploaded
          for posts (kept in the file storage the operator configures), generation prompts and voice profiles.
        </li>
        <li>
          <strong>Connected social accounts:</strong> the account identifier and display name each platform returns
          when an account is connected (for example a Pinterest account id and its business name or username, or a
          Facebook Page id and name), plus any non-secret settings for that account.
        </li>
        <li>
          <strong>Access credentials for those accounts:</strong> OAuth access and refresh tokens, or app passwords
          where a platform uses them. They are <strong>encrypted at rest</strong> with AES-256-GCM under a key held
          in the installation&apos;s environment, are never sent to the browser, and are never written to logs, error
          messages or publish records.
        </li>
        <li>
          <strong>A record of what was published:</strong> which post went to which account, when, whether it
          succeeded and the identifier the platform returned, so a failure can be explained and a duplicate avoided,
          and a record of which member did what in each project.
        </li>
        <li>
          <strong>Inbound comments, mentions and replies, for connected accounts where this is supported
          (currently Bluesky only):</strong> the comment&apos;s text, who said it (the identifier the platform
          gives), and when, so a member can see it in context and reply to it. Kept for 90 days by default (an
          operator can change this), then deleted along with any reply drafted for it, unless a reply is still
          waiting for a decision.
        </li>
        <li>
          <strong>Sign-in details for members of this installation:</strong> name, email address and a password
          hash; for each signed-in session, the IP address and browser it was opened from. Cookies are used only to
          keep you signed in and to remember the last project you opened.
        </li>
      </List>
    ),
  },
  {
    id: "what-docket-sends",
    title: "What Docket sends, and where",
    body: () => (
      <List>
        <li>
          <strong>To the social platforms an account is connected on:</strong> the posts scheduled for that account,
          and the media attached to them, at the time they were scheduled for. Docket reads only what it needs to
          publish.
        </li>
        <li>
          <strong>Pinterest specifically:</strong> Docket reads the connected account&apos;s name and the list of
          boards that account owns, so a post can be assigned to one of its boards, and creates the Pins it is asked
          to publish. It requests only the scopes <Scope>user_accounts:read</Scope>, <Scope>boards:read</Scope> and{" "}
          <Scope>pins:write</Scope>. It does not read existing Pins, does not create or edit boards, and does not read
          any other Pinterest user&apos;s boards, Pins or profile.
        </li>
        <li>
          <strong>To an AI text or image provider, only if the operator configures one:</strong> the prompts and brand
          context used to generate post text, and image prompts where image generation is configured.
        </li>
        <li>
          <strong>To an email server, only if the operator configures one:</strong> notification emails to members.
        </li>
        <li>
          <strong>Nowhere else.</strong> Docket sends no usage data, analytics or telemetry to its authors or to any
          third party. Next.js&apos;s own telemetry is disabled in the published image.
        </li>
      </List>
    ),
  },
  {
    id: "what-docket-does-not-do",
    title: "What Docket does not do",
    body: () => (
      <List>
        <li>
          It does not read, collect or store other people&apos;s posts, boards or profiles. It touches only the
          accounts a member has explicitly connected, and only to publish on their behalf.
        </li>
        <li>It does not sell or share anything with anyone. There is no advertising and no tracking.</li>
        <li>
          It does not ask for or handle a platform password. Accounts are connected through each platform&apos;s own
          authorisation page, and Docket never sees the credentials entered there.
        </li>
      </List>
    ),
  },
  {
    id: "deleting-your-data",
    title: "Deleting your data and revoking access",
    body: () => (
      <>
        <p>
          Disconnecting a social account in Docket deletes its stored credentials from this installation. Deleting a
          project or a post deletes its content. Removing a connected account from a project deletes its inbound
          comments and message data too. The operator can also delete the database outright; nothing survives
          elsewhere, because nothing was sent elsewhere.
        </p>
        <p>
          You can also revoke Docket&apos;s access from the platform&apos;s side, in its settings for connected apps.
          That takes effect immediately: the next publish attempt fails and the account is shown as needing to be
          reconnected.
        </p>
        <p>To have your sign-in account or anything else removed from this installation, ask its operator.</p>
      </>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (site) => (
      <>
        {site.operatorContact ? (
          <p>
            Questions about this policy or your data on this installation: <OperatorContactLink contact={site.operatorContact} />.
          </p>
        ) : (
          <p>Questions about this policy or your data on this installation go to its operator.</p>
        )}
        <p>
          Questions about the Docket software itself belong on the{" "}
          <a href={REPOSITORY} className={linkStyles}>
            project repository
          </a>
          .
        </p>
      </>
    ),
  },
];

/** The whole policy: intro, then one `h2` section per entry in `POLICY_SECTIONS`. The page supplies the `h1`. */
export function PrivacyPolicy({ site }: { site: PublicSiteInfo }) {
  return (
    <div className="flex flex-col gap-8 text-sm leading-relaxed">
      <div className="flex flex-col gap-3">
        <p>
          This policy covers the Docket installation{site.host ? <> at <strong>{site.host}</strong></> : null}.
          Docket is self-hosted software for planning, scheduling and publishing posts to social accounts that its
          members connect. Each installation runs on its operator&apos;s own server and database; there is no hosted
          Docket service, and the authors of the software operate nothing, receive nothing and can see nothing here.
        </p>
        <p className="text-muted-foreground">
          It is written for the people whose accounts are connected to this installation, and for the platforms that
          review what the application does with the access they grant it.
        </p>
      </div>
      <nav aria-label="On this page">
        <ol className="flex list-decimal flex-col gap-1 pl-5 marker:text-muted-foreground">
          {POLICY_SECTIONS.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className={linkStyles}>
                {s.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      {POLICY_SECTIONS.map((s) => (
        <section key={s.id} aria-labelledby={s.id} className="flex flex-col gap-3">
          <h2 id={s.id} className="scroll-mt-6 text-lg font-semibold text-heading">
            {s.title}
          </h2>
          {s.body(site)}
        </section>
      ))}
    </div>
  );
}
