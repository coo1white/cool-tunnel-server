// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { RotateCcw, Trash2, UserMinus, UserPlus } from "lucide-react";
import { useState, useTransition } from "react";
import { userCommand } from "./actions";
import { Notice } from "./components";
import type { ActionState } from "./api";

interface UserActionsProps {
  readonly userId: string;
  readonly status: "active" | "disabled";
  readonly canDisable: boolean;
  readonly canReset: boolean;
  readonly canDelete: boolean;
}

/**
 * Action buttons stay in a fixed horizontal row (Disable / Reset password /
 * Delete); feedback shows on a single line BELOW the row (success auto-clears,
 * errors persist). The "New temporary password" input is paired ONLY with
 * Reset password — visually grouped, and gated so the button is disabled
 * until a long-enough password is typed.
 *
 * Mirrors the ProxyRowActions pattern from proxy-accounts.tsx so the two
 * admin surfaces use the same vocabulary.
 */
export function UserActions({
  userId,
  status,
  canDisable,
  canReset,
  canDelete,
}: UserActionsProps) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<ActionState | null>(null);
  const [password, setPassword] = useState("");

  function run(command: string, pwd?: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await userCommand(userId, command, pwd);
      setMsg(res);
      if (res.ok) {
        setPassword("");
        setTimeout(() => setMsg(null), 2500);
      }
    });
  }

  const canSubmitReset = password.length >= 12 && !pending;

  return (
    <div className="row-actions">
      <div className="user-actions">
        {canDisable && (
          <button
            className="btn secondary"
            type="button"
            disabled={pending}
            onClick={() => run(status === "active" ? "disable" : "enable")}
          >
            {status === "active" ? (
              <>
                <UserMinus size={16} /> Disable
              </>
            ) : (
              <>
                <UserPlus size={16} /> Enable
              </>
            )}
          </button>
        )}

        {canReset && (
          <div className="user-actions__reset">
            <input
              type="password"
              minLength={12}
              placeholder="New temporary password (min 12 chars)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              aria-label="New temporary password"
            />
            <button
              className="btn secondary"
              type="button"
              disabled={!canSubmitReset}
              onClick={() => run("reset-password", password)}
            >
              <RotateCcw size={16} /> Reset password
            </button>
          </div>
        )}

        {canDelete && (
          <button
            className="btn danger user-actions__delete"
            type="button"
            disabled={pending}
            onClick={() => {
              if (window.confirm("Delete this user? This cannot be undone.")) {
                run("delete");
              }
            }}
            aria-label="Delete user"
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
      {msg && <Notice state={msg} />}
    </div>
  );
}
