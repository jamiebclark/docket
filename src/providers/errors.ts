export class UnknownProviderError extends Error {
  readonly providerKey: string;
  constructor(providerKey: string) {
    super(`The ${providerKey} provider is no longer available`);
    this.name = "UnknownProviderError";
    this.providerKey = providerKey;
  }
}
