// Stub (T002): filled in by the Foundational phase. See contracts/meta.md.
export const DEFAULT_GRAPH_VERSION = "v26.0";
export const GRAPH_VERSION_PATTERN = /^v\d{1,3}\.\d{1,2}$/;

export interface MetaConfig {
  appId: string;
  appSecret: string;
  graphVersion: string;
  loginConfigId: string | null;
}

function notImplemented(name: string): never {
  throw new Error(`${name} is not implemented yet`);
}

export function requireMetaConfig(): MetaConfig {
  return notImplemented("requireMetaConfig");
}

export function graphVersion(): string {
  return notImplemented("graphVersion");
}
