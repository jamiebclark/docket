import type { z } from "zod";
import type { ProjectScope } from "../../../dal/scope";

export interface SourceItem {
  /** Template fields, keyed by the declared field name exactly as declared. Values are text. */
  fields: Record<string, string>;
  /** Reserved for this item inside the creation transaction (research D15). */
  mediaAssetId: string | null;
  /** Shown in the items table: "sunset.jpg" or "Row 12: Blue mug". At most 200 characters. */
  label: string;
}

export interface PreparedSource {
  fields: string[];
  items: SourceItem[];
  summary: string;
  meta: Record<string, unknown>;
  excluded: { reason: "already_used" | "deleted"; count: number }[];
  /** The fixed brief sent to the generator for every item of this source. */
  brief: string;
  /** How `createJob` treats reserved and used images. Default: skip reserved, skip used unless the caller included them. */
  mediaRules?: { onReserved: "skip" | "refuse"; skipUsed: boolean };
}

export interface ItemSource<I> {
  readonly kind: string;
  /** The fixed brief sent to the generator for every item of this source. */
  readonly brief: string;
  readonly inputSchema: z.ZodType<I>;
  /** Validates input and resolves candidates. Runs outside any transaction. Throws ValidationIssuesError for bad input. */
  prepare(scope: ProjectScope, input: I, ctx: { file?: { name: string; bytes: Buffer } }): Promise<PreparedSource>;
}
