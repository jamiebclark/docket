import { validateAgainstCapabilities } from "../validation";
import type { PostContent, ProviderCapabilities, ValidationIssue } from "../types";

export function validateFacebook(content: PostContent, caps: ProviderCapabilities): ValidationIssue[] {
  return validateAgainstCapabilities(content, caps);
}
