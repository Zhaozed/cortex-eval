import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../../lib/class-names.ts";

const alertVariants = cva(
  "relative grid w-full grid-cols-[0_1fr] items-start gap-y-1 rounded-md border px-4 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5",
  {
    variants: {
      variant: {
        default: "border-[var(--line-strong)] bg-white text-[var(--ink)]",
        destructive: "border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger-dark)]"
      }
    },
    defaultVariants: { variant: "default" }
  }
);

/** shadcn/ui Alert primitive. */
export function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>): React.JSX.Element {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

/** shadcn/ui Alert title. */
export function AlertTitle({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="alert-title"
      className={cn("col-start-2 font-semibold", className)}
      {...props}
    />
  );
}

/** shadcn/ui Alert description. */
export function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="alert-description"
      className={cn("col-start-2 text-sm leading-5 text-current/80", className)}
      {...props}
    />
  );
}
