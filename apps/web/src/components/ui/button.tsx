import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../../lib/class-names.ts";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4",
  {
    variants: {
      variant: {
        default: "bg-[var(--ink)] text-white hover:bg-[var(--ink-soft)]",
        destructive: "bg-[var(--danger)] text-white hover:bg-[var(--danger-dark)]",
        outline: "border border-[var(--line-strong)] bg-white hover:bg-[var(--paper-deep)]",
        secondary: "bg-[var(--paper-deep)] text-[var(--ink)] hover:bg-[var(--line)]",
        ghost: "hover:bg-[var(--paper-deep)]",
        link: "text-[var(--accent)] underline-offset-4 hover:underline"
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 rounded px-3 text-xs",
        lg: "h-11 px-7",
        icon: "size-10"
      }
    },
    defaultVariants: { variant: "default", size: "default" }
  }
);

/** shadcn/ui Button properties. */
export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Render the child element through Radix Slot. */
  readonly asChild?: boolean | undefined;
}

/** Accessible shadcn/ui Button primitive. */
export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps): React.JSX.Element {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
