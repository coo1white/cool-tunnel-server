// SPDX-License-Identifier: AGPL-3.0-only
//
// shadcn Skeleton primitive. Used as Suspense fallback while
// server-rendered data is loading. Subtle pulse animation; the
// `bg-surface-2` mirrors our card colour so it sits in the layout
// without visual distortion.

import type * as React from "react";
import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-surface-2", className)} {...props} />;
}
