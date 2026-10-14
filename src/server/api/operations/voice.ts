import { CreateVoiceProfileRequestSchema, UpdateVoiceProfileRequestSchema, VoiceProfileRefSchema } from "@/lib/api/schemas";
import { z } from "zod";
import { createVoiceProfile, saveVoiceProfile } from "../../services/voice";
import { standardErrors } from "./errors-doc";
import { defineOperation } from "./types";

const example = {
  id: "3a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d",
  name: "House voice",
  content: { voiceAndTone: "Warm, a little playful, never salesy." },
};

const voiceProfileParams = z.object({ profileId: z.uuid() });

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
    mcp: { expose: true },
    async run(scope, { body }) {
      const { profileId, version, isDefault } = await createVoiceProfile(scope, body);
      return { status: 201, body: { id: profileId, version, isDefault } };
    },
  }),
  defineOperation({
    id: "updateVoiceProfile",
    method: "PATCH",
    path: "/voice-profiles/{profileId}",
    permission: "manage_setup",
    tag: "Voice",
    summary: "Update a voice profile",
    description:
      "Appends a new version of the profile's name and content, protected by optimistic concurrency: `baseVersion` must match the profile's current version. Requires the `manage_setup` permission.",
    params: voiceProfileParams,
    body: {
      kind: "json",
      schema: UpdateVoiceProfileRequestSchema,
      examples: {
        update: {
          summary: "Update a voice profile",
          value: { name: example.name, content: example.content, baseVersion: 1 },
        },
      },
    },
    resourceParams: ["profileId"],
    responses: {
      200: {
        description: "The profile's current version after the update",
        schema: VoiceProfileRefSchema,
        examples: { updated: { summary: "Updated", value: { id: example.id, version: 2, isDefault: true } } },
      },
      ...standardErrors("manage_setup"),
    },
    idempotent: true,
    mcp: { expose: true },
    async run(scope, { params, body }) {
      const { version, isDefault } = await saveVoiceProfile(scope, params.profileId, body);
      return { status: 200, body: { id: params.profileId, version, isDefault } };
    },
  }),
];
