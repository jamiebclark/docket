import type { BlueskyState } from "./settings";

export function stepForContent(_state: BlueskyState, _content: { text: string; mediaCount: number }): string {
  throw new Error("not implemented");
}

export function mentionHandles(_text: string): string[] {
  throw new Error("not implemented");
}
