import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional shadcn/ui class names without conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
