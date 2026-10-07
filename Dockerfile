# syntax=docker/dockerfile:1
# One image for every service: `web` runs the Next.js server, `worker` runs the
# scheduler loop from the same build (command overridden in docker-compose.yml).

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_HOME=/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json ./
# Optional `--secret id=extra_ca,src=<pem>` for builds behind a TLS-intercepting
# proxy; never baked into the image. Node only warns if the file is absent.
# pnpm is fetched once here so later stages never hit the network for it.
RUN --mount=type=secret,id=extra_ca,required=false \
    NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca corepack enable && \
    NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca corepack install

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
