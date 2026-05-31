// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

type Theme = "light" | "dark";

// Initial paint is handled by the inline no-FOUC script in the root layout,
// which sets data-theme on <html> from localStorage before render. This
// component just reflects and toggles that state.
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const current = document.documentElement.dataset.theme as Theme | undefined;
    const system = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    setTheme(current ?? system);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("ct-theme", next);
    } catch {
      /* private mode / storage disabled — toggle still applies for this view */
    }
    setTheme(next);
  }

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
