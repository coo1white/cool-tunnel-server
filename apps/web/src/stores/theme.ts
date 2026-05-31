// SPDX-License-Identifier: AGPL-3.0-only
//
// zustand store for the panel's dark/light theme + the pure storage helpers
// that back it.
//
// SSR-safe by construction:
//   - No `document` access at module load
//   - No `localStorage` access at module load
//   - Initial store state is `theme: null` which renders the same on server
//     and client
//   - All browser-touching logic runs inside actions, which only fire after
//     mount on the client
//
// The hook that exposes this store (`useTheme` in ../hooks/use-theme.ts)
// keeps the same public API it had pre-zustand. Call sites — there's only
// one, `theme-toggle.tsx` — get zero changes from this swap.

import { create } from "zustand";

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
 * Returns `"light"` as a last resort. Browser-only — DO NOT call on the server.
 */
export function resolveInitialTheme(): Theme {
  const fromHtml = document.documentElement.dataset.theme;
  if (fromHtml === "dark" || fromHtml === "light") return fromHtml;
  const stored = readStoredTheme();
  if (stored) return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// --- Store ---------------------------------------------------------------

export interface ThemeStoreState {
  /** Current theme, or null before client-side hydration completes. */
  readonly theme: Theme | null;
}

export interface ThemeStoreActions {
  /** Commit a theme: writes to DOM + localStorage + store. */
  readonly setTheme: (theme: Theme) => void;
  /** Toggle between light and dark. No-op while theme is null. */
  readonly toggle: () => void;
  /** Idempotent: reads no-FOUC dataset → localStorage → system preference
   *  and sets store theme accordingly. Safe to call on every mount. */
  readonly hydrate: () => void;
}

export type ThemeStore = ThemeStoreState & ThemeStoreActions;

export const useThemeStore = create<ThemeStore>((set, get) => ({
  theme: null,

  setTheme: (theme) => {
    document.documentElement.dataset.theme = theme;
    writeStoredTheme(theme);
    set({ theme });
  },

  toggle: () => {
    const current = get().theme;
    if (current === null) return;
    const next: Theme = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    writeStoredTheme(next);
    set({ theme: next });
  },

  hydrate: () => {
    const resolved = resolveInitialTheme();
    if (get().theme !== resolved) set({ theme: resolved });
  },
}));
