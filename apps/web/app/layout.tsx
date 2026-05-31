// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  // Per-page pages can `export const metadata = { title: "..." }` and
  // Next.js will render it via the template — e.g., title "Dashboard"
  // becomes "Dashboard · Cool Tunnel Admin" in the browser tab.
  title: {
    default: "Cool Tunnel Admin",
    template: "%s · Cool Tunnel Admin",
  },
  description: "Self-hosted proxy server admin panel — VLESS + Reality.",
  robots: { index: false, follow: false },
};

// Applies the saved theme to <html> before first paint to avoid a flash of
// the wrong theme. Runs synchronously ahead of the rendered content.
const THEME_INIT = `(function(){try{var t=localStorage.getItem('ct-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: deliberate no-FOUC theme bootstrap; content is a static string literal */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        {children}
      </body>
    </html>
  );
}
