import * as ProgressPrimitive from "@radix-ui/react-progress";
import type * as React from "react";

import { cn } from "../../lib/class-names.ts";

/** shadcn/ui Progress primitive. */
export function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>): React.JSX.Element {
  const percentage = value ?? 34;
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--line)]",
        className
      )}
      value={value}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full w-full flex-1 bg-[var(--accent)] transition-transform"
        style={{ transform: `translateX(-${100 - percentage}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}
