import * as LabelPrimitive from "@radix-ui/react-label";
import type * as React from "react";

import { cn } from "../../lib/class-names.ts";

/** Accessible shadcn/ui Label primitive. */
export function Label({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>): React.JSX.Element {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm font-semibold leading-none text-[var(--ink)] peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}
