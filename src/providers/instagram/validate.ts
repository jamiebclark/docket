import { validateAgainstCapabilities } from "../validation";
import type { PostContent, ProviderCapabilities, ValidationIssue } from "../types";

// T062 extends this (media_required wording, carousel_crop note).
export function validateInstagram(content: PostContent, caps: ProviderCapabilities): ValidationIssue[] {
  return validateAgainstCapabilities(content, caps);
}
