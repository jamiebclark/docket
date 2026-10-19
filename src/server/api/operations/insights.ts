import { ApiInsightsQuerySchema, ApiInsightsResponseSchema } from "@/lib/api/schemas";
import { getInsightsForApi } from "../../services/insights/view";
import { defineOperation } from "./types";

export const insightsOperations = [
  defineOperation({
    id: "getInsights",
    method: "GET",
    path: "/insights",
    permission: "read",
    tag: "Insights",
    summary: "Account trends and performance comparisons",
    description:
      "The same account trends, comparisons and first-engagement figures the Insights screen shows, for a calendar-day " +
      "range in the project time zone (default: the 30 days ending today). A comparison the screen would decline to " +
      "rank returns `conclusion: \"not_enough_posts\"` and its groups in label order — never a ranking. No credential, " +
      "token, or raw provider payload ever appears in the response.",
    query: ApiInsightsQuerySchema,
    responses: {
      200: { description: "Trends, comparisons and first-engagement figures for the range", schema: ApiInsightsResponseSchema },
      400: { description: "An unknown parameter, a bad date, `from` after `to`, or a `metricKey` no connected platform declares; `details` lists each field" },
      401: { description: "Missing or invalid API key" },
      403: { description: "The key lacks `read`" },
    },
    idempotent: false,
    mcp: { expose: true },
    async run(scope, { query }) {
      return { status: 200, body: await getInsightsForApi(scope, query) };
    },
  }),
];
