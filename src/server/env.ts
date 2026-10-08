import { z } from "zod";
import { emailSchema, PASSWORD_MAX, PASSWORD_MIN, passwordSchema } from "@/lib/validation";

const PG_URL = /^postgres(ql)?:\/\//;

/**
 * Cross-field rules, computed from the raw source rather than inside the schema:
 * a schema-level refinement is skipped when any base field fails, which would hide
 * these issues until the base ones were fixed.
 */
function crossFieldIssues(source: Record<string, string | undefined>): EnvIssue[] {
  const out: EnvIssue[] = [];
  const email = source.BOOTSTRAP_ADMIN_EMAIL;
  const pw = source.BOOTSTRAP_ADMIN_PASSWORD;
  if (email && !pw) {
    out.push({ name: "BOOTSTRAP_ADMIN_PASSWORD", reason: "required when BOOTSTRAP_ADMIN_EMAIL is set" });
  }
  if (pw && !email) {
    out.push({ name: "BOOTSTRAP_ADMIN_EMAIL", reason: "required when BOOTSTRAP_ADMIN_PASSWORD is set" });
  }
  if (email && !emailSchema.safeParse(email).success) {
    out.push({ name: "BOOTSTRAP_ADMIN_EMAIL", reason: "must be an email address" });
  }
  if (pw && !passwordSchema.safeParse(pw).success) {
    out.push({ name: "BOOTSTRAP_ADMIN_PASSWORD", reason: `must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters` });
  }
  const direct = source.DATABASE_URL_DIRECT;
  if (direct && !PG_URL.test(direct)) {
    out.push({
      name: "DATABASE_URL_DIRECT",
      reason: "must be a PostgreSQL URL starting with postgres:// or postgresql://",
    });
  }
  const secret = source.TICK_SECRET;
  if (secret && secret.length < 32) {
    out.push({ name: "TICK_SECRET", reason: "must be at least 32 characters when set" });
  }
  // Only compared when both are valid integers; a malformed one is already a base issue.
  const num = (name: string, def: number) => {
    const raw = source[name];
    if (raw === undefined || raw === "") return def;
    const n = Number(raw);
    return Number.isInteger(n) ? n : undefined;
  };
  const budget = num("SCHEDULER_TICK_BUDGET_SECONDS", 20);
  const timeout = num("SCHEDULER_PROVIDER_TIMEOUT_SECONDS", 10);
  const lease = num("SCHEDULER_LEASE_SECONDS", 300);
  const backoffBase = num("PUBLISH_BACKOFF_BASE_SECONDS", 60);
  const backoffMax = num("PUBLISH_BACKOFF_MAX_SECONDS", 3600);
  if (budget !== undefined && timeout !== undefined && lease !== undefined && lease <= budget + timeout) {
    out.push({
      name: "SCHEDULER_LEASE_SECONDS",
      reason: "must be greater than the tick budget plus the provider timeout",
    });
  }
  if (budget !== undefined && timeout !== undefined && timeout >= budget) {
    out.push({
      name: "SCHEDULER_PROVIDER_TIMEOUT_SECONDS",
      reason: "must be less than SCHEDULER_TICK_BUDGET_SECONDS",
    });
  }
  if (backoffBase !== undefined && backoffMax !== undefined && backoffMax < backoffBase) {
    out.push({
      name: "PUBLISH_BACKOFF_MAX_SECONDS",
      reason: "must be at least PUBLISH_BACKOFF_BASE_SECONDS",
    });
  }
  out.push(...storageIssues(source));
  return out;
}

