import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Docket", template: "%s · Docket" },
  description: "Multi-project social scheduler and post generator",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
