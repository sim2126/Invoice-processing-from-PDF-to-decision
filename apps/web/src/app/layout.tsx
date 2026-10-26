import type { Metadata, Viewport } from "next";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./globals.css";
import { Providers } from "@/components/providers";
import { AppShell } from "@/components/shell";

export const metadata: Metadata = {
  title: { default: "Tickmark", template: "%s · Tickmark" },
  description: "Invoice to decision. Every check, shown.",
  applicationName: "Tickmark",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
