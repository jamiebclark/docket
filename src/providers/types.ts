import type { z } from "zod";

export type PostType = "text" | "image" | "carousel" | "video" | "story" | "reel";
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

export type VideoContainer = "mp4" | "mov";

/** Shapes of post that may be published as more than one post type. Closed; reused by later providers. */
export type PostShape = "single_video";

export interface PostTypeOption {
  type: PostType;
  /** Shown as is: "Feed video". */
  label: string;
  /** One line, shown under the option and in the summary. */
  description: string;
}

export interface PostTypeChoice {
  shape: PostShape;
  /** At least 2. */
  options: readonly PostTypeOption[];
  /** One of `options`. */
  default: PostType;
}

export type VideoLimitOverrides = Partial<Omit<VideoCapabilities, "byPostType">> & {
  /** Plain sentences shown in the summary for this type. */
  notes?: readonly string[];
};

export interface VideoCapabilities {
  /** 0 = this provider does not accept video (yet). */
  maxVideos: number;
  /** A video may share a post with images. Default false. */
  withImages?: boolean;
  containers?: readonly VideoContainer[];
  /** ffprobe codec names, e.g. "h264". */
  videoCodecs?: readonly string[];
  audioCodecs?: readonly string[];
  /** A video with no audio stream is accepted. Default true. */
  silentAllowed?: boolean;
  maxBytes?: number;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  /** width ÷ height of the displayed frame, inclusive. */
  minAspectRatio?: number;
  maxAspectRatio?: number;
  maxFrameRate?: number;
  /** Lowest frame rate, inclusive. A video whose frame rate is unknown is not refused on it. */
  minFrameRate?: number;
  /** Limits for one post type, merged over this block by `videoLimitsFor`. */
  byPostType?: Partial<Record<PostType, VideoLimitOverrides>>;
}

export interface VideoFacts {
  container: VideoContainer;
  durationSeconds: number;
  frameRate: number | null;
  videoCodec: string;
  audioCodec: string | null;
}

export interface ProviderCapabilities {
  text: {
    maxLength: number;
    countingRule: TextCountingRule;
    /** Most hashtags a caption may carry, counted per occurrence (FR-012). Absent = no cap. */
    maxHashtags?: number;
    /** Most @mentions a caption may carry, counted per occurrence (FR-012). Absent = no cap. */
    maxMentions?: number;
  };
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
  video: VideoCapabilities;
  /** e.g. Instagram: false */
  textOnlyAllowed: boolean;
  postTypes: readonly PostType[];
  /** Shapes of post that may be published as more than one post type. */
  postTypeChoices?: readonly PostTypeChoice[];
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
  /** How many of the media are videos. Absent = none. */
  videoCount?: number;
  /** Kind of each item in post order. Absent = all images (callers before 019). */
  kinds?: readonly ("image" | "video")[];
  /** The target's resolved post type. Absent = inferred with no choice. */
  postType?: PostType;
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
  /** `message` is shown to the user as written, on the paste form and in the accounts banner (G18): plain text, secrets scrubbed, at most 500 characters. */
  | { ok: false; message: string };

export interface OAuthConnectGroup {
  /** `[a-z0-9-]+`, unique among groups. Stored in `connect_attempts.group_key`. */
  key: string;
  /** "Facebook Pages and Instagram". Used in "Connect <displayName>". */
  displayName: string;
  /** Published setup guide linked when the group is not configured, e.g. `docsUrl("meta-setup")`. */
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
    /** Published doc URL (usually `docsUrl(page, anchor)`) linked beside the reason. */
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
    /** The attempt's raw state, already validated, bound to this user and session, and consumed (G17). For per-attempt derivations such as a PKCE verifier; never store or echo it. */
    state: string;
    now: Date;
    signal: AbortSignal;
  }): Promise<CandidatesResult>;
  /** Maps the callback's error query (e.g. a cancelled login) to a plain message, shown in the accounts banner (G18). Write it yourself; never echo the query's text, which anyone can put in a link. */
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
  /** Absent = image. */
  kind?: "image" | "video";
  /** Absent = ready. */
  status?: "processing" | "ready" | "failed";
  /** Set when failed. */
  failureReason?: string;
  /** Set on ready videos. */
  video?: VideoFacts;
}

export interface PostContent {
  text: string;
  media: readonly MediaItem[];
  /** The target's resolved post type. Absent = `resolvePostType(caps, media, null)`. */
  postType?: PostType;
}

export interface ValidationIssue {
  /** "info" never blocks. */
  severity: "error" | "warning" | "info";
  code:
    | "text_too_long"
    | "too_many_hashtags"
    | "too_many_mentions"
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
    | "video_not_accepted"
    | "too_many_videos"
    | "video_with_images"
    | "video_container_not_allowed"
    | "video_codec_not_allowed"
    | "audio_codec_not_allowed"
    | "audio_required"
    | "video_too_large"
    | "video_too_short"
    | "video_too_long"
    | "video_too_small"
    | "video_too_big"
    | "video_aspect_out_of_range"
    | "video_frame_rate_too_high"
    | "video_frame_rate_too_low"
    | "too_many_items"
    | "media_processing"
    | "media_failed"
    | (string & {});
  message: string;
  field: "text" | "media" | "postType" | `media.${number}`;
  count?: number;
  limit?: number;
}

export interface CreationAllowance {
  /** At least 11. */
  count: number;
  /** At most 604_800. */
  windowSeconds: number;
  /** "Instagram's daily container allowance", used in the wait message. */
  name: string;
}

export interface StepInfo {
  name: string;
  mayPublish: boolean;
  /** Units of the provider's creation allowance this lease reserves. Requires `creationAllowance`. */
  allowance?: { units: number; retryUnits: number };
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
  /** One limit, or several that all apply (the strictest wins per window). Read through `providerPublishLimits`. */
  defaultPublishLimit?: PublishLimit | readonly PublishLimit[];
  /** A rolling allowance on creating containers, reserved when a step is leased. */
  creationAllowance?: CreationAllowance;
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
