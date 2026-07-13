import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type * as React from "react";

import { cn } from "../../lib/class-names.ts";
import { message } from "../../messages/messages.ts";

/** shadcn/ui Sheet root. */
export function Sheet(props: React.ComponentProps<typeof DialogPrimitive.Root>): React.JSX.Element {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />;
}

/** shadcn/ui Sheet trigger. */
export function SheetTrigger(
  props: React.ComponentProps<typeof DialogPrimitive.Trigger>
): React.JSX.Element {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

/** shadcn/ui Sheet close control. */
export function SheetClose(
  props: React.ComponentProps<typeof DialogPrimitive.Close>
): React.JSX.Element {
  return <DialogPrimitive.Close data-slot="sheet-close" {...props} />;
}

/** shadcn/ui Sheet portal. */
export function SheetPortal(
  props: React.ComponentProps<typeof DialogPrimitive.Portal>
): React.JSX.Element {
  return <DialogPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

/** shadcn/ui Sheet backdrop. */
export function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>): React.JSX.Element {
  return (
    <DialogPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-[rgba(10,26,38,0.38)] backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=open]:animate-in",
        className
      )}
      {...props}
    />
  );
}

/** shadcn/ui right-side Sheet content. */
export function SheetContent({
  className,
  children,
  side = "right",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  readonly side?: "top" | "right" | "bottom" | "left";
}): React.JSX.Element {
  const positions = {
    top: "inset-x-0 top-0 border-b",
    right: "inset-y-0 right-0 h-full w-[min(720px,92vw)] border-l",
    bottom: "inset-x-0 bottom-0 border-t",
    left: "inset-y-0 left-0 h-full w-[min(720px,92vw)] border-r"
  } as const;
  return (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "fixed z-50 flex max-h-screen flex-col gap-5 overflow-y-auto border-[var(--line-strong)] bg-[var(--paper)] p-6 shadow-2xl outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
          positions[side],
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded p-2 text-[var(--muted)] outline-none hover:bg-[var(--paper-deep)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]">
          <X aria-hidden="true" className="size-4" />
          <span className="sr-only">{message("common.close")}</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </SheetPortal>
  );
}

/** shadcn/ui Sheet header. */
export function SheetHeader({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return <div data-slot="sheet-header" className={cn("grid gap-2 pr-10", className)} {...props} />;
}

/** shadcn/ui Sheet footer. */
export function SheetFooter({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        "mt-auto flex flex-col-reverse gap-2 pt-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  );
}

/** shadcn/ui Sheet title. */
export function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>): React.JSX.Element {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn("font-serif text-2xl font-semibold text-[var(--ink)]", className)}
      {...props}
    />
  );
}

/** shadcn/ui Sheet description. */
export function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>): React.JSX.Element {
  return (
    <DialogPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm leading-6 text-[var(--muted)]", className)}
      {...props}
    />
  );
}
