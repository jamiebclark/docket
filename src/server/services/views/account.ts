import type { ApiAccount } from "@/lib/api/schemas";
import { findProvider } from "@/providers/registry";
import type { AccountRecord } from "../../dal/accounts";

/** The API's account shape. No credentials, settings or tokens (FR-024). */
export function toApiAccount(a: AccountRecord): ApiAccount {
  const caps = findProvider(a.providerKey)?.capabilities;
  const rule = caps?.text.countingRule;
  return {
    id: a.id,
    provider: a.providerKey,
    displayName: a.displayName,
    status: a.status,
    lastError: a.lastError,
    capabilities: {
      textLimit: caps?.text.maxLength ?? 0,
      countingRule: rule === undefined ? "graphemes" : typeof rule === "string" ? rule : rule.name,
      media: {
        required: caps?.media.required ?? false,
        maxImages: caps?.media.maxImages ?? 0,
        mimeTypes: [...(caps?.media.allowedMimeTypes ?? [])],
      },
      postTypes: [...(caps?.postTypes ?? [])],
    },
  };
}
