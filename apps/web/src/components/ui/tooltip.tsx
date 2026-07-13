import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type * as React from "react";

import { cn } from "../../lib/class-names.ts";

/** shadcn/ui Tooltip provider. */
export function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>): React.JSX.Element {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

/** shadcn/ui Tooltip root. */
export function Tooltip(
  props: React.ComponentProps<typeof TooltipPrimitive.Root>
): React.JSX.Element {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

/** shadcn/ui Tooltip trigger. */
export function TooltipTrigger(
  props: React.ComponentProps<typeof TooltipPrimitive.Trigger>
): React.JSX.Element {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

/** shadcn/ui Tooltip content. */
export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>): React.JSX.Element {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 rounded bg-[var(--ink)] px-3 py-1.5 text-xs text-white shadow-lg",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="fill-[var(--ink)]" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
