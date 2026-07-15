import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { AppShell } from "./components/app-shell.tsx";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert.tsx";
import { Button } from "./components/ui/button.tsx";
import { Progress } from "./components/ui/progress.tsx";
import { createResourceApi } from "./lib/resource-api.ts";
import { createRunApi } from "./lib/run-api.ts";
import { resolveWebRoute, type WebRoute } from "./lib/web-route.ts";
import { message } from "./messages/messages.ts";

const DashboardPage = lazy(async () => {
  const feature = await import("./features/dashboard/dashboard-page.tsx");
  return { default: feature.DashboardPage };
});
const TestSuiteListPage = lazy(async () => {
  const feature = await import("./features/test-suites/test-suite-list-page.tsx");
  return { default: feature.TestSuiteListPage };
});
const TestSuiteDetailPage = lazy(async () => {
  const feature = await import("./features/test-suites/test-suite-detail-page.tsx");
  return { default: feature.TestSuiteDetailPage };
});
const ConfigurationListPage = lazy(async () => {
  const feature = await import("./features/configurations/configuration-list-page.tsx");
  return { default: feature.ConfigurationListPage };
});
const RunListPage = lazy(async () => {
  const feature = await import("./features/runs/run-list-page.tsx");
  return { default: feature.RunListPage };
});
const RunDetailPage = lazy(async () => {
  const feature = await import("./features/runs/run-detail-page.tsx");
  return { default: feature.RunDetailPage };
});
const ReportPage = lazy(async () => {
  const feature = await import("./features/reports/report-page.tsx");
  return { default: feature.ReportPage };
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5_000 },
    mutations: { retry: false }
  }
});
const api = createResourceApi();
const runApi = createRunApi();
const HISTORY_POSITION_KEY = "cortexEvalHistoryPosition";

// Resolve the current path after every explicit or browser History navigation.
function currentRoute(): WebRoute | null {
  return resolveWebRoute(window.location.pathname);
}

// Capture the exact same-document location used when initializing owned History state.
function currentLocation(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

// Validate browser-owned state before using its position in navigation arithmetic.
function historyPosition(state: unknown): number | null {
  if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
  const value = (state as Readonly<Record<string, unknown>>)[HISTORY_POSITION_KEY];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Read the browser's absolute same-origin entry index for state owned by another writer.
function navigationIndex(): number | null {
  if (!("navigation" in window)) return null;
  const index = window.navigation.currentEntry?.index;
  return index !== undefined && Number.isSafeInteger(index) && index >= 0 ? index : null;
}

// Preserve unrelated same-document state while assigning one monotonic app position.
function historyState(position: number): Readonly<Record<string, unknown>> {
  const current: unknown = window.history.state;
  const existing =
    typeof current === "object" && current !== null && !Array.isArray(current) ? current : {};
  return { ...existing, [HISTORY_POSITION_KEY]: position };
}

/** Current closed Feature page selected by one validated route. */
function RoutePage({
  route,
  onNavigate,
  onCommittedNavigate,
  onLeaveBlockedChange
}: {
  readonly route: WebRoute | null;
  readonly onNavigate: (path: string) => void;
  readonly onCommittedNavigate: (path: string) => void;
  readonly onLeaveBlockedChange: (blocked: boolean) => void;
}): ReactElement {
  if (route === null) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{message("route.notFoundTitle")}</AlertTitle>
        <AlertDescription>{message("route.notFoundDescription")}</AlertDescription>
        <Button type="button" variant="outline" onClick={() => onNavigate("/")}>
          {message("route.backDashboard")}
        </Button>
      </Alert>
    );
  }
  if (route.kind === "DASHBOARD") {
    return <DashboardPage api={api} runApi={runApi} onNavigate={onNavigate} />;
  }
  if (route.kind === "RUN_LIST") {
    return (
      <RunListPage
        api={runApi}
        resourceApi={api}
        onNavigate={onNavigate}
        onCommittedNavigate={onCommittedNavigate}
        onLeaveBlockedChange={onLeaveBlockedChange}
      />
    );
  }
  if (route.kind === "RUN_DETAIL") {
    return (
      <RunDetailPage key={route.runId} api={runApi} runId={route.runId} onNavigate={onNavigate} />
    );
  }
  if (route.kind === "RUN_REPORT") {
    return (
      <ReportPage key={route.runId} api={runApi} runId={route.runId} onNavigate={onNavigate} />
    );
  }
  if (route.kind === "TEST_SUITE_LIST") {
    return (
      <TestSuiteListPage
        api={api}
        onNavigate={onNavigate}
        onCommittedNavigate={onCommittedNavigate}
        onLeaveBlockedChange={onLeaveBlockedChange}
      />
    );
  }
  if (route.kind === "TEST_SUITE_DETAIL") {
    return (
      <TestSuiteDetailPage
        key={route.suiteId}
        api={api}
        suiteId={route.suiteId}
        onNavigate={onNavigate}
        onCommittedNavigate={onCommittedNavigate}
        onLeaveBlockedChange={onLeaveBlockedChange}
      />
    );
  }
  if (route.kind === "ENDPOINT_CONFIG_LIST") {
    return (
      <ConfigurationListPage
        key="ENDPOINT"
        api={api}
        kind="ENDPOINT"
        onLeaveBlockedChange={onLeaveBlockedChange}
      />
    );
  }
  if (route.kind === "LLM_CONFIG_LIST") {
    return (
      <ConfigurationListPage
        key="LLM"
        api={api}
        kind="LLM"
        onLeaveBlockedChange={onLeaveBlockedChange}
      />
    );
  }
  if (route.kind === "RUBRIC_PROMPT_LIST") {
    return (
      <ConfigurationListPage
        key="LLM_RUBRIC_PROMPT"
        api={api}
        kind="LLM_RUBRIC_PROMPT"
        onLeaveBlockedChange={onLeaveBlockedChange}
      />
    );
  }
  return (
    <ConfigurationListPage
      key="CASE_ANALYSIS_PROMPT"
      api={api}
      kind="CASE_ANALYSIS_PROMPT"
      onLeaveBlockedChange={onLeaveBlockedChange}
    />
  );
}

