import type * as React from "react";

import { cn } from "../../lib/class-names.ts";

/** Accessible shadcn/ui Textarea primitive. */
export function Textarea({
  className,
  ...props
}: React.ComponentProps<"textarea">): React.JSX.Element {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-24 w-full resize-y rounded-md border border-[var(--line-strong)] bg-white px-3 py-2 font-mono text-sm leading-6 text-[var(--ink)] outline-none placeholder:text-[var(--muted)] focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-[var(--danger)] aria-invalid:ring-2 aria-invalid:ring-[var(--danger-soft)]",
        className
      )}
      {...props}
    />
  );
}
