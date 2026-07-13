import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type * as React from "react";

import { cn } from "../../lib/class-names.ts";

/** shadcn/ui Select root. */
export function Select(
  props: React.ComponentProps<typeof SelectPrimitive.Root>
): React.JSX.Element {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

/** shadcn/ui Select group. */
export function SelectGroup(
  props: React.ComponentProps<typeof SelectPrimitive.Group>
): React.JSX.Element {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

/** shadcn/ui Select value. */
export function SelectValue(
  props: React.ComponentProps<typeof SelectPrimitive.Value>
): React.JSX.Element {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

/** shadcn/ui Select trigger. */
export function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>): React.JSX.Element {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "flex h-10 w-full items-center justify-between gap-2 rounded-md border border-[var(--line-strong)] bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 opacity-60" aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/** shadcn/ui Select content. */
export function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>): React.JSX.Element {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        className={cn(
          "relative z-[70] max-h-80 min-w-[8rem] overflow-hidden rounded-md border border-[var(--line-strong)] bg-white text-[var(--ink)] shadow-xl data-[state=closed]:animate-out data-[state=open]:animate-in",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
          className
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-7 items-center justify-center">
          <ChevronUp className="size-4" aria-hidden="true" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-7 items-center justify-center">
          <ChevronDown className="size-4" aria-hidden="true" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

/** shadcn/ui Select label. */
export function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>): React.JSX.Element {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("px-2 py-1.5 text-xs font-semibold text-[var(--muted)]", className)}
      {...props}
    />
  );
}

/** shadcn/ui Select item. */
export function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>): React.JSX.Element {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default select-none items-center rounded py-2 pl-8 pr-2 text-sm outline-none focus:bg-[var(--paper-deep)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      {...props}
    >
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-4" aria-hidden="true" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

/** shadcn/ui Select separator. */
export function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>): React.JSX.Element {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("-mx-1 my-1 h-px bg-[var(--line)]", className)}
      {...props}
    />
  );
}
