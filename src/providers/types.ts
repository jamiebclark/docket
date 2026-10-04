import type { z } from "zod";

export type PostType = "text" | "image" | "carousel" | "video" | "story" | "reel"; // only the first three are used now
export type BuiltInCountingRule = "graphemes" | "code_points" | "utf8_bytes";
export interface CustomCountingRule {
  kind: "custom";
  /** `[a-z0-9-]+`, shown as `TargetCheck.countingRule`. */
  name: string;
  /** Plural unit for messages: "Text is 501 characters; the limit is 500." */
  unit: string;
  /** Pure and total; never throws; returns a non-negative integer. */
  count(text: string): number;
}
export type TextCountingRule = BuiltInCountingRule | CustomCountingRule;

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
  /** Default false (required). */
  optional?: boolean;
  /** Used when the submitted value is empty. Requires `optional`; never on a secret field. */
  defaultValue?: string;
  placeholder?: string;
}

export type ConnectResult =
  | {
      ok: true;
      account: {
        externalId: string;
        displayName: string;
        settings: unknown;
        credentials: unknown;
        expiresAt: Date | null;
      };
    }
  | { ok: false; message: string; field?: string; retryAt?: Date };

/** What `stepFor` may look at. */
export interface StepContent {
  text: string;
  mediaCount: number;
}

export interface ProviderEnvIssue {
  name: string;
  /** Never carries a value. */
  reason: string;
}

export interface ConnectCandidate {
  providerKey: string;
  externalId: string;
  displayName: string;
  settings: unknown;
  credentials: unknown;
  expiresAt: Date | null;
  /** Shown nested under this candidate in the chooser (e.g. Instagram under its Page). */
  parent?: { providerKey: string; externalId: string };
  notes?: readonly string[];
}

export type CandidatesResult =
  | { ok: true; candidates: readonly ConnectCandidate[]; notices?: readonly string[] }
  | { ok: false; message: string };

export interface OAuthConnectGroup {
  /** `[a-z0-9-]+`, unique among groups. Stored in `connect_attempts.group_key`. */
  key: string;
  /** "Facebook Pages and Instagram". Used in "Connect <displayName>". */
  displayName: string;
  /** Repo-relative doc shown when the group is not configured, e.g. "docs/meta-setup.md". */
  setupDoc?: string;
  /** Pure; reads only `source`. */
  environment: {
    variables: readonly { name: string; secret: boolean; required: boolean }[];
    issues(source: Readonly<Record<string, string | undefined>>): ProviderEnvIssue[];
    configured(source: Readonly<Record<string, string | undefined>>): boolean;
  };
  /** Callback-address requirement; a group whose address does not qualify is shown as unavailable (G10). */
  redirectRequirement?: {
    /** Refuse non-https: callback addresses. */
    https: boolean;
    /** Refuse localhost, *.localhost, IPv4 and IPv6 literals. */
    publicHost: boolean;
    /** Shown as is, e.g. "Threads needs an HTTPS address that is not localhost." */
    reason: string;
    /** Repo-relative doc path with optional #anchor. */
    doc?: string;
  };
  /** Static, non-secret. Appended to the accounts banner after a failed or refused callback for this group (G12). */
  callbackHint?: string;
  /** Pure. The absolute URL of the platform's login dialog. */
  authorizationUrl(input: { state: string; redirectUri: string }): string;
  /** Server-side code exchange → candidates. Must not throw for expected refusals. */
  exchangeCode(input: {
    code: string;
    redirectUri: string;
    now: Date;
    signal: AbortSignal;
  }): Promise<CandidatesResult>;
  /** Maps the callback's error query (e.g. a cancelled login) to a plain message. */
  describeCallbackError?(params: URLSearchParams): { code: "cancelled" | "platform_error"; message: string };
  /** A token generated in the platform's tools → the same candidates. */
  pasteToken?: {
    field: CredentialField; // secret: true
    help: string;
    exchange(input: { token: string; now: Date; signal: AbortSignal }): Promise<CandidatesResult>;
  };
}

export type ConnectStrategy =
  | { strategy: "oauth"; group: OAuthConnectGroup }
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
  /** The step the engine leased. */
  step: StepInfo;
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
  | { kind: "retryable_error"; error: string; notBefore?: Date; credentialsExpired?: boolean }
  | { kind: "fatal_error"; error: string; credentialsInvalid?: true }
  | { kind: "ambiguous"; error: string }
) & { summary?: AttemptSummary };

export type RefreshResult =
  | { ok: true; credentials: unknown; expiresAt: Date | null; displayName?: string }
  | { ok: false; reason: string; transient?: boolean; retryAt?: Date };

export interface SocialProvider<Settings = unknown, State = unknown> {
  /** Lowercase `[a-z0-9-]+`, unique, stored in `social_accounts.provider_key`. */
  key: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  defaultPublishLimit?: PublishLimit;
  connect: ConnectStrategy;
  /** Non-secret per-account settings; `z.object({})` if none. */
  settingsSchema: z.ZodType<Settings>;
  /** Connect by credentials: verify them and return the account. */
  connectAccount?(input: {
    fields: Readonly<Record<string, string>>;
    now: Date;
    signal: AbortSignal;
  }): Promise<ConnectResult>;
  /** True when the credentials should be refreshed before this publish. Requires `refreshCredentials`. */
  needsRefresh?(credentials: unknown, now: Date): boolean;
  refreshCredentials?(input: {
    account: { id: string; externalId: string; settings: Settings };
    credentials: unknown;
    now: Date;
    signal: AbortSignal;
  }): Promise<RefreshResult>;
  validate(content: PostContent, capabilities: ProviderCapabilities): ValidationIssue[];
  /** Pure and total. `settings` is the account's parsed settings (a step can depend on them). */
  stepFor(state: State | null, settings: Settings, content: StepContent): StepInfo;
  advance(ctx: PublishContext): Promise<StepResult>;
  /** Pure. Non-secret notes shown on the account card. Never receives credentials. A throw or a non-array → []. */
  accountNotes?(input: { settings: Settings; credentialsExpireAt: Date | null }): string[];
}
