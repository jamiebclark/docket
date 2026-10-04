import { Agent } from "@atproto/api";

/** A plain agent: no `CredentialSession`, so nothing refreshes or replays a request behind the engine's back. */
export function agentFor(pdsUrl: string, accessJwt?: string): Agent {
  return new Agent({
    service: pdsUrl,
    headers: accessJwt ? { authorization: `Bearer ${accessJwt}` } : {},
    fetch: (input, init) => globalThis.fetch(input, init),
  });
}
