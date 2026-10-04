import type { RefreshResult } from "../types";

// Stub (T002): implemented in a later task.
export async function refreshThreads(_input: unknown): Promise<RefreshResult> {
  throw new Error("not implemented");
}

export function threadsAccountNotes(_input: { settings: unknown; credentialsExpireAt: Date | null }): string[] {
  throw new Error("not implemented");
}
