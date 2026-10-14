import type { ApiKeyPermission } from "@/server/dal/api-keys";
import type { AnyApiOperation, McpConfirm } from "@/server/api/operations/types";

/** Derived, never stored (data-model.md §3). Exactly one tool per exposed operation. */
export interface McpTool {
  /** `docket_` + snake_case operation id (frozen; FR-004). */
  name: string;
  /** The operation's own `summary`. */
  title: string;
  /** Generated, four required parts (data-model.md §5). */
  description: string;
  /** Self-contained JSON Schema, no `$ref`/`$defs` (research D7). */
  inputSchema: Record<string, unknown>;
  /** The operation this tool is the only tool for. */
  operation: AnyApiOperation;
  /** Non-null for every tool: `getOpenApi` is withheld. */
  permission: ApiKeyPermission;
  confirm?: McpConfirm;
}
