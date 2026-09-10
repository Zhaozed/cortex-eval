import type { ReactElement } from "react";
import type { RunApi } from "../../lib/run-api.ts";
import { RunDashboardPage } from "../runs/run-dashboard-page.tsx";

/** A stable default dashboard for every platform Run, independent of artifact readiness. */
export function RunWorkspacePage(props: {
  readonly api: RunApi;
  readonly runId: string;
  readonly onNavigate: (path: string) => void;
}): ReactElement {
  return <RunDashboardPage {...props} />;
}