/** Current application mounted only after browser navigation capability validation. */
function ResourceApp({
  initialNavigationIndex
}: {
  readonly initialNavigationIndex: number;
}): ReactElement {
  const [route, setRoute] = useState(currentRoute);
  const leaveBlockedRef = useRef(false);
  const historyPositionRef = useRef(0);
  const navigationIndexRef = useRef(initialNavigationIndex);

  const onLeaveBlockedChange = useCallback((blocked: boolean): void => {
    leaveBlockedRef.current = blocked;
  }, []);

  useEffect(() => {
    const initialPosition = historyPosition(window.history.state) ?? 0;
    historyPositionRef.current = initialPosition;
    if (historyPosition(window.history.state) === null) {
      window.history.replaceState(historyState(initialPosition), "", currentLocation());
    }
    const restore = (): void => {
      const targetPosition = historyPosition(window.history.state);
      const targetNavigationIndex = navigationIndex();
      if (leaveBlockedRef.current) {
        let delta = 0;
        if (targetPosition !== null) {
          delta = historyPositionRef.current - targetPosition;
        } else if (targetNavigationIndex !== null) {
          delta = navigationIndexRef.current - targetNavigationIndex;
        }
        if (delta !== 0) window.history.go(delta);
        return;
      }
      if (targetPosition !== null) historyPositionRef.current = targetPosition;
      if (targetNavigationIndex !== null) navigationIndexRef.current = targetNavigationIndex;
      setRoute(currentRoute());
    };
    const preventUnload = (event: BeforeUnloadEvent): void => {
      if (!leaveBlockedRef.current) return;
      event.preventDefault();
    };
    window.addEventListener("popstate", restore);
    window.addEventListener("beforeunload", preventUnload);
    return (): void => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("beforeunload", preventUnload);
    };
  }, []);

  // Push one closed Feature path and update the local route view.
  const pushRoute = (path: string): void => {
    const nextPosition = historyPositionRef.current + 1;
    window.history.pushState(historyState(nextPosition), "", path);
    historyPositionRef.current = nextPosition;
    const nextNavigationIndex = navigationIndex();
    if (nextNavigationIndex !== null) navigationIndexRef.current = nextNavigationIndex;
    setRoute(currentRoute());
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  const navigate = (path: string): void => {
    if (leaveBlockedRef.current) return;
    pushRoute(path);
  };
  const navigateAfterCommit = (path: string): void => {
    leaveBlockedRef.current = false;
    pushRoute(path);
  };

  return (
    <QueryClientProvider client={queryClient}>
      <AppShell activePath={window.location.pathname} onNavigate={navigate}>
        <Suspense fallback={<Progress aria-label={message("route.loading")} />}>
          <RoutePage
            route={route}
            onNavigate={navigate}
            onCommittedNavigate={navigateAfterCommit}
            onLeaveBlockedChange={onLeaveBlockedChange}
          />
        </Suspense>
      </AppShell>
    </QueryClientProvider>
  );
}

// Explain the fail-closed browser capability boundary without exposing resource actions.
function UnsupportedBrowser(): ReactElement {
  return (
    <main className="main-canvas" id="main-content" tabIndex={-1}>
      <Alert variant="destructive">
        <AlertTitle>
          <h1>{message("browser.unsupportedTitle")}</h1>
        </AlertTitle>
        <AlertDescription>{message("browser.unsupportedDescription")}</AlertDescription>
      </Alert>
    </main>
  );
}

/** Root P5 Web application with a fail-closed Navigation API boundary. */
export function App(): ReactElement {
  const initialNavigationIndex = navigationIndex();
  if (initialNavigationIndex === null) return <UnsupportedBrowser />;
  return <ResourceApp initialNavigationIndex={initialNavigationIndex} />;
}
