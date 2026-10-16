/**
 * Identity rules for inbound engagement authors (FR-016–FR-018). Pure: no field is ever invented,
 * and identity is never merged across platforms or accounts, or when the provider cannot promise
 * the same person twice.
 */

export interface AuthorIdentity {
  displayName: string | null;
  handle: string | null;
  externalId: string | null;
  url: string | null;
  identityStable: boolean;
}

/** An identity pass-through: present fields are kept as given, absent fields stay absent. */
export function resolveAuthorIdentity(input: AuthorIdentity): AuthorIdentity {
  return {
    displayName: input.displayName,
    handle: input.handle,
    externalId: input.externalId,
    url: input.url,
    identityStable: input.identityStable,
  };
}

export interface AuthorRef {
  providerKey: string;
  socialAccountId: string;
  authorExternalId: string | null;
  authorIdentityStable: boolean;
}

/**
 * Whether two items can be said to be the same person: only when both are on the same platform and
 * the same connected account, both carry a stable identifier, and the identifiers match (FR-017,
 * FR-018). There is no cross-platform or cross-account merging, ever.
 */
export function isSameAuthor(a: AuthorRef, b: AuthorRef): boolean {
  if (a.providerKey !== b.providerKey) return false;
  if (a.socialAccountId !== b.socialAccountId) return false;
  if (!a.authorIdentityStable || !b.authorIdentityStable) return false;
  if (a.authorExternalId === null || b.authorExternalId === null) return false;
  return a.authorExternalId === b.authorExternalId;
}
