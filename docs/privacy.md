# Privacy Policy

Last updated 14 October 2026

**Every Docket installation serves this policy itself, at `<BETTER_AUTH_URL>/privacy`** (for example
`https://docket.example.com/privacy`), with no sign-in needed. **That is the URL to give Pinterest, Meta and any
other platform that asks for a privacy policy** — not this file on GitHub: platforms want the policy on the app's
own domain. The page fills in the installation's address and, if set, who runs it (`DOCKET_OPERATOR_NAME` and
`DOCKET_OPERATOR_CONTACT`, see `.env.example`).

The page text lives in `src/app/privacy/policy.tsx`. Keep the two in step: `src/app/privacy/policy.test.tsx`
fails when a `## ` heading here has no matching section on the page.

---

This policy covers the Docket installation it is published on. Docket is self-hosted software for planning,
scheduling and publishing posts to social accounts that its members connect. Each installation runs on its
operator's own server and database; there is no hosted Docket service, and the authors of the software operate
nothing, receive nothing and can see nothing on an installation.

It is written for the people whose accounts are connected to the installation, and for the platforms that review
what the application does with the access they grant it.

## Who runs this installation

The installation is operated by whoever deployed it. On the served page this reads "This installation at
`<host>` is operated by `<DOCKET_OPERATOR_NAME>`. Contact: `<DOCKET_OPERATOR_CONTACT>`." when those are set, and
"operated by whoever deployed it" when they are not.

The operator controls the server, the database, the backups and who can sign in. Questions about how long data is
kept, deleting it or disclosing it on an installation are for its operator, not for the authors of the Docket
software, who have no access to it.

## What Docket stores

- **Content members give it**: projects, posts and their text, scheduling times, media uploaded for posts (kept
  in the file storage the operator configures), generation prompts and voice profiles.
- **Connected social accounts**: the account identifier and display name each platform returns when an account
  is connected (for example a Pinterest account id and its business name or username, or a Facebook Page id and
  name), plus any non-secret settings for that account.
- **Access credentials for those accounts**: OAuth access and refresh tokens, or app passwords where a platform
  uses them. They are **encrypted at rest** with AES-256-GCM under a key held in the installation's environment,
  are never sent to the browser, and are never written to logs, error messages or publish records.
- **A record of what was published**: which post went to which account, when, whether it succeeded and the
  identifier the platform returned, so a failure can be explained and a duplicate avoided, and a record of which
  member did what in each project.
- **Sign-in details for members of the installation**: name, email address and a password hash (handled by
  Better Auth); for each signed-in session, the IP address and browser it was opened from. Cookies are used only
  to keep you signed in and to remember the last project you opened.

## What Docket sends, and where

- **To the social platforms an account is connected on**: the posts scheduled for that account, and the media
  attached to them, at the time they were scheduled for. Docket reads only what it needs to publish.
- **Pinterest specifically**: Docket reads the connected account's name and the list of boards that account owns,
  so a post can be assigned to one of its boards, and creates the Pins it is asked to publish. It requests only
  the scopes `user_accounts:read`, `boards:read` and `pins:write`. It does not read existing Pins, does not create
  or edit boards, and does not read any other Pinterest user's boards, Pins or profile.
- **To an AI text or image provider, only if the operator configures one**: the prompts and brand context used to
  generate post text, and image prompts where image generation is configured.
- **To an email server, only if the operator configures one**: notification emails to members.
- **Nowhere else.** Docket sends no usage data, analytics or telemetry to its authors or to any third party.
  Next.js's own telemetry is disabled in the published image.

## What Docket does not do

- It does not read, collect or store other people's posts, boards or profiles. It touches only the accounts a
  member has explicitly connected, and only to publish on their behalf.
- It does not sell or share anything with anyone. There is no advertising and no tracking.
- It does not ask for or handle a platform password. Accounts are connected through each platform's own
  authorisation page, and Docket never sees the credentials entered there.

## Deleting your data and revoking access

Disconnecting a social account in Docket deletes its stored credentials from the installation. Deleting a project
or a post deletes its content. The operator can also delete the database outright; nothing survives elsewhere,
because nothing was sent elsewhere.

You can also revoke Docket's access from the platform's side, in its settings for connected apps. That takes
effect immediately: the next publish attempt fails and the account is shown as needing to be reconnected.

To have your sign-in account or anything else removed from an installation, ask its operator.

## Contact

Questions about this policy or your data on an installation go to its operator (`DOCKET_OPERATOR_CONTACT` on the
served page, when set). Questions about the Docket software itself belong on the
[project repository](https://github.com/jamiebclark/docket).