const STORAGE_GROUP = ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_PUBLIC_BASE_URL"] as const;
const STORAGE_OPTIONAL = ["S3_ENDPOINT", "S3_REGION", "S3_FORCE_PATH_STYLE", "S3_CHECKSUMS", "S3_PREVIEW_URLS", "S3_BROWSER_ENDPOINT"] as const;
const HTTP_URL = /^https?:\/\/[^/\s?#][^\s?#]*$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** All-or-none storage group plus the checks that depend on NODE_ENV. Messages never carry values. */
function storageIssues(source: Record<string, string | undefined>): EnvIssue[] {
  const out: EnvIssue[] = [];
  const set = (n: string) => Boolean(source[n]);
  const anyGroup = STORAGE_GROUP.some(set);
  if (!anyGroup) {
    for (const n of STORAGE_OPTIONAL) {
      if (set(n)) out.push({ name: n, reason: "set S3_BUCKET and the other storage settings to enable storage" });
    }
    return out;
  }
  for (const n of STORAGE_GROUP) {
    if (!set(n)) out.push({ name: n, reason: "required when media storage is configured" });
  }
  const bucket = source.S3_BUCKET;
  if (bucket && !/^[a-z0-9.-]{3,63}$/.test(bucket)) {
    out.push({ name: "S3_BUCKET", reason: "must be 3–63 characters of a-z, 0-9, . or -" });
  }
  const base = source.S3_PUBLIC_BASE_URL;
  if (base) {
    let host: string | undefined;
    let protocol: string | undefined;
    let clean = false;
    try {
      const u = new URL(base);
      host = u.hostname;
      protocol = u.protocol;
      clean = !u.search && !u.hash && !u.username && !u.password;
    } catch {
      // handled below
    }
    if (!HTTP_URL.test(base) || !clean) {
      out.push({ name: "S3_PUBLIC_BASE_URL", reason: "must be an absolute http(s) URL with no query or fragment" });
    } else if (process.env.NODE_ENV === "production" && protocol === "http:" && !LOCAL_HOSTS.has(host ?? "")) {
      out.push({ name: "S3_PUBLIC_BASE_URL", reason: "must use https:// in production" });
    }
  }
  const endpoint = source.S3_ENDPOINT;
  if (endpoint && !HTTP_URL.test(endpoint)) {
    out.push({ name: "S3_ENDPOINT", reason: "must be an absolute http(s) URL" });
  }
  const browser = source.S3_BROWSER_ENDPOINT;
  if (browser) {
    if (!HTTP_URL.test(browser)) {
      out.push({ name: "S3_BROWSER_ENDPOINT", reason: "must be an absolute http(s) URL" });
    } else if (browser.startsWith("http:") && source.BETTER_AUTH_URL?.startsWith("https:")) {
      out.push({ name: "S3_BROWSER_ENDPOINT", reason: "must be https when BETTER_AUTH_URL is https" });
    }
    if (source.MEDIA_UPLOAD_TRANSPORT === "via_app") {
      out.push({
        name: "S3_BROWSER_ENDPOINT",
        reason: "is not used by the via_app transport; remove it",
      });
    }
  }
  return out;
}

export type EnvIssue = { name: string; reason: string };

export type S3StorageConfig = {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
  endpoint?: string;
  /** Where browsers send upload parts, when it differs from `endpoint`. */
  browserEndpoint?: string;
  region: string;
  forcePathStyle: boolean;
  checksums: "when_required" | "when_supported";
  previewUrls: "public" | "signed";
};

const url = (what: string) =>
  z
    .string({ error: "required" })
    .refine((v) => PG_URL.test(v), { error: `must be a ${what} URL starting with postgres:// or postgresql://` });

function isValidKey(v: string): boolean {
  if (/^[0-9a-fA-F]{64}$/.test(v)) return true;
  return /^[A-Za-z0-9+/]{43}=$/.test(v) && Buffer.from(v, "base64").length === 32;
}

const int = (min: number, max: number, def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: "custom", message: `must be an integer from ${min} to ${max}` });
        return z.NEVER;
      }
      return n;
    });

/** `true` | `false`; unset or empty means `def`. */
const bool = (def: boolean | (() => boolean)) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return typeof def === "function" ? def() : def;
      if (v === "true") return true;
      if (v === "false") return false;
      ctx.addIssue({ code: "custom", message: "must be true or false" });
      return z.NEVER;
    });

/** One of a fixed set of strings; unset or empty means `def`. */
const oneOf = <const T extends string>(values: readonly T[], def: T) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return def;
      if ((values as readonly string[]).includes(v)) return v as T;
      ctx.addIssue({ code: "custom", message: `must be one of: ${values.join(", ")}` });
      return z.NEVER;
    });

