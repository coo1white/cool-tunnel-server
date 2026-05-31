// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "./hooks";

// Initial paint is handled by the inline no-FOUC script in the root layout,
// which sets data-theme on <html> from localStorage before render. This
// component just reflects and toggles that state via the useTheme hook.
export function ThemeToggle() {
  const { theme, toggle } = useTheme();

  return (
    <button
      type="button"
      className="icon-btn"
      onClick={toggle}
      aria-label="Toggle color theme"
      title="Toggle theme"
    >
      {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
