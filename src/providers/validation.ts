import { resolvePostType } from "./post-type";
import { countHashtags, countMentions, countText, countingUnit } from "./text";
import type { MediaItem, PostContent, PostType, ProviderCapabilities, ValidationIssue, VideoCapabilities } from "./types";
import {
  CONTAINER_LABEL,
  audioCodecLabel,
  durationLabel,
  fpsLabel,
  ratioLabel,
  videoBytesLabel,
  videoCodecLabel,
} from "./video-labels";

const isVideo = (item: MediaItem) => item.kind === "video";

export function inferPostType(content: PostContent): PostType {
  return resolvePostType(null, content.media, null);
}

/** The video limits for one post type: `caps.video` with `byPostType[type]` merged over it. */
export function videoLimitsFor(caps: ProviderCapabilities, type: PostType): VideoCapabilities {
  const { byPostType, ...base } = caps.video;
  const { notes: _notes, ...over } = byPostType?.[type] ?? {};
  return { ...base, ...over };
}

const EPS = 1e-9;

/** Each declared bound of one ready video, in the contract's order. */
function videoIssues(item: MediaItem, i: number, caps: VideoCapabilities): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const field = `media.${i}` as const;
  const label = `Video ${i + 1}`;
  const err = (code: ValidationIssue["code"], message: string, count?: number, limit?: number) =>
    out.push({ severity: "error", code, message, field, ...(count !== undefined && limit !== undefined ? { count, limit } : {}) });
  const f = item.video;
  if (!f) return out;

  if (caps.containers && !caps.containers.includes(f.container)) {
    err(
      "video_container_not_allowed",
      `${label} is ${CONTAINER_LABEL[f.container]}; allowed containers are ${caps.containers.map((c) => CONTAINER_LABEL[c]).join(", ")}.`,
    );
  }
  if (caps.videoCodecs && !caps.videoCodecs.includes(f.videoCodec)) {
    err(
      "video_codec_not_allowed",
      `${label} is ${videoCodecLabel(f.videoCodec)}; allowed video codecs are ${caps.videoCodecs.map(videoCodecLabel).join(", ")}.`,
    );
  }
  if (f.audioCodec === null) {
    if (caps.silentAllowed === false) err("audio_required", `${label} has no audio; this account needs audio.`);
  } else if (caps.audioCodecs && !caps.audioCodecs.includes(f.audioCodec)) {
    err(
      "audio_codec_not_allowed",
      `${label} has ${audioCodecLabel(f.audioCodec)} audio; allowed audio codecs are ${caps.audioCodecs.map(audioCodecLabel).join(", ")}.`,
    );
  }
  if (caps.maxBytes !== undefined && item.bytes > caps.maxBytes) {
    err("video_too_large", `${label} is ${videoBytesLabel(item.bytes)}; the limit is ${videoBytesLabel(caps.maxBytes)}.`, item.bytes, caps.maxBytes);
  }
  const seconds = f.durationSeconds;
  if (caps.minDurationSeconds !== undefined && seconds < caps.minDurationSeconds) {
    err(
      "video_too_short",
      `${label} is ${durationLabel(seconds)} long; the minimum is ${durationLabel(caps.minDurationSeconds)}.`,
      seconds,
      caps.minDurationSeconds,
    );
  }
  if (caps.maxDurationSeconds !== undefined && seconds > caps.maxDurationSeconds) {
    err(
      "video_too_long",
      `${label} is ${durationLabel(seconds)} long; the limit is ${durationLabel(caps.maxDurationSeconds)}.`,
      seconds,
      caps.maxDurationSeconds,
    );
  }
  const { width, height } = item;
  if (width !== null && caps.minWidth !== undefined && width < caps.minWidth) {
    err("video_too_small", `${label} is ${width} px wide; the minimum is ${caps.minWidth} px.`, width, caps.minWidth);
  }
  if (height !== null && caps.minHeight !== undefined && height < caps.minHeight) {
    err("video_too_small", `${label} is ${height} px tall; the minimum is ${caps.minHeight} px.`, height, caps.minHeight);
  }
  if (width !== null && caps.maxWidth !== undefined && width > caps.maxWidth) {
    err("video_too_big", `${label} is ${width} px wide; the limit is ${caps.maxWidth} px.`, width, caps.maxWidth);
  }
  if (height !== null && caps.maxHeight !== undefined && height > caps.maxHeight) {
    err("video_too_big", `${label} is ${height} px tall; the limit is ${caps.maxHeight} px.`, height, caps.maxHeight);
  }
  if (width !== null && height !== null && height > 0) {
    const ratio = width / height;
    const low = caps.minAspectRatio !== undefined && ratio < caps.minAspectRatio - EPS;
    const high = caps.maxAspectRatio !== undefined && ratio > caps.maxAspectRatio + EPS;
    if (low || high) {
      const min = caps.minAspectRatio !== undefined ? ratioLabel(caps.minAspectRatio) : "any";
      const max = caps.maxAspectRatio !== undefined ? ratioLabel(caps.maxAspectRatio) : "any";
      err("video_aspect_out_of_range", `${label} is ${ratioLabel(ratio)}; allowed is ${min} to ${max}.`);
    }
  }
  if (caps.maxFrameRate !== undefined && f.frameRate !== null && f.frameRate > caps.maxFrameRate + EPS) {
    err(
      "video_frame_rate_too_high",
      `${label} is ${fpsLabel(f.frameRate)}; the limit is ${fpsLabel(caps.maxFrameRate)}.`,
      f.frameRate,
      caps.maxFrameRate,
    );
  }
  if (caps.minFrameRate !== undefined && f.frameRate !== null && f.frameRate < caps.minFrameRate - EPS) {
    err(
      "video_frame_rate_too_low",
      `${label} is ${fpsLabel(f.frameRate)}; the minimum is ${fpsLabel(caps.minFrameRate)}.`,
      f.frameRate,
      caps.minFrameRate,
    );
  }
  return out;
}

