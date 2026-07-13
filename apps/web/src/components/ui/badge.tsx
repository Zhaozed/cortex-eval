import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../../lib/class-names.ts";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.12em] whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[var(--ink)] text-white",
        secondary: "border-[var(--line)] bg-[var(--paper-deep)] text-[var(--ink-soft)]",
        outline: "border-[var(--line-strong)] text-[var(--ink)]",
        accent: "border-[var(--accent-soft)] bg-[var(--accent-soft)] text-[var(--accent-dark)]"
      }
    },
    defaultVariants: { variant: "default" }
  }
);

/** shadcn/ui Badge properties. */
export interface BadgeProps
  extends React.ComponentProps<"span">, VariantProps<typeof badgeVariants> {
  /** Render the child element through Radix Slot. */
  readonly asChild?: boolean | undefined;
}

/** shadcn/ui Badge primitive. */
export function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: BadgeProps): React.JSX.Element {
  const Component = asChild ? Slot : "span";
  return (
    <Component data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
