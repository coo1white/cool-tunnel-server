// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit tests for the pure helpers extracted alongside our custom hooks.
// The React-state portions of the hooks themselves are exercised by the
// component renders (see components.test.tsx style) — they need a DOM
// runtime which this project deliberately doesn't pull in (yet).

import { describe, expect, test } from "bun:test";
import { readStoredTheme, writeStoredTheme } from "../src/hooks/use-theme";

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

class ThrowingStorage implements Storage {
  readonly length = 0;
  clear(): void {
    throw new Error("nope");
  }
  getItem(): string | null {
    throw new Error("nope");
  }
  key(): string | null {
    throw new Error("nope");
  }
  removeItem(): void {
    throw new Error("nope");
  }
  setItem(): void {
    throw new Error("nope");
  }
}

describe("readStoredTheme", () => {
  test("returns null when nothing is stored", () => {
    expect(readStoredTheme(new MemoryStorage())).toBeNull();
  });

  test("returns 'dark' / 'light' when set", () => {
    const s = new MemoryStorage();
    s.setItem("ct-theme", "dark");
    expect(readStoredTheme(s)).toBe("dark");
    s.setItem("ct-theme", "light");
    expect(readStoredTheme(s)).toBe("light");
  });

  test("returns null for unrecognised values (defends against tampering)", () => {
    const s = new MemoryStorage();
    s.setItem("ct-theme", "midnight");
    expect(readStoredTheme(s)).toBeNull();
    s.setItem("ct-theme", "");
    expect(readStoredTheme(s)).toBeNull();
  });

  test("swallows storage errors (private mode, quota, blocked) and returns null", () => {
    expect(readStoredTheme(new ThrowingStorage())).toBeNull();
  });
});

describe("writeStoredTheme", () => {
  test("writes the canonical key", () => {
    const s = new MemoryStorage();
    writeStoredTheme("dark", s);
    expect(s.getItem("ct-theme")).toBe("dark");
    writeStoredTheme("light", s);
    expect(s.getItem("ct-theme")).toBe("light");
  });

  test("swallows storage errors (no throw to caller)", () => {
    expect(() => writeStoredTheme("dark", new ThrowingStorage())).not.toThrow();
  });
});
