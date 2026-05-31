// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useEffect } from "react";
import { type Theme, useThemeStore } from "../stores/theme";

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
 * SWAP NOTE (v0.6.7): the storage + system-preference helpers and the
 * stateful machinery moved into a zustand store at `../stores/theme.ts`.
 * The public shape of this hook is unchanged from v0.6.6 — `theme-toggle.tsx`
 * needed no edits. Going through a global store rather than per-component
 * `useState` means a future page that wants to read the theme (e.g., to
 * colour-match a syntax-highlighted code block) can do so with `useTheme()`
 * and stay in sync with the toggle button on the nav bar without
 * prop-drilling.
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
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const toggle = useThemeStore((s) => s.toggle);
  const hydrate = useThemeStore((s) => s.hydrate);

  // One-shot hydration on mount. The store's `hydrate` is idempotent, so
  // React Strict Mode's double-invocation in dev is harmless.
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  return { theme, setTheme, toggle };
}

// Re-export the storage helpers + Theme type so existing consumers
// (and tests) that imported them from "./use-theme" keep working.
export {
  readStoredTheme,
  resolveInitialTheme,
  type Theme,
  writeStoredTheme,
} from "../stores/theme";
