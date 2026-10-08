/** The hostname of the account's PDS from a DID document's `#atproto_pds` service (contract §3, P4), or `null`. */
export function pdsHostOf(didDoc: unknown): string | null {
  if (!didDoc || typeof didDoc !== "object") return null;
  const services = (didDoc as { service?: unknown }).service;
  if (!Array.isArray(services)) return null;
  for (const entry of services) {
    if (!entry || typeof entry !== "object") continue;
    const { id, type, serviceEndpoint } = entry as { id?: unknown; type?: unknown; serviceEndpoint?: unknown };
    if (typeof id !== "string" || !(id === "#atproto_pds" || id.endsWith("#atproto_pds"))) continue;
    if (type !== "AtprotoPersonalDataServer" || typeof serviceEndpoint !== "string") continue;
    try {
      const url = new URL(serviceEndpoint);
      if (url.protocol !== "https:") continue;
      const host = url.hostname.toLowerCase();
      if (/^[a-z0-9.-]{1,253}$/.test(host)) return host;
    } catch {
      continue;
    }
  }
  return null;
}
