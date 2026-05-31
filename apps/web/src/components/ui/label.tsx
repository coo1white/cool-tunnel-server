// SPDX-License-Identifier: AGPL-3.0-only
//
// shadcn Label primitive. Wraps Radix Label which:
//   1. forwards click-to-focus on the associated input
//   2. forces consumers to provide `htmlFor` (or nest the input inside)
// — fixing the noLabelWithoutControl class of bugs at the type level.

import * as LabelPrimitive from "@radix-ui/react-label";
import type * as React from "react";
import { cn } from "@/lib/utils";

export function Label({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn(
        "text-sm font-medium leading-none text-text peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className,
      )}
      {...props}
    />
  );
}
