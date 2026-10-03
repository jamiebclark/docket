import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Docket", template: "%s · Docket" },
  description: "Multi-project social scheduler and post generator",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
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
