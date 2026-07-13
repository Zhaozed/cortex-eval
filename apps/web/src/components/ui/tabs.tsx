import * as TabsPrimitive from "@radix-ui/react-tabs";
import type * as React from "react";

import { cn } from "../../lib/class-names.ts";

/** shadcn/ui Tabs root. */
export function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>): React.JSX.Element {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-4", className)}
      {...props}
    />
  );
}

/** shadcn/ui Tabs list. */
export function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>): React.JSX.Element {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "inline-flex h-10 w-fit items-center rounded-md border border-[var(--line)] bg-[var(--paper-deep)] p-1 text-[var(--muted)]",
        className
      )}
      {...props}
    />
  );
}

/** shadcn/ui Tabs trigger. */
export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>): React.JSX.Element {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex h-8 flex-1 items-center justify-center rounded px-3 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-white data-[state=active]:text-[var(--ink)] data-[state=active]:shadow-sm",
        className
      )}
      {...props}
    />
  );
}

/** shadcn/ui Tabs content. */
export function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>): React.JSX.Element {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn(
        "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        className
      )}
      {...props}
    />
  );
}
