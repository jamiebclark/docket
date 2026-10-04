import type { ProviderEnvIssue } from "../types";

export const DEFAULT_GRAPH_VERSION = "v26.0";
export const GRAPH_VERSION_PATTERN = /^v\d{1,3}\.\d{1,2}$/;

export interface MetaConfig {
  appId: string;
  appSecret: string;
  graphVersion: string;
  loginConfigId: string | null;
}

type Source = Readonly<Record<string, string | undefined>>;

const APP_ID = /^\d{5,30}$/;
const SECRET_HEX = /^[0-9a-f]{32}$/i;
const SECRET_LOOSE = /^\S{16,128}$/;
const DIGITS = /^\d+$/;

function read(source: Source, name: string): string | null {
  const value = source[name]?.trim();
  return value ? value : null;
}

/** Pure. `config: null` means not configured (neither id nor secret). Issues carry names only. */
export function parseMetaEnv(source: Source): { config: MetaConfig | null; issues: ProviderEnvIssue[] } {
  const issues: ProviderEnvIssue[] = [];
  const appId = read(source, "META_APP_ID");
  const appSecret = read(source, "META_APP_SECRET");
  const version = read(source, "META_GRAPH_VERSION");
  const configId = read(source, "META_LOGIN_CONFIG_ID");

  if (appSecret && !appId) issues.push({ name: "META_APP_ID", reason: "required when META_APP_SECRET is set" });
  else if (appId && !APP_ID.test(appId)) issues.push({ name: "META_APP_ID", reason: "must be the numeric app id" });

  if (appId && !appSecret) issues.push({ name: "META_APP_SECRET", reason: "required when META_APP_ID is set" });
  else if (appSecret && !(SECRET_HEX.test(appSecret) || SECRET_LOOSE.test(appSecret))) {
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

  const valid =
    appId && appSecret && APP_ID.test(appId) && (SECRET_HEX.test(appSecret) || SECRET_LOOSE.test(appSecret));
  if (!valid) return { config: null, issues };
  return {
    config: {
      appId,
      appSecret,
      graphVersion: version && GRAPH_VERSION_PATTERN.test(version) ? version : DEFAULT_GRAPH_VERSION,
      loginConfigId: configId && DIGITS.test(configId) ? configId : null,
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
  const v = read(process.env, "META_GRAPH_VERSION");
  return v && GRAPH_VERSION_PATTERN.test(v) ? v : DEFAULT_GRAPH_VERSION;
}
