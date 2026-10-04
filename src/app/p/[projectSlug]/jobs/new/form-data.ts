// Server-side data both job pages hand to the shared JobForm.
import { findProvider } from "@/providers/registry";
import type { ProjectScope } from "@/server/dal";
import * as accounts from "@/server/services/accounts";
import type { AccountOption } from "../../generate/generate-logic";
import type { VoiceOption } from "../../generate/GenerateForm";

export interface JobFormData {
  profiles: VoiceOption[];
  accounts: AccountOption[];
  defaults: { approval: ProjectScope["project"]["defaultApprovalPolicy"]; scheduling: ProjectScope["project"]["defaultSchedulingPolicy"] };
  canAutoApprove: boolean;
}

export async function loadJobFormData(scope: ProjectScope): Promise<JobFormData> {
  const [profiles, list] = await Promise.all([scope.voiceProfiles.list(), accounts.listAccounts(scope)]);
  const defaultId = scope.project.defaultVoiceProfileId;
  return {
    profiles: profiles.map((p) => ({ id: p.id, name: p.name, isDefault: p.id === defaultId })),
    accounts: list.map((a) => {
      const caps = findProvider(a.providerKey)?.capabilities;
      return {
        id: a.id,
        displayName: a.displayName,
        providerKey: a.providerKey,
        providerName: a.providerName,
        status: a.status,
        providerAvailable: a.providerAvailable,
        maxImages: caps?.media.maxImages ?? 0,
        mediaRequired: caps?.media.required ?? false,
      };
    }),
    defaults: { approval: scope.project.defaultApprovalPolicy, scheduling: scope.project.defaultSchedulingPolicy },
    canAutoApprove: scope.can({ generation: ["auto_approve"] }),
  };
}
