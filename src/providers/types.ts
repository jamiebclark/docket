import type { z } from "zod";

export type PostType = "text" | "image" | "carousel" | "video" | "story" | "reel"; // only the first three are used now
export type TextCountingRule = "graphemes" | "code_points" | "utf8_bytes";

export interface ProviderCapabilities {
  text: { maxLength: number; countingRule: TextCountingRule };
  media: {
    /** 0 = no images */
    maxImages: number;
    allowedMimeTypes: readonly string[];
    maxBytesPerFile: number;
    /** e.g. Instagram: true */
    required: boolean;
    /** Converted to when an image's type is not allowed. Default: allowedMimeTypes[0]. */
    outputMimeType?: string;
    minWidth?: number;
    maxWidth?: number;
    minHeight?: number;
    maxHeight?: number;
    /** width ÷ height, inclusive. */
    minAspectRatio?: number;
    maxAspectRatio?: number;
    maxAltTextLength?: number;
  };
  /** e.g. Instagram: false */
  textOnlyAllowed: boolean;
  postTypes: readonly PostType[];
}

export interface PublishLimit {
  count: number;
  windowSeconds: number;
}

export interface CredentialField {
  name: string;
  label: string;
  secret: boolean;
  help?: string;
}

export type ConnectStrategy =
  | { strategy: "oauth" }
  | { strategy: "credentials"; fields: readonly CredentialField[] }
  | { strategy: "manual-token"; fields: readonly CredentialField[] };

export interface MediaItem {
  url: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  bytes: number;
  altText: string;
}

export interface PostContent {
  text: string;
  media: readonly MediaItem[];
}

export interface ValidationIssue {
  /** "info" never blocks. */
  severity: "error" | "warning" | "info";
  code:
    | "text_too_long"
    | "too_many_images"
    | "mime_not_allowed"
    | "file_too_large"
    | "media_required"
    | "text_only_not_allowed"
    | "unsupported_post_type"
    | "missing_alt_text"
    | "empty_post"
    | "media_will_convert"
    | "media_will_downscale"
    | "media_will_compress"
    | "aspect_ratio_out_of_range"
    | "image_too_small"
    | "variant_failed"
    | "alt_text_too_long"
    | "media_unavailable"
    | (string & {});
  message: string;
  field: "text" | "media" | "postType" | `media.${number}`;
  count?: number;
  limit?: number;
}

export interface StepInfo {
  name: string;
  mayPublish: boolean;
}

export interface PublishContext {
  /** `attempt` = attempt_count + 1 */
  target: { id: string; scheduledAt: Date; attempt: number };
  account: {
    id: string;
    externalId: string;
    displayName: string;
    /** Already parsed by `provider.settingsSchema`. */
    settings: unknown;
    /** Decrypted object, or null when none stored. */
    credentials: unknown | null;
  };
  content: PostContent;
  postType: PostType;
  /** Null on the first step. */
  state: unknown | null;
  /** The engine clock (DB time). */
  now: Date;
  /** Aborted at the provider-call timeout; pass it to fetch. */
  signal: AbortSignal;
}

export interface AttemptSummary {
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
}

export type StepResult = (
  | { kind: "continue"; state: unknown; notBefore?: Date }
  | { kind: "done"; externalId: string; url?: string }
  | { kind: "retryable_error"; error: string; notBefore?: Date }
  | { kind: "fatal_error"; error: string }
  | { kind: "ambiguous"; error: string }
) & { summary?: AttemptSummary };

export type RefreshResult =
  | { ok: true; credentials: unknown; expiresAt: Date | null }
  | { ok: false; reason: string };

export interface SocialProvider<Settings = unknown, State = unknown> {
  /** Lowercase `[a-z0-9-]+`, unique, stored in `social_accounts.provider_key`. */
  key: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  defaultPublishLimit?: PublishLimit;
  connect: ConnectStrategy;
  /** Non-secret per-account settings; `z.object({})` if none. */
  settingsSchema: z.ZodType<Settings>;
  refreshCredentials?(input: {
    account: { id: string; externalId: string; settings: Settings };
    credentials: unknown;
    now: Date;
    signal: AbortSignal;
  }): Promise<RefreshResult>;
  validate(content: PostContent, capabilities: ProviderCapabilities): ValidationIssue[];
  /** Pure and total. `settings` is the account's parsed settings (a step can depend on them). */
  stepFor(state: State | null, settings: Settings): StepInfo;
  advance(ctx: PublishContext): Promise<StepResult>;
}
