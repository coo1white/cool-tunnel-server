// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "ct-theme";

/**
 * Reads the persisted theme from `localStorage`, returning `null` for unset
 * or unrecognised values. Pure function — safe to call outside React.
 */
export function readStoredTheme(storage: Storage = localStorage): Theme | null {
  try {
    const value = storage.getItem(THEME_STORAGE_KEY);
    return value === "dark" || value === "light" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Writes the theme to `localStorage`. Swallows storage errors (private mode,
 * quota, blocked) — the in-memory toggle still applies for the current view.
 */
export function writeStoredTheme(theme: Theme, storage: Storage = localStorage): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* private mode / storage disabled — toggle still applies for this view */
  }
}

/**
 * Resolves the effective initial theme by checking, in priority order:
 *   1. `<html data-theme>` (set by the no-FOUC bootstrap script in layout)
 *   2. The persisted `localStorage` value
 *   3. The system preference (`prefers-color-scheme: dark`)
 *
 * Returns `"light"` as a last resort.
 */
export function resolveInitialTheme(): Theme {
  const fromHtml = document.documentElement.dataset.theme;
  if (fromHtml === "dark" || fromHtml === "light") return fromHtml;
  const stored = readStoredTheme();
  if (stored) return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Reads, writes, and toggles the panel's dark/light theme.
 *
 * Returns `theme: null` during the initial mount — the no-FOUC script in
 * `app/layout.tsx` has already set `<html data-theme>` synchronously before
 * React hydrates, so the page is already painted in the right colours; the
 * `null` lets the toggle button avoid rendering a wrong icon for one frame.
 *
 * The theme is committed to BOTH `document.documentElement.dataset.theme`
 * (immediate effect on the page) AND `localStorage` (persists across reloads).
 *
 * NOTE: This is set up for a future zustand-backed swap (Learning item #5,
 * v0.6.7). When that lands, the hook signature stays the same; the
 * `useState`/`useEffect` internals are replaced with a zustand store.
 */
export interface UseThemeResult {
  /** Current theme, or `null` during the initial hydration tick. */
  readonly theme: Theme | null;
  /** Set the theme explicitly. */
  readonly setTheme: (theme: Theme) => void;
  /** Toggle between light and dark. No-op while `theme` is null. */
  readonly toggle: () => void;
}

export function useTheme(): UseThemeResult {
  const [theme, setThemeState] = useState<Theme | null>(null);

  useEffect(() => {
    setThemeState(resolveInitialTheme());
  }, []);

  const setTheme = useCallback((next: Theme) => {
    document.documentElement.dataset.theme = next;
    writeStoredTheme(next);
    setThemeState(next);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((current) => {
      if (current === null) return current;
      const next: Theme = current === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      writeStoredTheme(next);
      return next;
    });
  }, []);

  return { theme, setTheme, toggle };
}
