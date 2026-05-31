// SPDX-License-Identifier: AGPL-3.0-only
//
// shadcn Button primitive. Sourced from the canonical shadcn-ui catalogue
// (https://ui.shadcn.com/docs/components/button) and adapted to read
// from this project's existing CSS tokens (--accent, --danger, etc.)
// via the Tailwind @theme bridge in app/globals.css.
//
// Variants mirror the project's existing button classes:
//   default   ↔ .btn          (filled accent)
//   secondary ↔ .btn.secondary (filled subtle)
//   destructive ↔ .btn.danger
//   outline / ghost / link    — new variants shadcn brings
//
// asChild lets a caller render its own element (e.g., a Link) with the
// button styles applied. Standard shadcn Slot pattern.

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-sm)] text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-accent text-accent-contrast hover:bg-accent-hover",
        destructive: "bg-danger text-white hover:opacity-90",
        outline: "border border-line-strong bg-transparent hover:bg-surface-2",
        secondary: "bg-surface-2 text-text border border-line hover:border-line-strong",
        ghost: "hover:bg-surface-2",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-[var(--radius-sm)] px-3 text-xs",
        lg: "h-10 rounded-[var(--radius-sm)] px-6",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type = "button",
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      type={asChild ? undefined : type}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { buttonVariants };
