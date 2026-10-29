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
export type PostShape = "single_image" | "single_video";

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
  /** Bits per second, decimal (25 Mbps = 25_000_000). */
  maxVideoBitrate?: number;
  /** Bits per second to encode audio at; not a refusal limit. Default 128_000 when re-encoding. */
  audioBitrate?: number;
  /** Hz. Default 48_000 when re-encoding. */
  maxAudioSampleRate?: number;
  /** Default 2 when re-encoding. */
  maxAudioChannels?: number;
  /** width ÷ height; the shape used when reframing. Must lie inside the merged aspect range. */
  recommendedAspectRatio?: number;
  /** The file's index (moov) must precede the media data. */
  indexAtFront?: boolean;
  /** Limits for one post type, merged over this block by `videoLimitsFor`. */
  byPostType?: Partial<Record<PostType, VideoLimitOverrides>>;
}

export interface VideoFacts {
  container: VideoContainer;
  durationSeconds: number;
  frameRate: number | null;
  videoCodec: string;
  audioCodec: string | null;
  /** The facts below are absent on items built by older code paths; the planner treats absent as unknown. */
  videoBitrate?: number | null;
  audioBitrate?: number | null;
  audioSampleRate?: number | null;
  audioChannels?: number | null;
  indexAtFront?: boolean | null;
  /** 1 = recorded before the formatter (a rescan is pending); 2 = current. */
  factsVersion?: 1 | 2;
  /** Three rescans failed; the planner refuses. */
  factsUnreadable?: boolean;
}

export type ImageLimitOverrides = {
  /** `null` removes the bound for this post type. */
  minAspectRatio?: number | null;
  maxAspectRatio?: number | null;
  /** width ÷ height; the shape the platform recommends. Notice only - Docket never reshapes an image. */
  recommendedAspectRatio?: number;
  /** Plain sentences shown in the requirements summary for this type. */
  notes?: readonly string[];
};

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
    /** Limits for one post type, merged over this block by `imageLimitsFor`. */
    byPostType?: Partial<Record<PostType, ImageLimitOverrides>>;
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
  /**
   * On a *reconnect*, prefill this field from the connected account rather than leaving it blank,
   * so nobody retypes what Docket already knows. The provider names the source, because only it
   * knows what its display name means — Bluesky's is the handle, and a provider whose display name
   * is a person's name must not set this.
   *
   * **Never on a secret field.** A stored secret exists so the server can reauthenticate itself;
   * rendering one into a form would send it back to the browser on every page view.
   * `tests/lint/no-prefilled-secrets.test.ts` enforces that.
   */
  prefillOnReconnect?: "displayName";
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
  /** Permission identifiers the platform reported granting (G31). Absent = not reported. */
  grantedScopes?: readonly string[];
}

export type CandidatesResult =
  | { ok: true; candidates: readonly ConnectCandidate[]; notices?: readonly string[] }
  /** `message` is shown to the user as written, on the paste form and in the accounts banner (G18): plain text, secrets scrubbed, at most 500 characters. */
  | { ok: false; message: string };

