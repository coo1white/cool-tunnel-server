// SPDX-License-Identifier: AGPL-3.0-only
//
// shadcn Input primitive. Thin wrapper over <input>; the value is the
// shared focus-ring + disabled treatment and the consistent typography
// across the form library.

import type * as React from "react";
import { cn } from "@/lib/utils";

export function Input({
  className,
  type = "text",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type={type}
      className={cn(
        "flex h-9 w-full rounded-[var(--radius-sm)] border border-line-strong bg-surface px-3 py-1 text-sm text-text shadow-sm transition-colors",
        "file:border-0 file:bg-transparent file:text-sm file:font-medium",
        "placeholder:text-muted",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