/** Comma-separated list; empty or unset means "not configured" (undefined). */
const csv = z
  .string()
  .optional()
  .transform((v) => {
    const items = (v ?? "").split(",").map((i) => i.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  });

function toStorage(e: {
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_PUBLIC_BASE_URL?: string;
  S3_ENDPOINT?: string;
  S3_BROWSER_ENDPOINT?: string;
  S3_REGION?: string;
  S3_FORCE_PATH_STYLE: boolean;
  S3_CHECKSUMS: S3StorageConfig["checksums"];
  S3_PREVIEW_URLS: S3StorageConfig["previewUrls"];
}): S3StorageConfig | null {
  if (!e.S3_BUCKET || !e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY || !e.S3_PUBLIC_BASE_URL) return null;
  return {
    bucket: e.S3_BUCKET,
    accessKeyId: e.S3_ACCESS_KEY_ID,
    secretAccessKey: e.S3_SECRET_ACCESS_KEY,
    publicBaseUrl: e.S3_PUBLIC_BASE_URL.replace(/\/+$/, ""),
    endpoint: e.S3_ENDPOINT || undefined,
    browserEndpoint: e.S3_BROWSER_ENDPOINT || undefined,
    region: e.S3_REGION || "auto",
    forcePathStyle: e.S3_FORCE_PATH_STYLE,
    checksums: e.S3_CHECKSUMS,
    previewUrls: e.S3_PREVIEW_URLS,
  };
}

const base = z.object({
    DATABASE_URL: url("PostgreSQL"),
    DATABASE_URL_DIRECT: z.string().optional(),
    DATABASE_POOL_MAX: int(1, 100, 10),
    BETTER_AUTH_SECRET: z
      .string({ error: "required, must be at least 32 characters" })
      .min(32, { error: "required, must be at least 32 characters" }),
    BETTER_AUTH_URL: z
      .string({ error: "required, must be an absolute http(s) URL" })
      .refine((v) => /^https?:\/\/[^/\s]+\/?$/.test(v), {
        error: "must be an absolute http(s) URL with no path",
      })
      .transform((v) => v.replace(/\/$/, "")),
    CREDENTIALS_ENCRYPTION_KEY: z
      .string({ error: "required" })
      .refine(isValidKey, {
        error: "must be 32 bytes encoded as base64 (44 chars) or hex (64 chars)",
      }),
    BOOTSTRAP_ADMIN_EMAIL: z.string().optional(),
    BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
    BOOTSTRAP_ADMIN_NAME: z.string().max(100, { error: "must be 1–100 characters" }).optional(),
    INVITATION_TTL_DAYS: int(1, 90, 7),
    TRUSTED_IP_HEADERS: csv,
    TRUSTED_PROXIES: csv,
    TICK_SECRET: z.string().optional(),
    WORKER_INTERVAL_SECONDS: int(30, 60, 60),
    RUN_WORKER_IN_PROCESS: bool(false),
    SCHEDULER_TICK_BUDGET_SECONDS: int(5, 25, 20),
    SCHEDULER_TICK_MAX_ITEMS: int(1, 500, 25),
    SCHEDULER_PROVIDER_TIMEOUT_SECONDS: int(1, 20, 10),
    SCHEDULER_LEASE_SECONDS: int(60, 3600, 300),
    PUBLISH_MAX_ATTEMPTS: int(1, 20, 5),
    PUBLISH_BACKOFF_BASE_SECONDS: int(1, 3600, 60),
    PUBLISH_BACKOFF_MAX_SECONDS: int(1, 86400, 3600),
    PUBLISH_MAX_DURATION_HOURS: int(1, 168, 24),
    TOKEN_REFRESH_WINDOW_HOURS: int(1, 720, 72),
    SCHEDULER_STALE_AFTER_MINUTES: int(1, 1440, 5),
    EXPLICIT_TIME_WARNING_MINUTES: int(0, 1440, 30),
    QUEUE_HORIZON_DAYS: int(7, 730, 366),
    GENERATION_TICK_MAX_ITEMS: int(1, 10, 2),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_PUBLIC_BASE_URL: z.string().optional(),
    S3_ENDPOINT: z.string().optional(),
    S3_BROWSER_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_FORCE_PATH_STYLE: bool(false),
    S3_CHECKSUMS: oneOf(["when_required", "when_supported"], "when_required"),
    S3_PREVIEW_URLS: oneOf(["public", "signed"], "public"),
    MEDIA_MAX_UPLOAD_MB: int(1, 25, 20),
    MEDIA_MAX_MEGAPIXELS: int(1, 100, 50),
    MEDIA_MAX_VIDEO_MB: int(1, 4096, 1024),
    MEDIA_MAX_VIDEO_SECONDS: int(1, 3600, 900),
    MEDIA_UPLOAD_TRANSPORT: oneOf(["direct", "via_app"], "direct"),
    MEDIA_UPLOAD_EXPIRY_HOURS: int(1, 168, 24),
    MEDIA_MAX_OPEN_UPLOADS: int(1, 50, 10),
    VIDEO_ENCODE_CONCURRENCY: int(1, 4, 1),
    MOCK_PROVIDER_ENABLED: bool(() => process.env.NODE_ENV !== "production"),
    MIGRATE_ON_START: z
      .string()
      .optional()
      .transform((v, ctx) => {
        if (v === undefined || v === "") return true;
        if (v === "true") return true;
        if (v === "false") return false;
        ctx.addIssue({ code: "custom", message: "must be true or false" });
        return z.NEVER;
      }),
    NODE_ENV: z
      .string()
      .optional()
      .refine((v) => !v || ["development", "production", "test"].includes(v), {
        error: "must be one of: development, production, test",
      }),
    PORT: z
      .string()
      .optional()
      .refine((v) => !v || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535), {
        error: "must be an integer from 1 to 65535",
      }),
    HOSTNAME: z
      .string()
      .optional()
      .refine((v) => !v || !/\s/.test(v), { error: "must not contain whitespace" }),
  });

