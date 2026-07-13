import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type * as React from "react";

import { cn } from "../../lib/class-names.ts";
import { message } from "../../messages/messages.ts";

/** shadcn/ui Dialog root. */
export function Dialog(
  props: React.ComponentProps<typeof DialogPrimitive.Root>
): React.JSX.Element {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

/** shadcn/ui Dialog trigger. */
export function DialogTrigger(
  props: React.ComponentProps<typeof DialogPrimitive.Trigger>
): React.JSX.Element {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

/** shadcn/ui Dialog close control. */
export function DialogClose(
  props: React.ComponentProps<typeof DialogPrimitive.Close>
): React.JSX.Element {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/** shadcn/ui Dialog portal. */
export function DialogPortal(
  props: React.ComponentProps<typeof DialogPrimitive.Portal>
): React.JSX.Element {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

/** shadcn/ui Dialog backdrop. */
export function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>): React.JSX.Element {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn("fixed inset-0 z-[80] bg-[rgba(10,26,38,0.46)] backdrop-blur-[2px]", className)}
      {...props}
    />
  );
}

/** shadcn/ui centered Dialog content. */
export function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  readonly showCloseButton?: boolean;
}): React.JSX.Element {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed left-1/2 top-1/2 z-[90] grid w-[min(520px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 gap-5 rounded-md border border-[var(--line-strong)] bg-[var(--paper)] p-6 shadow-2xl outline-none",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded p-2 text-[var(--muted)] outline-none hover:bg-[var(--paper-deep)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]">
            <X aria-hidden="true" className="size-4" />
            <span className="sr-only">{message("common.close")}</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

/** shadcn/ui Dialog header. */
export function DialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return <div data-slot="dialog-header" className={cn("grid gap-2", className)} {...props} />;
}

/** shadcn/ui Dialog footer. */
export function DialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div data-slot="dialog-footer" className={cn("flex justify-end gap-2", className)} {...props} />
  );
}

/** shadcn/ui Dialog title. */
export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>): React.JSX.Element {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-serif text-2xl font-semibold", className)}
      {...props}
    />
  );
}

/** shadcn/ui Dialog description. */
export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>): React.JSX.Element {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm leading-6 text-[var(--muted)]", className)}
      {...props}
    />
  );
}
