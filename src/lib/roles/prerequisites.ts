import type { ChecklistItem } from "@/components/ui/Checklist";
import { docsUrl } from "@/lib/docs";
import type { GenerationReadiness } from "@/server/services/generation/readiness";
import { askManagers, askOwners, type Manager } from "./names";

export const PREREQUISITES_TITLE = "Before you can generate";

/** The setup list shown in place of the generate form; `null` when every prerequisite is done. */
export function generationPrerequisites(input: {
  slug: string;
  readiness: GenerationReadiness;
  viewer: { isOwner: boolean; canManageAccounts: boolean; canManageVoice: boolean };
  managers: readonly Manager[];
  /** New job from media only: present when the selection has no usable images. */
  images?: { message: string } | null;
}): ChecklistItem[] | null {
  const { slug, readiness, viewer, managers, images } = input;
  const base = `/p/${slug}`;
  const ask = askManagers(managers, "and");
  const items: ChecklistItem[] = [];

  const aiDone = readiness.ai.configured;
  items.push({
    key: "ai",
    title: "Set up AI generation",
    description: aiDone
      ? "The server has an AI provider."
      : readiness.ai.missingSettings
        ? `Set ${readiness.ai.missingSettings.join(", ")} on the server, then reload this page.`
        : "The server needs an AI provider before posts can be generated.",
    status: aiDone
      ? { kind: "done" }
      : viewer.isOwner
        ? { kind: "todo" }
        : { kind: "waiting", on: askOwners(managers, "and") },
    action:
      !aiDone && viewer.isOwner
        ? { label: "Open the setup guide", href: docsUrl("generator", "configuring-a-provider") }
        : null,
  });

  const accountDone = readiness.accounts >= 1;
  items.push({
    key: "account",
    title: "Connect an account",
    description: "Generated posts are written for a connected account.",
    status: accountDone
      ? { kind: "done" }
      : viewer.canManageAccounts
        ? { kind: "todo" }
        : { kind: "waiting", on: ask },
    action:
      !accountDone && viewer.canManageAccounts
        ? { label: "Connect an account", href: `${base}/accounts#add-account` }
        : null,
  });

  const voiceDone = readiness.voiceProfiles >= 1;
  items.push({
    key: "voice",
    title: "Create a voice profile",
    description: "Teaches the generator how your posts sound.",
    status: voiceDone
      ? { kind: "done" }
      : viewer.canManageVoice
        ? { kind: "todo" }
        : { kind: "waiting", on: ask },
    action:
      !voiceDone && viewer.canManageVoice ? { label: "Create a voice profile", href: `${base}/voice/new` } : null,
  });

  if (images) {
    items.push({
      key: "images",
      title: "Images to generate for",
      description: images.message,
      status: { kind: "todo" },
      action: { label: "Back to Media", href: `${base}/media` },
    });
  }

  return items.every((i) => i.status.kind === "done") ? null : items;
}