/** G40. Docket's own read surfaces an opt-in scope can belong to. Never a platform name. */
export type ScopeSurface = "insights" | "engagement";

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
  /**
   * G39. The scopes this group's dialog asks for every time, before any opt-in. Declared so a
   * surface can tell "the dialog will ask for this, so reconnecting helps" from "the dialog never
   * asks for this, so it cannot". Omit it and nothing is assumed to be requested — which is the
   * safe default, since an undeclared group makes no promise about what its dialog carries.
   */
  baseScopes?: readonly string[];
  /** G32. The extra permissions this group may request, and whether it is asking for them now. */
  optionalScopes?: {
    /** Every extra scope, each with the purpose it serves. Static, non-secret, shown in docs. */
    declared: readonly { scope: string; purpose: string }[];
    /** Published guide explaining the opt-in, e.g. `docsUrl("meta-setup", "insights")`. */
    doc?: string;
    /** Pure; reads only `source`. The scopes this group will add to its dialog as configured now. */
    requested(source: Readonly<Record<string, string | undefined>>): readonly string[];
    /**
     * Pure. Non-null when the operator opted in but Docket cannot widen the dialog — Facebook
     * Login for Business takes its permission set from the Meta app's configuration (FR-019).
     * Reconnecting cannot help, so no reconnect control is offered.
     */
    cannotWiden?(
      source: Readonly<Record<string, string | undefined>>,
      surface: ScopeSurface,
    ): { reason: string; doc?: string } | null;
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
    /** A fresh copy of the callback's query (G28). Never echo it. */
    callbackParams?: URLSearchParams;
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
  /** The target's posting values and account details (G25). Absent for a provider without `posting`. */
  posting?: { values: unknown | null; details: unknown | null };
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
    | "video_facts_unreadable"
    | "video_checking"
    | "video_will_cut"
    | "video_will_crop"
    | "video_will_pad"
    | "video_will_resize"
    | "video_will_change_frame_rate"
    | "video_will_reencode"
    | "video_will_rewrap"
    | "too_many_items"
    | "media_processing"
    | "media_failed"
    | "story_text_dropped"
    | "story_alt_text_dropped"
    | "story_will_crop"
    | (string & {});
  message: string;
  field: "text" | "media" | "postType" | "consent" | `media.${number}` | "posting" | `posting.${string}`;
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
  /**
   * A step that may publish has already been sent for this target. Requires `mayPublish: false`.
   * The engine never fails such a lease on its own: an outcome it would record as failed is ambiguous.
   * A provider's own `fatal_error` still fails.
   */
  afterPublish?: true;
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
  | { kind: "continue"; state: unknown; notBefore?: Date; /** Shown as the target's status until the next result (G24). */ wait?: string }
  | { kind: "done"; externalId: string; url?: string; publicPostId?: string }
  | { kind: "retryable_error"; error: string; notBefore?: Date; credentialsExpired?: boolean }
  | { kind: "fatal_error"; error: string; credentialsInvalid?: true }
  /** `credentialsInvalid`: the platform rejected the credentials; the account is flagged, and the target stays ambiguous. */
  | { kind: "ambiguous"; error: string; credentialsInvalid?: true }
) & { summary?: AttemptSummary };

export type RefreshResult =
  | {
      ok: true;
      credentials: unknown;
      expiresAt: Date | null;
      displayName?: string;
      /** G31. Absent leaves the stored grant unchanged (FR-011). */
      grantedScopes?: readonly string[];
    }
  | { ok: false; reason: string; transient?: boolean; retryAt?: Date };

export interface PostingOptionView {
  value: string;
  label: string;
  disabled?: { reason: string };
}

export type PostingFieldView = {
  /** `[a-z][a-zA-Z0-9]*`, unique; issues use `posting.<key>`. */
  key: string;
  label: string;
  help?: string;
  disabled?: { reason: string };
} & (
  | {
      kind: "choice";
      value: string | null;
      options: PostingOptionView[];
      required: boolean;
      placeholder: string;
      /**
       * When set, choosing an option also stores that option's label under this key, so a view with no
       * live account details can name the choice. Clearing the choice stores "".
       */
      labelKey?: string;
    }
  | { kind: "toggle"; value: boolean }
  | { kind: "text"; value: string; maxLength: number; countingRule: TextCountingRule; optional: true }
  | { kind: "fixed"; value: string; display: string; explanation: string; doc?: string }
);

/** Per-target posting fields (G25). */
export interface PostingDeclaration<Values = unknown, Details = unknown> {
  /** Parses stored or submitted values; a failure means "not set". */
  valuesSchema: z.ZodType<Values>;
  /** Pure, total. The fields to show, in order. `details` is null while loading or after a failed read. */
  view(input: { values: Values | null; details: Details | null; postType: PostType }): PostingFieldView[];
  /** Pure. A heading line for the panel, e.g. "Posting to Ada". */
  heading?(details: Details | null): string | null;
  /** Pure. An optional notice above the fields. */
  notice?(): { text: string; doc?: string; docLabel?: string } | null;
  /** Pure. Short label shown beside the target's status everywhere. */
  targetNote?(values: Values | null): string | null;
  /** Pure. Extra lines for the requirements summary. */
  summaryNotes?(): string[];
  /** Pure. A line shown under the preview. */
  afterPreview?: string;
}

