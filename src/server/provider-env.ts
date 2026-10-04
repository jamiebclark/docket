import { listConnectGroups, findConnectGroup } from "../providers/registry";
import type { EnvIssue } from "./env";

type Source = Record<string, string | undefined>;

/** Every connect group's environment issues (names and reasons only, never values), de-duplicated. */
export function providerEnvIssues(source: Source): EnvIssue[] {
  const seen = new Set<string>();
  const out: EnvIssue[] = [];
  for (const { group } of listConnectGroups()) {
    for (const issue of group.environment.issues(source)) {
      const key = `${issue.name}\u0000${issue.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: issue.name, reason: issue.reason });
    }
  }
  return out;
}

/** True when the group exists and its environment is complete. */
export function isGroupConfigured(groupKey: string, source: Source = process.env): boolean {
  return findConnectGroup(groupKey)?.group.environment.configured(source) ?? false;
}
