// SPDX-License-Identifier: AGPL-3.0-only
//
// The shadcn standard `cn()` helper: clsx for conditional class joining
// + tailwind-merge to de-duplicate conflicting Tailwind utilities (so
// `cn("px-4", "px-2")` becomes `"px-2"`, not `"px-4 px-2"`).
//
// Every shadcn primitive in src/components/ui/ uses this.

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
