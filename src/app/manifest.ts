import type { MetadataRoute } from "next";

/** Web app manifest: name, colours and install icons (regenerate icons with `node scripts/brand-icons.mjs`). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Docket",
    short_name: "Docket",
    description: "Plan, write and schedule social posts across every project.",
    start_url: "/",
    display: "standalone",
    background_color: "#f8f9fa",
    theme_color: "#4a148c",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
