import {
  Activity,
  Cable,
  FlaskConical,
  Gauge,
  ScanSearch,
  SlidersHorizontal,
  Sparkles,
  Workflow,
  type LucideIcon
} from "lucide-react";
import type { MouseEvent, ReactElement, ReactNode } from "react";

import { CURRENT_FEATURES, NAVIGATION_GROUPS } from "../features/feature-registry.ts";
import { message, type MessageKey } from "../messages/messages.ts";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip.tsx";

/** Application shell properties. */
export interface AppShellProps {
  /** Current pathname used for active navigation state. */
  readonly activePath: string;
  /** Explicit same-document navigation callback. */
  readonly onNavigate: (path: string) => void;
  /** Current closed Feature page. */
  readonly children: ReactNode;
}

const ICONS: Readonly<Record<string, LucideIcon>> = {
  dashboard: Gauge,
  "endpoint-configs": Cable,
  "llm-configs": Sparkles,
  "rubric-prompts": SlidersHorizontal,
  "analysis-prompts": ScanSearch,
  runs: Activity,
  "test-suites": FlaskConical
};

// Convert one registry label key into the typed UI catalog key.
function navigationLabel(key: string): string {
  return message(key as MessageKey);
}

/** Desktop-first shell with capability-derived navigation. */
export function AppShell({ activePath, onNavigate, children }: AppShellProps): ReactElement {
  const navigate = (event: MouseEvent<HTMLAnchorElement>, path: string): void => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    onNavigate(path);
  };

  return (
    <TooltipProvider>
      <a className="skip-link" href="#main-content">
        {message("app.skipToContent")}
      </a>
      <main className="small-screen-guard">
        <Alert>
          <AlertTitle>
            <h1>{message("viewport.title")}</h1>
          </AlertTitle>
          <AlertDescription>{message("viewport.message")}</AlertDescription>
        </Alert>
      </main>
      <div className="app-frame">
        <aside className="lab-sidebar">
          <div className="brand-block">
            <Workflow className="brand-symbol" aria-hidden="true" />
            <div>
              <p className="brand-name">
                Cortex <span>Eval</span>
              </p>
              <p className="brand-subtitle">Agent 评测工作台</p>
            </div>
          </div>
          <nav aria-label={message("navigation.label")} className="primary-nav">
            {NAVIGATION_GROUPS.map((group) => (
              <section className="nav-group" key={group.id} aria-labelledby={`nav-${group.id}`}>
                <h2 className="nav-section-label" id={`nav-${group.id}`}>
                  {message(group.labelKey)}
                </h2>
                {CURRENT_FEATURES.filter((feature) => feature.group === group.id).map((feature) => {
                  const Icon = ICONS[feature.id];
                  if (Icon === undefined) return null;
                  const active =
                    feature.path === "/"
                      ? activePath === "/"
                      : (feature.id === "runs" && activePath.startsWith("/a2ui-reviews")) ||
                        activePath === feature.path ||
                        activePath.startsWith(`${feature.path}/`);
                  return (
                    <a
                      key={feature.id}
                      href={feature.path}
                      aria-current={active ? "page" : undefined}
                      className="nav-link"
                      onClick={(event) => navigate(event, feature.path)}
                    >
                      <Icon aria-hidden="true" />
                      <span>{navigationLabel(feature.labelKey)}</span>
                    </a>
                  );
                })}
              </section>
            ))}
          </nav>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="local-status" tabIndex={0}>
                <span className="status-pulse" aria-hidden="true" />
                <span>{message("app.localStatus")}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>{message("app.localStatus")}</TooltipContent>
          </Tooltip>
        </aside>
        <main id="main-content" className="main-canvas" tabIndex={-1}>
          {children}
        </main>
      </div>
    </TooltipProvider>
  );
}