export type AccountDetailsResult<D> =
  | { ok: true; details: D }
  /** `message` is plain text, secrets scrubbed, at most 300 chars. */
  | { ok: false; message: string; credentialsExpired?: boolean; transient: boolean };

/** Live, non-secret account details for the composer (G26). */
export interface AccountDetailsReader<Settings = unknown, D = unknown> {
  schema: z.ZodType<D>;
  read(input: {
    account: { id: string; externalId: string; settings: Settings };
    credentials: unknown;
    now: Date;
    signal: AbortSignal;
  }): Promise<AccountDetailsResult<D>>;
}

/** Explicit consent before posting (G27). Requires `posting`. */
export interface ConsentDeclaration<Values = unknown> {
  /** Pure. The declaration shown beside "I agree". */
  declaration(values: Values | null): string;
}

export const ENGAGEMENT_ITEM_KINDS = ["reply", "comment", "mention", "direct_message"] as const;
export type EngagementItemKind = (typeof ENGAGEMENT_ITEM_KINDS)[number];

export interface EngagementDeclaration {
  /** Inbound kinds this provider can read. Empty is not allowed — omit `engagement` instead. */
  reads: readonly EngagementItemKind[];
  /** Whether an inbound item can be answered on this platform. */
  canReply: boolean;
  /**
   * G41. The item's own address on the platform, so a member can go and read it where it was said.
   *
   * Pure, and derived only from what is already stored — no network call, no guessing. Return
   * `null` whenever the platform's own URL shape is not a confirmed fact for this surface: a
   * plausible-looking link that 404s is worse than no link, and the inbox falls back to the parent
   * post's address, which Docket recorded when it published.
   *
   * Omit the hook entirely for a provider that can never say.
   */
  itemUrl?: (item: { externalId: string; authorHandle: string | null }) => string | null;
  /** The per-account write allowance a reply spends, for the publishing-first reserve (FR-042). */
  writeBudget?: PublishLimit;
  /**
   * Set when a surface is known to need a permission the install cannot hold (FR-055).
   * Declared surfaces still appear, marked unavailable with this reason and a link — and no call
   * is ever made for them.
   */
  unavailable?: { reason: string; docsPath?: string };
  /**
   * G40. Permissions an account must hold before Docket reads a single comment for it.
   * Default empty — "no permission needed", which is every provider's behaviour today.
   * A per-account claim: two accounts on the same provider may differ.
   */
  readScopes?: readonly string[];
  /** G40. Shown when `readScopes` are not held. Required when `readScopes` is non-empty. */
  missingReadScopes?: { reason: string; docsPath?: string };
}

export interface InboundItemDraft {
  kind: EngagementItemKind;
  /** 1–200 chars, trimmed, stable for this item on this platform. */
  externalId: string;
  /** "" when the item carries no text; never a placeholder. */
  text: string;
  textTruncated?: boolean;
  author: {
    /** null means the platform supplied none (FR-016). */
    displayName: string | null;
    handle: string | null;
    externalId: string | null;
    url: string | null;
    /** false whenever the provider cannot promise the same person twice (FR-017). */
    identityStable: boolean;
    /** default true. */
    reachable?: boolean;
  };
  saidAt: Date;
  parentExternalId: string | null;
  /** Validated against `itemDataSchema`; must contain no credential or token (FR-062). */
  data?: unknown;
  /** The platform reported the original gone or changed (FR-011). */
  upstream?: "withdrawn" | "edited";
}

export interface EngagementReadContext<Settings = unknown> {
  account: { id: string; externalId: string; displayName: string; settings: Settings; credentials: unknown };
  /** null = read the newest page. */
  cursor: string | null;
  /** Parsed through `stateSchema`; `{}` on the first read. */
  providerState: unknown;
  /** Which direction this call is paging. */
  direction: "newest" | "older";
  limit: number;
  now: Date;
  signal: AbortSignal;
}

export type EngagementReadResult =
  | {
      kind: "page";
      items: readonly InboundItemDraft[];
      cursor: string | null;
      providerState?: unknown;
      /** true means the platform has nothing older; the scheduler then clears the backfill flag. */
      exhausted: boolean;
      summary?: AttemptSummary;
    }
  | { kind: "retryable_error"; error: string; retryAt?: Date }
  | { kind: "fatal_error"; error: string }
  | { kind: "credentials_invalid"; error: string }
  | { kind: "rate_limited"; error: string; retryAt?: Date }
  | { kind: "cursor_lost"; error: string }
  | { kind: "unavailable"; reason: string; docsPath?: string };

