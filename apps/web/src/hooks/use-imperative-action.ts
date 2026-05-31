// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import type { ActionState } from "../api";

/**
 * Pairs React's `useTransition` with a single-slot message buffer so an
 * imperative server-action call can render its feedback inline.
 *
 * The pattern this hook replaces lived in `user-actions.tsx` and
 * `proxy-accounts.tsx::ProxyRowActions` — both spelled the same thing:
 *
 *   const [pending, startTransition] = useTransition();
 *   const [msg, setMsg] = useState<ActionState | null>(null);
 *
 *   function run(...args) {
 *     setMsg(null);
 *     startTransition(async () => {
 *       const res = await someAction(...args);
 *       setMsg(res);
 *       if (res.ok) setTimeout(() => setMsg(null), 2500);
 *     });
 *   }
 *
 * Use this for buttons that *invoke* a server action imperatively (vs.
 * `<form action={...}>` which is what `<ActionForm>` covers).
 *
 * The success auto-clear is configurable via `autoClearMs` (default 2500;
 * pass 0 to keep success messages persistent). Errors NEVER auto-clear —
 * the operator needs to read them.
 */
export interface UseImperativeActionResult<TArgs extends readonly unknown[]> {
  /** True while the underlying transition is in-flight. */
  readonly pending: boolean;
  /** The most recent result, or null after auto-clear / before first call. */
  readonly msg: ActionState | null;
  /** Invoke the wrapped action. */
  readonly run: (...args: TArgs) => void;
  /** Clear the message immediately. */
  readonly clear: () => void;
}

export interface UseImperativeActionOptions {
  /**
   * Auto-clear success messages after this many ms. Default: 2500.
   * Pass `0` to keep success messages persistent.
   * Errors never auto-clear regardless of this value.
   */
  readonly autoClearMs?: number;
  /** Callback fired once when the action resolves successfully. */
  readonly onSuccess?: (result: ActionState) => void;
  /** Callback fired once when the action resolves with `ok: false`. */
  readonly onError?: (result: ActionState) => void;
}

const DEFAULT_AUTO_CLEAR_MS = 2500;

export function useImperativeAction<TArgs extends readonly unknown[]>(
  action: (...args: TArgs) => Promise<ActionState>,
  options: UseImperativeActionOptions = {},
): UseImperativeActionResult<TArgs> {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<ActionState | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setMsg(null);
  }, []);

  const { autoClearMs = DEFAULT_AUTO_CLEAR_MS, onSuccess, onError } = options;

  const run = useCallback(
    (...args: TArgs) => {
      clear();
      startTransition(async () => {
        const res = await action(...args);
        setMsg(res);
        if (res.ok) {
          onSuccess?.(res);
          if (autoClearMs > 0) {
            timeoutRef.current = setTimeout(() => {
              setMsg(null);
              timeoutRef.current = null;
            }, autoClearMs);
          }
        } else {
          onError?.(res);
        }
      });
    },
    [action, clear, autoClearMs, onSuccess, onError],
  );

  return { pending, msg, run, clear };
}
