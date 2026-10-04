import { AccountSchema } from "@/lib/api/schemas";
import { z } from "zod";
import { listAccountsForApi } from "../../services/accounts";
import { defineOperation } from "./types";

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
];
