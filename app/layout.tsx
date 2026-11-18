import "@copilotkit/core/styles.css";
import "./globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "Call Your UI",
  description: "Call your app: talk to GPT Realtime and it edits the screen through your CopilotKit frontend tools.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f5f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0e0d12" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The `dark` class is toggled on <html> after hydration (see components/providers.tsx).
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
