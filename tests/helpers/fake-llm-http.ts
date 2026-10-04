export interface FakeLlmResponse {
  status: number;
  json?: unknown;
  delayMs?: number;
}

export interface FakeLlmCall {
  url: string;
  body: unknown;
}

/** A `fetch` that records `{ url, body }`, replays `responses` in order and honours `signal`. */
export function createFakeLlmFetch(responses: FakeLlmResponse[]): typeof fetch & { calls: FakeLlmCall[] } {
  const queue = [...responses];
  const calls: FakeLlmCall[] = [];

  const abortError = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep the raw string */
      }
    }
    calls.push({ url, body });
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw abortError();
    const next = queue.shift();
    if (!next) throw new Error("Fake LLM fetch ran out of scripted responses");
    if (next.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, next.delayMs);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(abortError());
          },
          { once: true },
        );
      });
    }
    return new Response(next.json === undefined ? null : JSON.stringify(next.json), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  };
  return Object.assign(fake, { calls }) as typeof fetch & { calls: FakeLlmCall[] };
}
