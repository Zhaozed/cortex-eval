import type { ReactElement } from "react";
import { ArrowUpRight, Cable, ScanSearch, SlidersHorizontal, Sparkles } from "lucide-react";
import { message } from "../../messages/messages.ts";

/** Group existing configuration pages without changing their CRUD contracts. */
export function ConfigurationHome({
  onNavigate
}: {
  readonly onNavigate: (path: string) => void;
}): ReactElement {
  return (
    <section className="page-stack management-page configuration-home">
      <header className="page-header">
        <div>
          <p className="eyebrow">WORKSPACE / CONFIGURATION</p>
          <h1>{message("workspace.configurations")}</h1>
          <p>{message("workspace.configurationsHelp")}</p>
        </div>
      </header>
      {[
        {
          title: "连接与模型",
          description: "连接被测服务，选择评分与分析使用的模型。",
          items: [
            {
              path: "/endpoint-configs",
              label: "navigation.endpoints",
              help: "workspace.endpointHelp",
              Icon: Cable,
              kind: "ENDPOINT"
            },
            {
              path: "/llm-configs",
              label: "navigation.llms",
              help: "workspace.llmHelp",
              Icon: Sparkles,
              kind: "MODEL"
            }
          ] as const
        },
        {
          title: "评测与分析规则",
          description: "定义如何评分，以及如何辅助分析失败。",
          items: [
            {
              path: "/rubric-prompts",
              label: "navigation.rubricPrompts",
              help: "workspace.rubricHelp",
              Icon: SlidersHorizontal,
              kind: "RUBRIC"
            },
            {
              path: "/analysis-prompts",
              label: "navigation.analysisPrompts",
              help: "workspace.analysisHelp",
              Icon: ScanSearch,
              kind: "ANALYSIS"
            }
          ] as const
        }
      ].map((group) => (
        <section className="configuration-group" key={group.title}>
          <div className="configuration-group-heading">
            <h2>{group.title}</h2>
            <p>{group.description}</p>
          </div>
          <div className="configuration-grid">
            {group.items.map(({ path, label, help, Icon, kind }) => (
              <a
                className="configuration-card"
                key={path}
                href={path}
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  onNavigate(path);
                }}
              >
                <div className="configuration-card-top">
                  <span className="configuration-icon">
                    <Icon size={20} aria-hidden="true" />
                  </span>
                  <ArrowUpRight size={17} aria-hidden="true" />
                </div>
                <h3>{message(label)}</h3>
                <p>{message(help)}</p>
                <span className="configuration-card-kind">{kind}</span>
              </a>
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}
