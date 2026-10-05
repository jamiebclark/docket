/**
 * Variables the code or Compose files mention that are not user configuration (research D26).
 * The coverage test (tests/lint/env-coverage.test.ts) requires every variable read anywhere to be
 * validated, listed here, or in `.env.example`.
 */
export const INTERNAL_VARIABLES: Readonly<Record<string, string>> = {
  NEXT_RUNTIME: "set by Next.js to tell the edge and Node runtimes apart",
  DOCKET_PREMIGRATED: "set by scripts/prestart.mjs for its child so startup does not migrate twice",
  NEXT_TELEMETRY_DISABLED: "Next.js build and runtime flag, set in the image only",
  PNPM_HOME: "package-manager location, set in the image only",
  PATH: "shell search path, set in the image only",
  COREPACK_HOME: "Corepack cache location, set in the image only",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "stops Corepack asking before it downloads, set in the image only",
};

/** Read by docker-compose.yml or the smoke script, never by Docket itself. */
export const COMPOSE_ONLY_VARIABLES: Readonly<Record<string, string>> = {
  DOCKET_IMAGE: "image the web, worker and storage-init services run",
  DOCKET_BIND: "host interface the web port is published on",
  DOCKET_PORT: "host port the web service is published on",
  BACKUP_PATH: "host directory the db-backup service writes dumps to",
  BACKUP_KEEP_DAYS: "days the db-backup service keeps dumps",
  MINIO_IMAGE: "image tag for the offline-profile MinIO service",
  MINIO_ROOT_USER: "MinIO root user for the offline profile",
  MINIO_ROOT_PASSWORD: "MinIO root password for the offline profile",
  SMOKE_BASE_URL: "base URL the smoke script waits for and calls",
};
