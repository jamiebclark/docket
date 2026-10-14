// LLM_RATES / LLM_RATE_CURRENCY (contracts/config.md): operator-supplied, never shipped, never fetched.
import type { EnvIssue } from "../env";
import type { LlmProviderName } from "./types";

type Source = Record<string, string | undefined>;

export interface ModelRate {
  provider: LlmProviderName;
  model: string;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
}

export interface LlmRates {
  entries: ModelRate[];
  currency: string | null;
  problems: EnvIssue[];
}

const PROVIDERS: readonly LlmProviderName[] = ["openai", "anthropic"];
const PRICE = /^\d+(\.\d{1,6})?$/;
const CURRENCY = /^[A-Za-z]{3}$/;

function priceToMicros(raw: string): number | null {
  if (!PRICE.test(raw)) return null;
  const [intPart, fracPart = ""] = raw.split(".");
  return Number(intPart) * 1_000_000 + Number(fracPart.padEnd(6, "0").slice(0, 6));
}

const GRAMMAR = "must match <provider>:<model>=<input price>/<output price>";

function parseEntry(entry: string): ModelRate | { reason: string } {
  const colon = entry.indexOf(":");
  if (colon < 0) return { reason: GRAMMAR };
  const providerRaw = entry.slice(0, colon);
  const rest = entry.slice(colon + 1);
  const equals = rest.lastIndexOf("=");
  if (equals < 0) return { reason: GRAMMAR };
  const model = rest.slice(0, equals);
  const prices = rest.slice(equals + 1).split("/");

  if (!PROVIDERS.includes(providerRaw as LlmProviderName)) {
    return { reason: "provider must be openai or anthropic" };
  }
  if (model.length < 1 || model.length > 200 || /\s/.test(model)) return { reason: GRAMMAR };
  if (prices.length !== 2) return { reason: GRAMMAR };

  const inputMicrosPerMillion = priceToMicros(prices[0] ?? "");
  const outputMicrosPerMillion = priceToMicros(prices[1] ?? "");
  if (inputMicrosPerMillion === null || outputMicrosPerMillion === null) {
    return { reason: "prices must be numbers with at most 6 decimal places" };
  }
  return { provider: providerRaw as LlmProviderName, model, inputMicrosPerMillion, outputMicrosPerMillion };
}

/** Pure. Never throws. Rejection is total: one bad entry discards the whole table (FR-011). */
export function parseLlmRates(source: Source): LlmRates {
  const ratesRaw = source.LLM_RATES?.trim();
  const currencyRaw = source.LLM_RATE_CURRENCY?.trim();

  if (!ratesRaw) {
    const problems: EnvIssue[] = [];
    if (currencyRaw && !CURRENCY.test(currencyRaw)) {
      problems.push({ name: "LLM_RATE_CURRENCY", reason: "must be three letters" });
    }
    return { entries: [], currency: null, problems };
  }

  const problems: EnvIssue[] = [];
  const entries: ModelRate[] = [];
  const seen = new Set<string>();
  for (const token of ratesRaw.split(/[\s,]+/).filter(Boolean)) {
    const parsed = parseEntry(token);
    if ("reason" in parsed) {
      problems.push({ name: "LLM_RATES", reason: parsed.reason });
      continue;
    }
    const key = `${parsed.provider}:${parsed.model}`;
    if (seen.has(key)) {
      problems.push({ name: "LLM_RATES", reason: "names the same provider and model twice" });
      continue;
    }
    seen.add(key);
    entries.push(parsed);
  }

  if (!currencyRaw) {
    problems.push({ name: "LLM_RATE_CURRENCY", reason: "required when LLM_RATES is set" });
  } else if (!CURRENCY.test(currencyRaw)) {
    problems.push({ name: "LLM_RATE_CURRENCY", reason: "must be three letters" });
  }

  if (problems.length > 0) return { entries: [], currency: null, problems };
  return { entries, currency: currencyRaw!.toUpperCase(), problems: [] };
}

let cached: LlmRates | undefined;

/** Lazy and memoised, like `getEnv()`. Never evaluated at import so `next build` works unconfigured. */
export function getLlmRates(): LlmRates {
  if (cached) return cached;
  cached = parseLlmRates(process.env);
  return cached;
}

/** Exact, case-sensitive match on both. Never matches by provider alone (FR-010). */
export function rateFor(rates: LlmRates, provider: string, model: string): ModelRate | null {
  return rates.entries.find((e) => e.provider === provider && e.model === model) ?? null;
}

/** Exact integers; BigInt because tokens × price overflows a double at real volumes (P12). */
export function estimateMicros(tokens: number, microsPerMillion: number): number {
  return Number((BigInt(tokens) * BigInt(microsPerMillion)) / 1_000_000n);
}

/** "12.34 USD"; "under 0.01 USD" when non-zero but rounding to zero; "0.00 USD" for a zero rate. */
export function formatMoney(micros: number, currency: string): string {
  if (micros === 0) return `0.00 ${currency}`;
  const cents = Math.round(micros / 10_000);
  if (cents === 0) return `under 0.01 ${currency}`;
  const amount = (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${amount} ${currency}`;
}
