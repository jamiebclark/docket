import { CreateVoiceProfileRequestSchema, VoiceProfileRefSchema } from "@/lib/api/schemas";
import { createVoiceProfile } from "../../services/voice";
import { standardErrors } from "./errors-doc";
import { defineOperation } from "./types";

const example = {
  id: "3a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d",
  name: "House voice",
  content: { voiceAndTone: "Warm, a little playful, never salesy." },
};

export const voiceOperations = [
  defineOperation({
    id: "createVoiceProfile",
    method: "POST",
    path: "/voice-profiles",
    permission: "manage_setup",
    tag: "Voice",
    summary: "Create a voice profile",
    description:
      "Creates a voice profile at version 1. Requires the `manage_setup` permission. `isDefault` is true when the project had no default profile yet.",
    body: {
      kind: "json",
      schema: CreateVoiceProfileRequestSchema,
      examples: { create: { summary: "Create a voice profile", value: { name: example.name, content: example.content } } },
    },
    responses: {
      201: {
        description: "Created",
        schema: VoiceProfileRefSchema,
        examples: { created: { summary: "Created", value: { id: example.id, version: 1, isDefault: true } } },
      },
      ...standardErrors("manage_setup"),
    },
    idempotent: true,
    async run(scope, { body }) {
      const isDefault = scope.project.defaultVoiceProfileId === null;
      const { profileId, version } = await createVoiceProfile(scope, body);
      return { status: 201, body: { id: profileId, version, isDefault } };
    },
  }),
];
