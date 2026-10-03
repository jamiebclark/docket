# Docket

Self-hosted, multi-project social scheduler and LLM post generator for
Facebook Pages, Instagram, Threads and Bluesky. One codebase replaces a
scheduler + workflow-automation + CMS stack; every account, post, media file
and brand setting belongs to exactly one project.

> Status: under active construction. See `docs/build-prompt.md` for the full
> product brief and `docs/decisions.md` for design decisions.

## Requirements
- Node 24 LTS (`.nvmrc`) and pnpm (`corepack enable`)
- Docker (for Postgres and the Compose stack)

## Development
```sh
pnpm install
pnpm dev          # http://localhost:3000
pnpm lint
pnpm typecheck
pnpm test
```

## Docker
```sh
docker build -t docket .
```
Behind a TLS-intercepting proxy, pass your CA bundle as a build secret:
`docker build --secret id=extra_ca,src=/path/to/ca.pem -t docket .`

## Contributing
Conventional Commits are enforced (commitlint + husky). Releases are cut by
semantic-release from `main`. Features are built with
[speckit-pipeline](https://github.com/github/spec-kit): see
`.specify/memory/constitution.md` for the rules every change follows.

## License
MIT
