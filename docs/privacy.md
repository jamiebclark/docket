# Privacy

Docket is a **self-hosted** social post scheduler. Each installation is run by the person or
organisation who deployed it, on their own server and their own database. There is no hosted
Docket service, no shared account system and no central server: the authors of Docket operate
nothing, receive nothing and can see nothing.

This page describes what a Docket installation stores and what it sends where, so that an
operator can answer those questions for their own users, and so that the platforms Docket
connects to can see what the application does with the access they grant it.

## Who the operator is

The **operator** is whoever deployed this installation. They control the server, the database,
the backups and the access to them. Any question about retention, deletion or disclosure for a
particular installation is a question for its operator, not for the Docket project.

## What Docket stores

- **Account content you give it**: projects, posts and their text, scheduling times, media you
  upload, generation prompts and voice profiles.
- **Connected social accounts**: the account identifier and display name each platform returns
  when you connect it (for example a Pinterest account id and business name, or a Facebook Page
  id and name), plus any non-secret per-account settings.
- **Access credentials for those accounts**: OAuth access tokens and refresh tokens, or app
  passwords where a platform uses them. These are **encrypted at rest** with AES-256-GCM under a
  key held in the installation's environment, are never sent to the browser, and are never written
  to logs, error messages, publish records or test output.
- **A record of what was published**: which post went to which account, when, whether it
  succeeded, and the identifier the platform returned, so a failure can be explained and a
  duplicate avoided.
- **Sign-in details for Docket itself**: the email address and password hash of each member of the
  installation, handled by Better Auth.

## What Docket sends, and where

- **To the social platforms you connect**: the posts you schedule, and the media attached to them,
  at the time you scheduled them. Docket reads only what it needs to publish — for Pinterest, the
  connected account's name and the list of boards it owns, so a post can be assigned to a board.
- **To an LLM provider, only if the operator configures one**: the prompts and brand context used
  to generate post text, and generated images where image generation is configured.
- **To an SMTP server, only if the operator configures one**: notification emails to members.
- **Nowhere else.** Docket sends no usage data, analytics or telemetry to its authors or to any
  third party. Next.js's own build telemetry is disabled in the published image.

## What Docket does not do

- It does not read, collect or store other people's posts, boards or profiles. It touches only the
  accounts an operator has explicitly connected, and only to publish on their behalf.
- It does not sell or share anything with anyone. There is no advertising and no tracking.
- It does not ask for or handle a platform password. Connections are made through each platform's
  own authorisation flow, in that platform's own window, and Docket never sees the credentials
  entered there.

## Deleting data

Disconnecting a social account removes its stored credentials from the installation. Deleting a
project or a post removes its content. Because Docket is self-hosted, an operator can also delete
the database outright; nothing survives elsewhere, because nothing was sent elsewhere.

Revoking Docket's access from the platform side also works and takes effect immediately: the next
publish attempt simply fails and the account is flagged as needing to be reconnected.

## Contact

Questions about a particular installation go to the operator of that installation. Questions about
the software itself belong on the [project repository](https://github.com/jamiebclark/docket).
