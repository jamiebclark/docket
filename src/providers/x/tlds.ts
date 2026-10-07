/**
 * Top-level domains recognised in a scheme-less link when counting (research D7, FR-019).
 * Deliberately a short fixed list, not the IANA registry: an approximation of X's validator whose drift
 * the near-limit warning covers. Lower case.
 */
const GENERIC = [
  "com", "net", "org", "info", "biz", "io", "co", "ai", "app", "dev", "me", "tv", "xyz", "edu", "gov", "mil", "int",
  "online", "site", "tech", "store", "shop", "blog", "news", "live", "cloud", "page", "link", "club", "top", "pro",
  "name", "mobi", "agency", "art", "design", "digital", "media", "network", "studio", "team", "world", "life", "social",
  "email", "today", "space", "website", "xxx", "fm", "gg", "ly", "to", "cc", "ws", "sh", "so",
];

const COUNTRY = [
  "ac", "ae", "ar", "at", "au", "be", "bg", "br", "ca", "ch", "cl", "cn", "cz", "de", "dk", "ee", "eg", "es", "eu",
  "fi", "fr", "gr", "hk", "hr", "hu", "id", "ie", "il", "in", "is", "it", "jp", "ke", "kr", "lt", "lu", "lv", "mx",
  "my", "ng", "nl", "no", "nz", "pe", "ph", "pk", "pl", "pt", "ro", "rs", "ru", "sa", "se", "sg", "si", "sk", "th",
  "tr", "tw", "ua", "uk", "us", "vn", "za",
];

export const X_TLDS: readonly string[] = [...new Set([...GENERIC, ...COUNTRY])];
