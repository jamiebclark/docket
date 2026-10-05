import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { connection } from "next/server";
import "./globals.css";

// Vendored OFL fonts (see src/app/fonts/LICENSE-*.txt): self-hosted, nothing downloaded at build time.
const inter = localFont({
  src: "./fonts/inter-latin-wght.woff2",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
});

const poppins = localFont({
  src: [
    { path: "./fonts/poppins-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/poppins-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "./fonts/poppins-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-poppins",
  display: "swap",
});

const DESCRIPTION = "Plan, write and schedule social posts across every project.";

/** Read per request: share-image URLs must be absolute, and the public address is set at run time. */
export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(process.env.BETTER_AUTH_URL?.trim() || "http://localhost:3000"),
    title: { default: "Docket", template: "%s · Docket" },
    description: DESCRIPTION,
    applicationName: "Docket",
    openGraph: { siteName: "Docket", title: "Docket", description: DESCRIPTION, type: "website" },
    twitter: { card: "summary_large_image", title: "Docket", description: DESCRIPTION },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1b1424" },
  ],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page renders per request, so Next can put the proxy's CSP nonce on its scripts.
  await connection();
  return (
    <html lang="en" className={`${inter.variable} ${poppins.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:ring-2 focus:ring-focus"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
