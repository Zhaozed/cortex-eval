import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import type * as React from "react";

import { cn } from "../../lib/class-names.ts";
import { Button } from "./button.tsx";

/** shadcn/ui AlertDialog root. */
export function AlertDialog(
  props: React.ComponentProps<typeof AlertDialogPrimitive.Root>
): React.JSX.Element {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

/** shadcn/ui AlertDialog trigger. */
export function AlertDialogTrigger(
  props: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>
): React.JSX.Element {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

/** shadcn/ui AlertDialog portal. */
export function AlertDialogPortal(
  props: React.ComponentProps<typeof AlertDialogPrimitive.Portal>
): React.JSX.Element {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

/** shadcn/ui AlertDialog backdrop. */
export function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>): React.JSX.Element {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn("fixed inset-0 z-[80] bg-[rgba(10,26,38,0.5)] backdrop-blur-[2px]", className)}
      {...props}
    />
  );
}

/** shadcn/ui AlertDialog content. */
export function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>): React.JSX.Element {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          "fixed left-1/2 top-1/2 z-[90] grid w-[min(520px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 gap-5 rounded-md border border-[var(--line-strong)] bg-[var(--paper)] p-6 shadow-2xl outline-none",
          className
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

/** shadcn/ui AlertDialog header. */
export function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return <div data-slot="alert-dialog-header" className={cn("grid gap-2", className)} {...props} />;
}

/** shadcn/ui AlertDialog footer. */
export function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn("flex justify-end gap-2", className)}
      {...props}
    />
  );
}

/** shadcn/ui AlertDialog title. */
export function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>): React.JSX.Element {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("font-serif text-2xl font-semibold", className)}
      {...props}
    />
  );
}

/** shadcn/ui AlertDialog description. */
export function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>): React.JSX.Element {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-sm leading-6 text-[var(--muted)]", className)}
      {...props}
    />
  );
}

/** shadcn/ui destructive AlertDialog action. */
export function AlertDialogAction({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action>): React.JSX.Element {
  return (
    <Button asChild variant="destructive">
      <AlertDialogPrimitive.Action
        data-slot="alert-dialog-action"
        className={className}
        {...props}
      />
    </Button>
  );
}

/** shadcn/ui AlertDialog cancel action. */
export function AlertDialogCancel({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>): React.JSX.Element {
  return (
    <Button asChild variant="outline">
      <AlertDialogPrimitive.Cancel
        data-slot="alert-dialog-cancel"
        className={className}
        {...props}
      />
    </Button>
  );
}
