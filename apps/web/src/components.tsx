// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure presentational components with no server-only imports, so they are safe
// to use from both Server and Client Components.

import { UserRoundCog } from "lucide-react";
import type { ActionState } from "./api";

export function PermissionDenied({
  message = "Your role cannot use this action.",
}: {
  message?: string;
}) {
  return (
    <div className="empty">
      <UserRoundCog size={28} />
      <p>{message}</p>
    </div>
  );
}

export function StatusPill({ value }: { value: string }) {
  return <span className={`status ${value}`}>{value}</span>;
}

export function Notice({ state }: { state?: ActionState }) {
  if (!state?.message) return null;
  return <p className={`notice ${state.ok ? "info" : "error"}`}>{state.message}</p>;
}
