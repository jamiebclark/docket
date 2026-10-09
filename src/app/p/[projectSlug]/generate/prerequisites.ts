import type { ChecklistItem } from "@/components/ui/Checklist";
import { generationPrerequisites } from "@/lib/roles/prerequisites";
import type { ProjectScope } from "@/server/dal/scope";
import { getGenerationReadiness } from "@/server/services/generation/readiness";
import { listManagers } from "@/server/services/members";

/** The setup list for this viewer, or `null` when generation is ready. Names are read only when something is missing. */
export async function loadPrerequisites(
  scope: ProjectScope,
  slug: string,
  images?: { message: string } | null,
): Promise<ChecklistItem[] | null> {
  const readiness = await getGenerationReadiness(scope);
  const complete = readiness.ai.configured && readiness.accounts >= 1 && readiness.voiceProfiles >= 1 && !images;
  if (complete) return null;
  return generationPrerequisites({
    slug,
    readiness,
    viewer: {
      isOwner: scope.membership.role === "owner",
      canManageAccounts: scope.can({ account: ["manage"] }),
      canManageVoice: scope.can({ voice: ["manage"] }),
    },
    managers: await listManagers(scope),
    images,
  });
}