export interface EngagementSendContext<Settings = unknown> {
  account: { id: string; externalId: string; settings: Settings; credentials: unknown };
  item: { kind: EngagementItemKind; externalId: string; parentExternalId: string | null; data: unknown };
  text: string;
  now: Date;
  signal: AbortSignal;
}

export type EngagementSendResult =
  | { kind: "sent"; externalId: string; url?: string; summary?: AttemptSummary }
  /** the platform says it is already answered. */
  | { kind: "duplicate"; externalId?: string }
  | { kind: "retryable_error"; error: string; retryAt?: Date }
  | { kind: "fatal_error"; error: string; flagAccount?: boolean }
  | { kind: "credentials_invalid"; error: string }
  | { kind: "ambiguous"; error: string };

export interface EngagementSupport<Settings = unknown> {
  declaration: EngagementDeclaration;
  /** Provider-owned shape of `engagement_items.provider_data`; the generic layer never reads it. */
  itemDataSchema: z.ZodType;
  /** Provider-owned shape of `engagement_account_states.provider_state`. */
  stateSchema: z.ZodType;
  read(ctx: EngagementReadContext<Settings>): Promise<EngagementReadResult>;
  send(ctx: EngagementSendContext<Settings>): Promise<EngagementSendResult>;
}

/** G38. Whether a metric accumulates, resets per period, or cannot be plotted over time (FR-001). */
export type MetricShape =
  | { kind: "cumulative" }
  /** `windowMs: null` when a window exists but its length is not fixed or not confirmed. */
  | { kind: "windowed"; windowMs: number | null }
  /** The reason is rendered where the series would otherwise be (FR-004). */
  | { kind: "unknown"; reason: string };

/** One metric a platform reports, named with the platform's own word (G30, FR-002). */
export interface MetricKeyDeclaration {
  /** The platform's own field name, e.g. `likeCount`. Stored verbatim as a key in `metrics`. */
  key: string;
  /** The platform's own label, e.g. "Likes". Rendered as given; never translated or grouped. */
  label: string;
  /** G38. Declared beside the key and label, by the provider, from docs/research/*.md. */
  shape: MetricShape;
}

export interface InsightsDeclaration {
  /** Keys this platform reports for a post. Empty is allowed only when `account` is not. */
  post: readonly MetricKeyDeclaration[];
  /** Keys this platform reports for a connected account. */
  account: readonly MetricKeyDeclaration[];
  /** Most posts the platform will answer for in one `readPostMetrics` call (FR-006). */
  maxPostsPerRead: number;
  /** The per-account read allowance, for the publishing-first reserve (FR-007). */
  readBudget: PublishLimit;
  /**
   * Set when the surface is known to need a permission this install cannot hold (FR-003).
   * A provider that declares this is **never claimed**: no call is ever attempted, and the panel
   * shows `reason` with a link to `docsPath`.
   */
  unavailable?: { reason: string; docsPath?: string };
  /** G37. Permissions the POST surface needs before any post read. Default empty. */
  postScopes?: readonly string[];
  /** G37. Shown when `postScopes` are not held. Required when `postScopes` is non-empty. */
  missingPostScopes?: { reason: string; docsPath?: string };
  /** G37. Permissions the ACCOUNT surface needs. Default empty — may differ from `postScopes`. */
  accountScopes?: readonly string[];
  /** G37. Shown when `accountScopes` are not held. Required when `accountScopes` is non-empty. */
  missingAccountScopes?: { reason: string; docsPath?: string };
  /** G35. Which stored identifier `readPostMetrics` is given. Default `"externalId"`. */
  postIdSource?: "externalId" | "publicPostId";
  /** G35. Required when `postIdSource` is `"publicPostId"`: shown for a target that has none. */
  missingPostId?: { reason: string; docsPath?: string };
  /** G34. Post types whose numbers die after `lifetimeMs` from publication. */
  ephemeralPostTypes?: readonly { postType: PostType; lifetimeMs: number }[];
}

