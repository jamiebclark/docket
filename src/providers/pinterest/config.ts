import type { ProviderEnvIssue } from "../types";
import { readEnv } from "../meta/config";

export interface PinterestConfig {
  clientId: string;
  clientSecret: string;
}

type Source = Readonly<Record<string, string | undefined>>;

const ID_MAX = 200;
const SECRET_MAX = 500;

function valid(value: string, max: number): boolean {
  return value.length <= max && !/\s/.test(value);
}

/** Pure. `config: null` means not configured. Issues carry names and reasons, never values (contracts/pinterest-connect.md §1). */
export function parsePinterestEnv(source: Source): { config: PinterestConfig | null; issues: ProviderEnvIssue[] } {
  const issues: ProviderEnvIssue[] = [];
  const clientId = readEnv(source, "PINTEREST_CLIENT_ID");
  const clientSecret = readEnv(source, "PINTEREST_CLIENT_SECRET");

  if (clientSecret && !clientId) issues.push({ name: "PINTEREST_CLIENT_ID", reason: "required when PINTEREST_CLIENT_SECRET is set" });
  else if (clientId && !valid(clientId, ID_MAX)) {
    issues.push({ name: "PINTEREST_CLIENT_ID", reason: "must be the app ID from the Pinterest developer portal" });
  }

  if (clientId && !clientSecret) issues.push({ name: "PINTEREST_CLIENT_SECRET", reason: "required when PINTEREST_CLIENT_ID is set" });
  else if (clientSecret && !valid(clientSecret, SECRET_MAX)) {
    issues.push({ name: "PINTEREST_CLIENT_SECRET", reason: "must be the app secret from the Pinterest developer portal" });
  }

  if (!(clientId && clientSecret && valid(clientId, ID_MAX) && valid(clientSecret, SECRET_MAX))) {
    return { config: null, issues };
  }
  return { config: { clientId, clientSecret }, issues };
}

/** Reads process.env each call. Throws a value-free error when not configured. */
export function requirePinterestConfig(): PinterestConfig {
  const { config } = parsePinterestEnv(process.env);
  if (!config) throw new Error("Pinterest is not configured: set PINTEREST_CLIENT_ID and PINTEREST_CLIENT_SECRET");
  return config;
}

/** Whether both Pinterest env vars are set and valid. Reads process.env each call. */
export function configured(source: Source = process.env): boolean {
  return parsePinterestEnv(source).config !== null;
}
