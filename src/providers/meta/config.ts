import type { ProviderEnvIssue } from "../types";

export const DEFAULT_GRAPH_VERSION = "v26.0";
export const GRAPH_VERSION_PATTERN = /^v\d{1,3}\.\d{1,2}$/;

export interface MetaConfig {
  appId: string;
  appSecret: string;
  graphVersion: string;
  loginConfigId: string | null;
  /** FR-017. Default off: `dialogUrl` requests no extra scope while this is false. */
  insightsScopes: boolean;
  /** FR-045. Percent of Meta's own BUC usage at or above which insights reads back off. */
  insightsUsageCeiling: number;
  /** G40. Default off: `dialogUrl` requests no engagement scope while this is false. */
  engagementScopes: boolean;
}

type Source = Readonly<Record<string, string | undefined>>;

const APP_ID = /^\d{5,30}$/;
const SECRET_HEX = /^[0-9a-f]{32}$/i;
const SECRET_LOOSE = /^\S{16,128}$/;
const DIGITS = /^\d+$/;
const DEFAULT_INSIGHTS_USAGE_CEILING = 80;

/** Trimmed value of `name`, or null when unset or blank. */
export function readEnv(source: Source, name: string): string | null {
  const value = source[name]?.trim();
  return value ? value : null;
}

export function isAppId(value: string): boolean {
  return APP_ID.test(value);
}

export function isAppSecret(value: string): boolean {
  return SECRET_HEX.test(value) || SECRET_LOOSE.test(value);
}

/** Pure. `config: null` means not configured (neither id nor secret). Issues carry names only. */
export function parseMetaEnv(source: Source): { config: MetaConfig | null; issues: ProviderEnvIssue[] } {
  const issues: ProviderEnvIssue[] = [];
  const appId = readEnv(source, "META_APP_ID");
  const appSecret = readEnv(source, "META_APP_SECRET");
  const version = readEnv(source, "META_GRAPH_VERSION");
  const configId = readEnv(source, "META_LOGIN_CONFIG_ID");
  const insightsScopesRaw = readEnv(source, "META_INSIGHTS_SCOPES");
  const usageCeilingRaw = readEnv(source, "META_INSIGHTS_USAGE_CEILING");
  const engagementScopesRaw = readEnv(source, "META_ENGAGEMENT_SCOPES");

  if (appSecret && !appId) issues.push({ name: "META_APP_ID", reason: "required when META_APP_SECRET is set" });
  else if (appId && !isAppId(appId)) issues.push({ name: "META_APP_ID", reason: "must be the numeric app id" });

  if (appId && !appSecret) issues.push({ name: "META_APP_SECRET", reason: "required when META_APP_ID is set" });
  else if (appSecret && !isAppSecret(appSecret)) {
    issues.push({ name: "META_APP_SECRET", reason: "must be the app secret from the dashboard" });
  }

  if (version && !GRAPH_VERSION_PATTERN.test(version)) {
    issues.push({ name: "META_GRAPH_VERSION", reason: "must look like v26.0" });
  }

  if (configId) {
    if (!DIGITS.test(configId)) issues.push({ name: "META_LOGIN_CONFIG_ID", reason: "must be the numeric configuration id" });
    else if (!appId || !appSecret) {
      issues.push({ name: "META_LOGIN_CONFIG_ID", reason: "set META_APP_ID and META_APP_SECRET to use it" });
    }
  }

  let insightsScopes = false;
  if (insightsScopesRaw !== null) {
    const v = insightsScopesRaw.toLowerCase();
    if (v === "true") insightsScopes = true;
    else if (v !== "false") issues.push({ name: "META_INSIGHTS_SCOPES", reason: "must be true or false" });
  }

  let insightsUsageCeiling = DEFAULT_INSIGHTS_USAGE_CEILING;
  if (usageCeilingRaw !== null) {
    const n = Number(usageCeilingRaw);
    if (Number.isInteger(n) && n >= 1 && n <= 100) insightsUsageCeiling = n;
    else issues.push({ name: "META_INSIGHTS_USAGE_CEILING", reason: "must be an integer from 1 to 100" });
  }

  let engagementScopes = false;
  if (engagementScopesRaw !== null) {
    const v = engagementScopesRaw.toLowerCase();
    if (v === "true") engagementScopes = true;
    else if (v !== "false") issues.push({ name: "META_ENGAGEMENT_SCOPES", reason: "must be true or false" });
  }

  const valid =
    appId && appSecret && isAppId(appId) && isAppSecret(appSecret);
  if (!valid) return { config: null, issues };
  return {
    config: {
      appId,
      appSecret,
      graphVersion: version && GRAPH_VERSION_PATTERN.test(version) ? version : DEFAULT_GRAPH_VERSION,
      loginConfigId: configId && DIGITS.test(configId) ? configId : null,
      insightsScopes,
      insightsUsageCeiling,
      engagementScopes,
    },
    issues,
  };
}

/** Reads process.env each call. Throws a value-free error when not configured. */
export function requireMetaConfig(): MetaConfig {
  const { config } = parseMetaEnv(process.env);
  if (!config) throw new Error("Meta is not configured: set META_APP_ID and META_APP_SECRET");
  return config;
}

/** Graph version only, so publishing works whenever the version is valid. */
export function graphVersion(): string {
  const v = readEnv(process.env, "META_GRAPH_VERSION");
  return v && GRAPH_VERSION_PATTERN.test(v) ? v : DEFAULT_GRAPH_VERSION;
}

/** `META_INSIGHTS_USAGE_CEILING` only, so a reader's ceiling check works whenever other Meta config is absent. */
export function metaUsageCeiling(): number {
  const raw = readEnv(process.env, "META_INSIGHTS_USAGE_CEILING");
  if (raw === null) return DEFAULT_INSIGHTS_USAGE_CEILING;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : DEFAULT_INSIGHTS_USAGE_CEILING;
}
