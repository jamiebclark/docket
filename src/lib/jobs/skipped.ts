/** The plain-language reason a job item ended `skipped`, shared by the API and the app. */
export function alreadyPostedReason(externalId: string): string {
  return `Already posted: "${externalId}" became a post earlier.`;
}
