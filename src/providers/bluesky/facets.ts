import { RichText } from "@atproto/api";
import { normaliseHandle } from "./settings";

const MENTION = "app.bsky.richtext.facet#mention";

export interface FacetCounts {
  links: number;
  mentions: number;
  tags: number;
  droppedMentions: number;
}

export interface BuiltFacets {
  text: string;
  facets: NonNullable<RichText["facets"]>;
  counts: FacetCounts;
}

/**
 * Detect link, mention and hashtag facets. The library leaves the handle in a mention's `did`; it is swapped for the
 * DID in `mentions` (handle → DID | null), and a mention with no DID is dropped, leaving its text unchanged.
 */
export function buildFacets(text: string, mentions: Readonly<Record<string, string | null>>): BuiltFacets {
  const counts: FacetCounts = { links: 0, mentions: 0, tags: 0, droppedMentions: 0 };
  const rt = new RichText({ text });
  rt.detectFacetsWithoutResolution();
  const facets: BuiltFacets["facets"] = [];
  for (const facet of rt.facets ?? []) {
    const features: typeof facet.features = [];
    for (const feature of facet.features) {
      if (feature.$type === MENTION) {
        const did = mentions[normaliseHandle(String((feature as { did?: unknown }).did ?? ""))];
        if (!did) {
          counts.droppedMentions++;
          continue;
        }
        counts.mentions++;
        features.push({ ...feature, did } as (typeof features)[number]);
      } else {
        if (feature.$type === "app.bsky.richtext.facet#link") counts.links++;
        else if (feature.$type === "app.bsky.richtext.facet#tag") counts.tags++;
        features.push(feature);
      }
    }
    if (features.length > 0) facets.push({ ...facet, features });
  }
  return { text, facets, counts };
}
