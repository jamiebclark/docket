import { AccountPostingInstructionsSchema, AccountSchema, SetPostingInstructionsRequestSchema } from "@/lib/api/schemas";
import { z } from "zod";
import { listAccountsForApi, setPostingInstructions } from "../../services/accounts";
import { standardErrors } from "./errors-doc";
import { defineOperation } from "./types";

const accountParams = z.object({ accountId: z.uuid() });

export const accountOperations = [
  defineOperation({
    id: "listAccounts",
    method: "GET",
    path: "/accounts",
    permission: "read",
    tag: "Accounts",
    summary: "List the project's connected accounts",
    description: "Each account carries its provider's capabilities: text limit, counting rule, media rules and post types.",
    responses: {
      200: {
        description: "The accounts",
        schema: z.object({ data: z.array(AccountSchema), nextCursor: z.null() }),
      },
    },
    idempotent: false,
    async run(scope) {
      return { status: 200, body: { data: await listAccountsForApi(scope), nextCursor: null } };
    },
  }),
  defineOperation({
    id: "setAccountPostingInstructions",
    method: "PATCH",
    path: "/accounts/{accountId}",
    permission: "manage_setup",
    tag: "Accounts",
    summary: "Set an account's posting instructions",
    description:
      "Sets the account's per-account writing rules, audited exactly as the UI edit is. An empty string clears them. Requires the `manage_setup` permission.",
    params: accountParams,
    body: {
      kind: "json",
      schema: SetPostingInstructionsRequestSchema,
      examples: { set: { summary: "Set instructions", value: { instructions: "Two hashtags max. Never link out." } } },
    },
    resourceParams: ["accountId"],
    responses: {
      200: {
        description: "The account's posting instructions",
        schema: AccountPostingInstructionsSchema,
        examples: {
          set: {
            summary: "Set",
            value: { accountId: "7c1e2f43-9b0d-4a77-8e55-2a3d4c5b6e71", postingInstructions: "Two hashtags max. Never link out.", changed: true },
          },
        },
      },
      ...standardErrors("manage_setup"),
    },
    idempotent: true,
    async run(scope, { params, body }) {
      const { changed, instructions } = await setPostingInstructions(scope, params.accountId, body);
      return { status: 200, body: { accountId: params.accountId, postingInstructions: instructions, changed } };
    },
  }),
];
