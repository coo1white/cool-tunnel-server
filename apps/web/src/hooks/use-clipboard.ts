// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Wraps `navigator.clipboard.writeText` with the three-state pattern that
 * `CopySubscription` in `proxy-accounts.tsx` was spelling by hand: busy /
 * copied (briefly, for visual feedback) / error.
 *
 * Accepts either a plain string OR an async getter — the getter form lets
 * callers fetch the value lazily (e.g., a server action that audits the
 * reveal) without the value ever sitting in a React state slot.
 *
 * Failure modes:
 *  - getter throws → error state populated, `copied` stays false
 *  - clipboard write throws (private mode / permission denied) → error state
 *    set to "Clipboard blocked.", caller can still surface its own UI
 */
export interface UseClipboardResult {
  /** True for ~`feedbackMs` after a successful copy. Drives the ✓ vs 📋 icon. */
  readonly copied: boolean;
  /** True while the getter or clipboard write is in-flight. */
  readonly copying: boolean;
  /** Error message from the getter or clipboard write, or null. */
  readonly error: string | null;
  /** Returns `true` on success. */
  readonly copy: (input: string | (() => Promise<string>)) => Promise<boolean>;
  /** Clear `copied`/`error` manually (rare — both clear automatically). */
  readonly reset: () => void;
}

export interface UseClipboardOptions {
  /** Duration of the `copied` true window in ms. Default 1500. */
  readonly feedbackMs?: number;
  /** Override the "clipboard blocked" message. */
  readonly clipboardErrorMessage?: string;
}

const DEFAULT_FEEDBACK_MS = 1500;
const DEFAULT_CLIPBOARD_ERROR = "Clipboard blocked.";

export function useClipboard(options: UseClipboardOptions = {}): UseClipboardResult {
  const { feedbackMs = DEFAULT_FEEDBACK_MS, clipboardErrorMessage = DEFAULT_CLIPBOARD_ERROR } =
    options;

  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setCopied(false);
    setError(null);
  }, []);

  const copy = useCallback(
    async (input: string | (() => Promise<string>)): Promise<boolean> => {
      reset();
      setCopying(true);
      try {
        const text = typeof input === "function" ? await input() : input;
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          setError(clipboardErrorMessage);
          return false;
        }
        setCopied(true);
        timeoutRef.current = setTimeout(() => {
          setCopied(false);
          timeoutRef.current = null;
        }, feedbackMs);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setCopying(false);
      }
    },
    [reset, feedbackMs, clipboardErrorMessage],
  );

  return { copied, copying, error, copy, reset };
}
