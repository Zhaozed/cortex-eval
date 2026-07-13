import type * as React from "react";

import { cn } from "../../lib/class-names.ts";

/** shadcn/ui responsive Table container. */
export function Table({ className, ...props }: React.ComponentProps<"table">): React.JSX.Element {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

/** shadcn/ui Table header. */
export function TableHeader({
  className,
  ...props
}: React.ComponentProps<"thead">): React.JSX.Element {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

/** shadcn/ui Table body. */
export function TableBody({
  className,
  ...props
}: React.ComponentProps<"tbody">): React.JSX.Element {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

/** shadcn/ui Table footer. */
export function TableFooter({
  className,
  ...props
}: React.ComponentProps<"tfoot">): React.JSX.Element {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t bg-[var(--paper-deep)] font-medium", className)}
      {...props}
    />
  );
}

/** shadcn/ui Table row. */
export function TableRow({ className, ...props }: React.ComponentProps<"tr">): React.JSX.Element {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-[var(--line)] transition-colors hover:bg-[var(--paper-deep)] data-[state=selected]:bg-[var(--paper-deep)]",
        className
      )}
      {...props}
    />
  );
}

/** shadcn/ui Table column header. */
export function TableHead({ className, ...props }: React.ComponentProps<"th">): React.JSX.Element {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-11 px-3 text-left align-middle text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--muted)]",
        className
      )}
      {...props}
    />
  );
}

/** shadcn/ui Table data cell. */
export function TableCell({ className, ...props }: React.ComponentProps<"td">): React.JSX.Element {
  return (
    <td
      data-slot="table-cell"
      className={cn("px-3 py-3 align-middle text-[var(--ink-soft)]", className)}
      {...props}
    />
  );
}

/** shadcn/ui Table caption. */
export function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">): React.JSX.Element {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-[var(--muted)]", className)}
      {...props}
    />
  );
}
