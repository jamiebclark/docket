/** Who made an attempt entry: pure, so client and server code can share the label. */
export type AttemptActor =
  | { kind: "api_key"; name: string | null }
  | { kind: "member"; name: string }
  | { kind: "system" };

export function attemptActorLabel(actor: AttemptActor): string {
  switch (actor.kind) {
    case "api_key":
      return actor.name === null ? "Removed API key" : `API key ${actor.name}`;
    case "member":
      return actor.name;
    case "system":
      return "System";
  }
}