/** Issues in a stable order: text, then postType, then media. */
export function validateAgainstCapabilities(
  content: PostContent,
  caps: ProviderCapabilities,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const hasText = content.text.trim().length > 0;
  const mediaCount = content.media.length;
  const videos = content.media.filter(isVideo);
  const imageCount = mediaCount - videos.length;

  if (!hasText && mediaCount === 0) {
    issues.push({
      severity: "error",
      code: "empty_post",
      message: "The post has no text and no media.",
      field: "text",
    });
  }

  const { countingRule, maxLength } = caps.text;
  const count = countText(content.text, countingRule);
  if (count > maxLength) {
    const unit = countingUnit(countingRule);
    issues.push({
      severity: "error",
      code: "text_too_long",
      message: `Text is ${count} ${unit}; the limit is ${maxLength}.`,
      field: "text",
      count,
      limit: maxLength,
    });
  }

  const { maxHashtags, maxMentions } = caps.text;
  if (maxHashtags !== undefined) {
    const hashtags = countHashtags(content.text);
    if (hashtags > maxHashtags) {
      issues.push({
        severity: "error",
        code: "too_many_hashtags",
        message: `The caption has ${hashtags} hashtags; the limit is ${maxHashtags}.`,
        field: "text",
        count: hashtags,
        limit: maxHashtags,
      });
    }
  }
  if (maxMentions !== undefined) {
    const mentions = countMentions(content.text);
    if (mentions > maxMentions) {
      issues.push({
        severity: "error",
        code: "too_many_mentions",
        message: `The caption has ${mentions} @mentions; the limit is ${maxMentions}.`,
        field: "text",
        count: mentions,
        limit: maxMentions,
      });
    }
  }

  const postType: PostType = content.postType ?? resolvePostType(caps, content.media, null);
  if (mediaCount === 0 && !caps.textOnlyAllowed && (hasText || !issues.some((i) => i.code === "empty_post"))) {
    issues.push({
      severity: "error",
      code: "text_only_not_allowed",
      message: "This account needs at least one image; text-only posts are not allowed.",
      field: "postType",
    });
  }
  if (mediaCount === 0 && caps.media.required && caps.textOnlyAllowed) {
    issues.push({
      severity: "error",
      code: "media_required",
      message: "This account requires media.",
      field: "media",
    });
  }
  const videosRefused = videos.length > 0 && caps.video.maxVideos === 0;
  if (mediaCount > 0 && !caps.postTypes.includes(postType) && !(postType === "video" && videosRefused)) {
    issues.push({
      severity: "error",
      code: "unsupported_post_type",
      message: `This account does not support ${postType} posts.`,
      field: "postType",
    });
  }

  if (imageCount > caps.media.maxImages) {
    issues.push({
      severity: "error",
      code: "too_many_images",
      message:
        caps.media.maxImages === 0
          ? "This account does not accept images."
          : `The post has ${imageCount} images; the limit is ${caps.media.maxImages}.`,
      field: "media",
      count: imageCount,
      limit: caps.media.maxImages,
    });
  }

  const vLimits = videoLimitsFor(caps, postType);
  if (videos.length > 0 && vLimits.maxVideos > 0) {
    if (videos.length > vLimits.maxVideos) {
      issues.push({
        severity: "error",
        code: "too_many_videos",
        message: `The post has ${videos.length} videos; the limit is ${vLimits.maxVideos}.`,
        field: "media",
        count: videos.length,
        limit: vLimits.maxVideos,
      });
    }
    if (imageCount > 0 && !vLimits.withImages) {
      issues.push({
        severity: "error",
        code: "video_with_images",
        message: "This account does not accept a video together with images.",
        field: "media",
      });
    }
  }

  content.media.forEach((item, i) => {
    const field = `media.${i}` as const;
    const video = isVideo(item);
    const label = video ? `Video ${i + 1}` : `Image ${i + 1}`;
    if (item.status === "processing") {
      issues.push({ severity: "error", code: "media_processing", message: `${label} is still processing.`, field });
      return;
    }
    if (item.status === "failed") {
      issues.push({
        severity: "error",
        code: "media_failed",
        message: `${label} failed${item.failureReason ? `: ${item.failureReason.replace(/[.\s]+$/, "")}` : ""}. Remove it to continue.`,
        field,
      });
      return;
    }
    if (video) {
      if (videosRefused) {
        issues.push({
          severity: "error",
          code: "video_not_accepted",
          message: "This account does not accept video yet.",
          field,
        });
      } else {
        issues.push(...videoIssues(item, i, vLimits));
      }
      return;
    }
    if (!caps.media.allowedMimeTypes.includes(item.mimeType)) {
      issues.push({
        severity: "error",
        code: "mime_not_allowed",
        message: `Image ${i + 1} is ${item.mimeType}; allowed types are ${caps.media.allowedMimeTypes.join(", ")}.`,
        field,
      });
    }
    if (item.bytes > caps.media.maxBytesPerFile) {
      issues.push({
        severity: "error",
        code: "file_too_large",
        message: `Image ${i + 1} is ${item.bytes} bytes; the limit is ${caps.media.maxBytesPerFile}.`,
        field,
        count: item.bytes,
        limit: caps.media.maxBytesPerFile,
      });
    }
    const maxAlt = caps.media.maxAltTextLength;
    if (maxAlt !== undefined && item.altText.length > maxAlt) {
      issues.push({
        severity: "error",
        code: "alt_text_too_long",
        message: `Image ${i + 1} alt text is ${item.altText.length} characters; the limit is ${maxAlt}.`,
        field,
        count: item.altText.length,
        limit: maxAlt,
      });
    }
    if (item.altText.trim() === "") {
      issues.push({
        severity: "warning",
        code: "missing_alt_text",
        message: `Image ${i + 1} has no alt text.`,
        field,
      });
    }
  });
  return issues;
}
