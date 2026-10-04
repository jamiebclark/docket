import type { Metadata } from "next";
import { connection } from "next/server";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Docket", template: "%s · Docket" },
  description: "Multi-project social scheduler and post generator",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page renders per request, so Next can put the proxy's CSP nonce on its scripts.
  await connection();
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:ring-2 focus:ring-foreground"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
