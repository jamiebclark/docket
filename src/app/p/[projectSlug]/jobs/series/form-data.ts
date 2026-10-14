// Server-side data for StandingSeriesForm, mirroring jobs/new/form-data.ts.
import { findProvider } from "@/providers/registry";
import type { ProjectScope } from "@/server/dal";
import * as accounts from "@/server/services/accounts";
import type { AccountOption } from "../../generate/generate-logic";
import type { VoiceOption } from "../../generate/GenerateForm";

export interface StandingSeriesFormData {
  profiles: VoiceOption[];
  accounts: AccountOption[];
  defaults: { approval: ProjectScope["project"]["defaultApprovalPolicy"]; scheduling: ProjectScope["project"]["defaultSchedulingPolicy"] };
  canAutoApprove: boolean;
  timezone: string;
  mediaTags: string[];
}

export async function loadStandingSeriesFormData(scope: ProjectScope): Promise<StandingSeriesFormData> {
  const [profiles, list, mediaTags] = await Promise.all([scope.voiceProfiles.list(), accounts.listAccounts(scope), scope.media.listTags()]);
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
        postingInstructions: a.postingInstructions,
      };
    }),
    defaults: { approval: scope.project.defaultApprovalPolicy, scheduling: scope.project.defaultSchedulingPolicy },
    canAutoApprove: scope.can({ generation: ["auto_approve"] }),
    timezone: scope.project.timezone,
    mediaTags,
  };
}
