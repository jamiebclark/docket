# syntax=docker/dockerfile:1
# One image for every service: `web` runs the Next.js server, `worker` runs the
# scheduler loop from the same build (command overridden in docker-compose.yml).

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_HOME=/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json ./
# Optional `--secret id=extra_ca,src=<pem>` for builds behind a TLS-intercepting
# proxy; never baked into the image. Node only warns if the file is absent.
#
# pnpm is fetched once here so later stages never hit the network for it. That takes two
# steps, not one: `corepack install` caches the pnpm *npm package*, but pnpm 12 then fetches
# a separate native binary (`@pnpm/exe.<platform>`) the first time it actually runs, landing
# it beside the package at $COREPACK_HOME/v1/pnpm/<version>/pnpm-native. Without the warm-up
# run below, `deps` and `build` each fetched that binary themselves, so a slow registry
# failed the whole image build on a 30 s timeout with nothing else wrong (#191 lost four CI
# runs to exactly that). The warm-up needs this project's own package.json in scope: with no
# `packageManager` field in sight pnpm resolves the latest release instead and caches a binary
# no later stage wants. It runs against a throwaway copy because pnpm drops a stray lockfile
# beside whatever package.json it finds.
RUN --mount=type=secret,id=extra_ca,required=false \
    NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca corepack enable && \
    NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca corepack install && \
    mkdir -p /warm && cp package.json /warm/ && cd /warm && \
    NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca pnpm --version && \
    cd / && rm -rf /warm

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    --mount=type=secret,id=extra_ca,required=false \
    NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=secret,id=extra_ca,required=false \
    NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca pnpm build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
# FFmpeg (GPL build from Debian, includes libx264); the worker runs it as a separate program. See NOTICE.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs nextjs
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --chown=nextjs:nodejs NOTICE ./NOTICE
# scripts/prestart.mjs is bundled (esbuild) into .next/standalone/scripts by `pnpm build`.
USER nextjs
EXPOSE 3000
# Migrates first so a failed migration exits before the server listens.
CMD ["node", "scripts/prestart.mjs"]
