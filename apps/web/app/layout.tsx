// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cool Tunnel Admin",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
