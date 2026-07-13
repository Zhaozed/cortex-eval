import { useEffect } from "react";

/** Notify the application shell when the current page cannot be left safely. */
export function usePageLeaveBlocker(
  blocked: boolean,
  onLeaveBlockedChange: ((blocked: boolean) => void) | undefined
): void {
  useEffect(() => {
    onLeaveBlockedChange?.(blocked);
  }, [blocked, onLeaveBlockedChange]);

  useEffect(
    () => (): void => {
      onLeaveBlockedChange?.(false);
    },
    [onLeaveBlockedChange]
  );
}
