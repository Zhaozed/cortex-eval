import type * as React from "react";

import { cn } from "../../lib/class-names.ts";

/** Accessible shadcn/ui Input primitive. */
export function Input({
  className,
  type,
  ...props
}: React.ComponentProps<"input">): React.JSX.Element {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full rounded-md border border-[var(--line-strong)] bg-white px-3 py-2 text-sm text-[var(--ink)] shadow-[0_1px_0_rgba(15,35,52,0.04)] outline-none placeholder:text-[var(--muted)] focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-[var(--danger)] aria-invalid:ring-2 aria-invalid:ring-[var(--danger-soft)]",
        className
      )}
      {...props}
    />
  );
}
