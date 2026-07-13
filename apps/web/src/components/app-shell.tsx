import {
  Activity,
  Beaker,
  Bot,
  Braces,
  FlaskConical,
  Gauge,
  Network,
  type LucideIcon
} from "lucide-react";
import type { MouseEvent, ReactElement, ReactNode } from "react";

import { CURRENT_FEATURES } from "../features/feature-registry.ts";
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
  runs: Activity,
  "test-suites": FlaskConical,
  "endpoint-configs": Network,
  "llm-configs": Bot,
  "rubric-prompts": Beaker,
  "analysis-prompts": Braces
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
      event.shiftKey
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
            <span className="brand-mark" aria-hidden="true">
              {message("app.brandMark")}
            </span>
            <div>
              <p className="brand-name">{message("app.brand")}</p>
              <p className="brand-subtitle">{message("app.subtitle")}</p>
            </div>
          </div>
          <nav aria-label={message("navigation.label")} className="primary-nav">
            {CURRENT_FEATURES.map((feature) => {
              const Icon = ICONS[feature.id];
              if (Icon === undefined) return null;
              const active =
                feature.path === "/"
                  ? activePath === "/"
                  : activePath === feature.path || activePath.startsWith(`${feature.path}/`);
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