export interface PostMetricsReadContext<Settings = unknown> {
  account: { id: string; externalId: string; displayName: string; settings: Settings; credentials: unknown };
  /** One account's targets, at most `min(configured page size, maxPostsPerRead)` of them. */
  posts: readonly { externalId: string }[];
  now: Date;
  signal: AbortSignal;
}

export type PostMetricEntry =
  /** `metrics` is validated against `postMetricsSchema` by the caller, then filtered to declared keys. */
  | { externalId: string; kind: "metrics"; metrics: unknown }
  /** The platform no longer returns this post. Terminal for this target; **not** a failure (FR-042). */
  | { externalId: string; kind: "gone" }
  /** This id cannot be used against the insights endpoint. Terminal, **not** a failure (FR-036). */
  | { externalId: string; kind: "unqueryable"; reason: string };

export type PostMetricsReadResult =
  | { kind: "page"; entries: readonly PostMetricEntry[]; summary?: AttemptSummary }
  | { kind: "retryable_error"; error: string; retryAt?: Date }
  | { kind: "fatal_error"; error: string }
  | { kind: "credentials_invalid"; error: string }
  | { kind: "rate_limited"; error: string; retryAt?: Date }
  | { kind: "unavailable"; reason: string; docsPath?: string };

export interface AccountMetricsReadContext<Settings = unknown> {
  account: { id: string; externalId: string; displayName: string; settings: Settings; credentials: unknown };
  now: Date;
  signal: AbortSignal;
}

export type AccountMetricsReadResult =
  | { kind: "page"; metrics: unknown; summary?: AttemptSummary }
  | { kind: "retryable_error"; error: string; retryAt?: Date }
  | { kind: "fatal_error"; error: string }
  | { kind: "credentials_invalid"; error: string }
  | { kind: "rate_limited"; error: string; retryAt?: Date }
  | { kind: "unavailable"; reason: string; docsPath?: string };

export interface InsightsSupport<Settings = unknown> {
  declaration: InsightsDeclaration;
  /** Provider-owned shape of a post snapshot's `metrics`; the generic layer validates and never reads into it. */
  postMetricsSchema: z.ZodType;
  /** Provider-owned shape of an account snapshot's `metrics`. */
  accountMetricsSchema: z.ZodType;
  readPostMetrics(ctx: PostMetricsReadContext<Settings>): Promise<PostMetricsReadResult>;
  readAccountMetrics(ctx: AccountMetricsReadContext<Settings>): Promise<AccountMetricsReadResult>;
}

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
  /**
   * True when `refreshCredentials` can open a brand-new session from what is already stored — a
   * Bluesky app password, say — rather than only renewing a live one. Such an account is worth
   * retrying *while* it is `needs_reauth`, because the thing that would fix it is already on disk.
   *
   * Without this, flagging an account was a one-way door. `claimRefreshAccounts` takes only
   * `active` rows and `acquireRefreshLease` requires `active`, so the moment anything flagged the
   * account — including a refusal a stored password would have survived — nothing ever called
   * `refreshCredentials` again, and publishing refused every target at claim time with "The
   * account is no longer available for publishing" and zero attempts. The stored password could
   * only ever help in the narrow window before the flag; after it, only a human reconnect
   * reopened the door. Requires `refreshCredentials`.
   */
  canReauthenticate?: boolean;
  validate(content: PostContent, capabilities: ProviderCapabilities): ValidationIssue[];
  /** Pure and total. `settings` is the account's parsed settings (a step can depend on them). */
  stepFor(state: State | null, settings: Settings, content: StepContent): StepInfo;
  advance(ctx: PublishContext): Promise<StepResult>;
  /** Pure. Non-secret notes shown on the account card. Never receives credentials. A throw or a non-array → []. */
  accountNotes?(input: { settings: Settings; credentialsExpireAt: Date | null; now?: Date; timeZone: string }): string[];
  posting?: PostingDeclaration;
  accountDetails?: AccountDetailsReader<Settings>;
  consent?: ConsentDeclaration;
  engagement?: EngagementSupport<Settings>;
  insights?: InsightsSupport<Settings>;
}
