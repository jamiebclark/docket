export function jwtExp(_jwt: string): Date | null {
  throw new Error("not implemented");
}

export function needsRefresh(_expiresAt: Date | null, _now: Date): boolean {
  throw new Error("not implemented");
}

export async function connectAccount(_input: Record<string, string>): Promise<never> {
  throw new Error("not implemented");
}

export async function refreshCredentials(_input: unknown): Promise<never> {
  throw new Error("not implemented");
}
