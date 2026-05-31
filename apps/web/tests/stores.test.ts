// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for the zustand theme store. zustand stores are plain
// `useSyncExternalStore`-backed objects — calling `.getState()` and
// `.setState()` outside React works exactly like inside, which lets us
// exercise the actions without a DOM render runtime.
//
// What we DON'T test here: the actions touch `document.documentElement`
// and `localStorage`, both of which need a browser. Those side-effects
// are exercised by the existing component-render tests + manual click.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { useThemeStore } from "../src/stores/theme";

// Stand-in DOM that the store's actions can write to. Each test resets it.
function installFakeDom(): {
  html: { dataset: Record<string, string> };
  storage: Map<string, string>;
} {
  const dataset: Record<string, string> = {};
  const storage = new Map<string, string>();

  // biome-ignore lint/suspicious/noExplicitAny: deliberate global injection for the test
  (globalThis as any).document = { documentElement: { dataset } };
  // biome-ignore lint/suspicious/noExplicitAny: deliberate global injection for the test
  (globalThis as any).localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
    clear: () => storage.clear(),
    get length() {
      return storage.size;
    },
    key: (i: number) => [...storage.keys()][i] ?? null,
  };
  // biome-ignore lint/suspicious/noExplicitAny: matchMedia stub
  (globalThis as any).window = {
    matchMedia: mock(() => ({ matches: false })),
  };

  return { html: { dataset }, storage };
}

function resetStore() {
  useThemeStore.setState({ theme: null });
}

afterEach(() => {
  resetStore();
  // biome-ignore lint/suspicious/noExplicitAny: cleanup global injection
  delete (globalThis as any).document;
  // biome-ignore lint/suspicious/noExplicitAny: cleanup global injection
  delete (globalThis as any).localStorage;
  // biome-ignore lint/suspicious/noExplicitAny: cleanup global injection
  delete (globalThis as any).window;
});

describe("useThemeStore — initial state", () => {
  test("starts with theme=null (SSR-safe)", () => {
    expect(useThemeStore.getState().theme).toBeNull();
  });
});

describe("useThemeStore — setTheme", () => {
  test("commits to store + DOM dataset + localStorage", () => {
    const { html, storage } = installFakeDom();
    useThemeStore.getState().setTheme("dark");

    expect(useThemeStore.getState().theme).toBe("dark");
    expect(html.dataset.theme).toBe("dark");
    expect(storage.get("ct-theme")).toBe("dark");
  });

  test("overwrites previous value", () => {
    const { html, storage } = installFakeDom();
    useThemeStore.getState().setTheme("dark");
    useThemeStore.getState().setTheme("light");

    expect(useThemeStore.getState().theme).toBe("light");
    expect(html.dataset.theme).toBe("light");
    expect(storage.get("ct-theme")).toBe("light");
  });
});

describe("useThemeStore — toggle", () => {
  test("flips dark → light", () => {
    const { html, storage } = installFakeDom();
    useThemeStore.setState({ theme: "dark" });
    useThemeStore.getState().toggle();

    expect(useThemeStore.getState().theme).toBe("light");
    expect(html.dataset.theme).toBe("light");
    expect(storage.get("ct-theme")).toBe("light");
  });

  test("flips light → dark", () => {
    const { html, storage } = installFakeDom();
    useThemeStore.setState({ theme: "light" });
    useThemeStore.getState().toggle();

    expect(useThemeStore.getState().theme).toBe("dark");
    expect(html.dataset.theme).toBe("dark");
    expect(storage.get("ct-theme")).toBe("dark");
  });

  test("is a no-op while theme is null (pre-hydration)", () => {
    const { html, storage } = installFakeDom();
    expect(useThemeStore.getState().theme).toBeNull();

    useThemeStore.getState().toggle();

    expect(useThemeStore.getState().theme).toBeNull();
    expect(html.dataset.theme).toBeUndefined();
    expect(storage.size).toBe(0);
  });
});

describe("useThemeStore — hydrate", () => {
  test("resolves from <html data-theme> when set", () => {
    const fake = installFakeDom();
    fake.html.dataset.theme = "dark";

    useThemeStore.getState().hydrate();
    expect(useThemeStore.getState().theme).toBe("dark");
  });

  test("falls back to localStorage when dataset is unset", () => {
    const fake = installFakeDom();
    fake.storage.set("ct-theme", "light");

    useThemeStore.getState().hydrate();
    expect(useThemeStore.getState().theme).toBe("light");
  });

  test("falls back to system preference (matchMedia) when nothing is set", () => {
    installFakeDom();
    // biome-ignore lint/suspicious/noExplicitAny: re-stub matchMedia to return dark
    (globalThis as any).window.matchMedia = () => ({ matches: true });

    useThemeStore.getState().hydrate();
    expect(useThemeStore.getState().theme).toBe("dark");
  });

  test("is idempotent — second call doesn't change state when value matches", () => {
    const fake = installFakeDom();
    fake.html.dataset.theme = "dark";

    useThemeStore.getState().hydrate();
    const after1 = useThemeStore.getState();
    useThemeStore.getState().hydrate();
    const after2 = useThemeStore.getState();

    // theme matches and the state object is unchanged when value didn't move
    expect(after1.theme).toBe(after2.theme);
  });
});