/** Every variable the core schema reads (research D26); the coverage test checks this against the code. */
export const ENV_VARIABLES: readonly string[] = Object.keys(base.shape);

/** Empty means unset (FR-033): the one rule for which database URL migrations use. */
export function directUrlOf(source: Record<string, string | undefined>): string | undefined {
  return source.DATABASE_URL_DIRECT || source.DATABASE_URL || undefined;
}

const schema = base.transform((e) => ({
    ...e,
    storage: toStorage(e),
    media: {
      maxUploadBytes: e.MEDIA_MAX_UPLOAD_MB * 1024 * 1024,
      maxPixels: e.MEDIA_MAX_MEGAPIXELS * 1_000_000,
      maxVideoBytes: e.MEDIA_MAX_VIDEO_MB * 1024 * 1024,
      maxVideoSeconds: e.MEDIA_MAX_VIDEO_SECONDS,
      uploadTransport: e.MEDIA_UPLOAD_TRANSPORT,
      uploadExpiryHours: e.MEDIA_UPLOAD_EXPIRY_HOURS,
      maxOpenUploads: e.MEDIA_MAX_OPEN_UPLOADS,
      videoEncodeConcurrency: e.VIDEO_ENCODE_CONCURRENCY,
    },
    DATABASE_URL_DIRECT: e.DATABASE_URL_DIRECT || e.DATABASE_URL,
    BOOTSTRAP_ADMIN_NAME: e.BOOTSTRAP_ADMIN_NAME || "Admin",
    TICK_SECRET: e.TICK_SECRET || undefined,
  }));

export type Env = z.output<typeof schema>;

/** Pure. Collects every issue; messages describe the format and never carry values. */
export function parseEnv(
  source: Record<string, string | undefined>,
): { ok: true; env: Env } | { ok: false; issues: EnvIssue[] } {
  const r = schema.safeParse(source);
  const cross = crossFieldIssues(source);
  if (r.success && cross.length === 0) return { ok: true, env: r.data };
  const seen = new Set<string>();
  const issues: EnvIssue[] = [];
  const base = r.success
    ? []
    : r.error.issues.map((i) => ({ name: String(i.path[0] ?? "environment"), reason: i.message }));
  for (const i of [...base, ...cross]) {
    const key = `${i.name}:${i.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(i);
  }
  return { ok: false, issues };
}

export function formatEnvIssues(issues: EnvIssue[]): string {
  return ["Docket configuration error:", ...issues.map((i) => `  - ${i.name}: ${i.reason}`)].join("\n");
}

let cached: Env | undefined;

/** Lazy and memoised. Never evaluated at import so `next build` works without secrets. */
export function getEnv(): Env {
  if (cached) return cached;
  const r = parseEnv(process.env);
  if (!r.ok) throw new Error(formatEnvIssues(r.issues));
  cached = r.env;
  return cached;
}
