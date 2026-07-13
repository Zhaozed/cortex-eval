import * as ToastPrimitive from "@radix-ui/react-toast";
import { X } from "lucide-react";
import type * as React from "react";

import { cn } from "../../lib/class-names.ts";
import { message } from "../../messages/messages.ts";

/** shadcn/ui Toast provider. */
export function ToastProvider(
  props: React.ComponentProps<typeof ToastPrimitive.Provider>
): React.JSX.Element {
  return <ToastPrimitive.Provider swipeDirection="right" {...props} />;
}

/** shadcn/ui Toast viewport. */
export function ToastViewport({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Viewport>): React.JSX.Element {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn(
        "fixed bottom-0 right-0 z-[100] flex max-h-screen w-full flex-col gap-2 p-4 sm:max-w-sm",
        className
      )}
      {...props}
    />
  );
}

/** shadcn/ui Toast root. */
export function Toast({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Root>): React.JSX.Element {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      className={cn(
        "relative flex items-start gap-3 rounded-md border border-[var(--line-strong)] bg-white p-4 pr-10 text-[var(--ink)] shadow-xl",
        className
      )}
      {...props}
    />
  );
}

/** shadcn/ui Toast title. */
export function ToastTitle({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Title>): React.JSX.Element {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn("text-sm font-semibold", className)}
      {...props}
    />
  );
}

/** shadcn/ui Toast description. */
export function ToastDescription({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Description>): React.JSX.Element {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      className={cn("text-sm text-[var(--muted)]", className)}
      {...props}
    />
  );
}

/** shadcn/ui Toast close control. */
export function ToastClose({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Close>): React.JSX.Element {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      aria-label={message("common.close")}
      className={cn(
        "absolute right-2 top-2 rounded p-1 text-[var(--muted)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        className
      )}
      {...props}
    >
      <X className="size-4" aria-hidden="true" />
    </ToastPrimitive.Close>
  );
}
