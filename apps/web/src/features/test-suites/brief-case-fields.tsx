import { useState, type ReactElement } from "react";
import {
  BriefBundleV1Schema,
  BriefReplayRequestSchema,
  type BriefEvaluationProfile
} from "@cortex-eval/contracts/src/brief-evaluation-contracts.ts";
import type { SemanticEvaluationContractV1 } from "@cortex-eval/contracts/src/semantic-evaluation-contracts.ts";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";

export function newBriefContract(briefType: "daily" | "meeting"): SemanticEvaluationContractV1 {
  return {
    contractVersion: "cortex.semantic-evaluation-contract.v1",
    goal: `生成准确、相关的 ${briefType === "daily" ? "Daily" : "Meeting"} Brief`,
    successCriteria: ["关键事实准确覆盖、排除无关信息、不捏造"],
    enabledDimensions: ["response"],
    scorePassThreshold: 0.85,
    brief: {
      briefType,
      judge: "JEV",
      checklist: [],
      constraints: { allowedGenerationStatuses: ["generated"] }
    }
  };
}

/** Accept a bundle, a replay request or a successful snapshot response; never import GT into input. */
export function parseBriefImport(text: string): ReturnType<typeof BriefReplayRequestSchema.parse> {
  const value: unknown = JSON.parse(text);
  const replay = BriefReplayRequestSchema.safeParse(value);
  if (replay.success) return replay.data;
  const envelope = value as { ok?: unknown; parsed_output?: { bundle?: unknown } } | null;
  const bundle = BriefBundleV1Schema.parse(
    envelope?.ok === true ? envelope.parsed_output?.bundle : value
  );
  return { bundle, timeout_seconds: 120 };
}

/** Brief mode uses the existing Case and request editor, with an atomic checklist beside the bundle. */
export function BriefCaseFields({
  value,
  onChange,
  onImport
}: {
  readonly value: SemanticEvaluationContractV1 | undefined;
  readonly onChange: (value: SemanticEvaluationContractV1 | undefined) => void;
  readonly onImport: (text: string) => void;
}): ReactElement {
  const [importText, setImportText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const profile = value?.brief;
  const update = (next: BriefEvaluationProfile): void => {
    if (value) onChange({ ...value, brief: next });
  };
  const importBundle = (text: string): void => {
    try {
      const request = parseBriefImport(text);
      if (profile && request.bundle.brief_type !== profile.briefType) {
        setError("材料类型与所选 Brief 类型不符；请先切换类型。");
        return;
      }
      onImport(JSON.stringify(request, null, 2));
      setError(null);
      setImportText("");
    } catch {
      setError("导入失败：需要 Bundle、replay 请求或成功的 snapshot 响应 JSON；不能包含 GT。");
    }
  };
  return (
    <section className="case-editor-section field-wide" aria-label="Brief 内容评测">
      <label htmlFor="brief-mode">评测模式</label>
      <select
        id="brief-mode"
        value={profile ? "brief" : "agent"}
        onChange={(e) =>
          onChange(e.target.value === "brief" ? newBriefContract("daily") : undefined)
        }
      >
        <option value="agent">Agent 链路评测</option>
        <option value="brief">Brief 内容评测</option>
      </select>
      <p className="field-hint">切换模式会替换语义规则，不修改请求材料及通用检查项。</p>
      {profile && (
        <>
          <label htmlFor="brief-judge">内容裁判</label>
          <select
            id="brief-judge"
            value={profile.judge ?? "JEV"}
            onChange={(e) =>
              onChange({ ...value, brief: { ...profile, judge: e.target.value as "JEV" | "LLM" } })
            }
          >
            <option value="JEV">JEV</option>
            <option value="LLM">LLM（使用 Run 的 Evaluator 模型）</option>
          </select>
          <p className="field-hint">
            {profile.judge === "LLM"
              ? "创建 Run 时选择 Evaluator 模型。该配置会冻结到 Run；不使用 JEV，也不会失败后切换裁判。"
              : "使用服务端已有 JEV 配置；Run 的 Evaluator 模型不会替换 JEV。"}
            两种裁判共用下方 GT、证据校验和打分规则。
          </p>
          <label htmlFor="brief-type">Brief 类型</label>
          <select
            id="brief-type"
            value={profile.briefType}
            onChange={(e) =>
              onChange({
                ...value,
                goal: `生成准确、相关的 ${e.target.value} Brief`,
                brief: { ...profile, briefType: e.target.value as "daily" | "meeting" }
              })
            }
          >
            <option value="daily">Daily Brief</option>
            <option value="meeting">Meeting Brief</option>
          </select>
          <p>
            Endpoint 选择 Cortex Brief
            replay（/eval/e2e/brief/replay），两类共用地址。运行仅使用下方冻结材料，不重新抓取。
          </p>
          <label htmlFor="brief-import-file">导入材料 JSON 文件</label>
          <Input
            id="brief-import-file"
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void file
                  .text()
                  .then(importBundle)
                  .catch(() => setError("文件读取失败"));
              e.target.value = "";
            }}
          />
          <label htmlFor="brief-import-text">或粘贴材料 JSON</label>
          <Textarea
            id="brief-import-text"
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={4}
          />
          <Button type="button" variant="outline" onClick={() => importBundle(importText)}>
            导入并替换请求材料
          </Button>
          {error && <p role="alert">{error}</p>}
          {profile.rubric === undefined && (
          <>
          <h3>原子 GT</h3>
          <p>
            P0 必须覆盖；P1 补充；P2 应排除。来源填写相对 bundle 的 JSON
            pointer（每行一个）。请按全部材料标注，不只看模型裁剪后的输入。
          </p>
          <div className="brief-table-scroll">
            <table className="brief-checklist">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>层级</th>
                  <th>原子事实 / 禁止内容</th>
                  <th>材料来源</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {(profile.checklist ?? []).map((item, index) => {
                  const patch = (part: Partial<typeof item>): void =>
                    update({
                      ...profile,
                      checklist: (profile.checklist ?? []).map((old, i) =>
                        i === index ? { ...old, ...part } : old
                      )
                    });
                  return (
                    <tr key={index}>
                      <td>
                        <Input
                          aria-label={`原子ID ${index + 1}`}
                          value={item.id}
                          onChange={(e) => patch({ id: e.target.value })}
                        />
                      </td>
                      <td>
                        <select
                          aria-label={`层级 ${index + 1}`}
                          value={item.tier}
                          onChange={(e) => patch({ tier: e.target.value as typeof item.tier })}
                        >
                          {["P0", "P1", "P2"].map((tier) => (
                            <option key={tier}>{tier}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <Textarea
                          aria-label={`断言 ${index + 1}`}
                          value={item.assertion}
                          onChange={(e) => patch({ assertion: e.target.value })}
                        />
                      </td>
                      <td>
                        <Textarea
                          aria-label={`来源 ${index + 1}`}
                          value={item.sourceRefs.join("\n")}
                          onChange={(e) => patch({ sourceRefs: e.target.value.split("\n") })}
                        />
                      </td>
                      <td>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() =>
                            update({
                              ...profile,
                              checklist: (profile.checklist ?? []).filter((_, i) => i !== index)
                            })
                          }
                        >
                          删除
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              update({
                ...profile,
                checklist: [
                  ...(profile.checklist ?? []),
                  {
                    id: `fact_${crypto.randomUUID().slice(0, 8)}`,
                    tier: "P0",
                    assertion: "",
                    sourceRefs: ["/material/snapshot"]
                  }
                ]
              })
            }
          >
            添加原子断言
          </Button>
          </>
          )}
          <h3>确定性检查与计分</h3>
          <p>
            P0 50% / P1 20% / 噪音抑制 30%；空层级权重归一化。噪音抑制为 P2
            与全局无关信息检查的平均值。证实幻觉才置零；UNKNOWN 为评测异常，需复核。
          </p>
          <label htmlFor="brief-threshold">语义通过阈值（0–1）</label>
          <Input
            id="brief-threshold"
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={value.scorePassThreshold ?? 0.85}
            onChange={(e) => onChange({ ...value, scorePassThreshold: Number(e.target.value) })}
          />
          <div className="brief-constraints">
            {(
              [
                ["minCards", "最少卡片数"],
                ["maxCards", "最多卡片数"],
                ["maxCardChars", "每卡字符上限"],
                ["maxTextChars", "全文字符上限"]
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <Input
                  type="number"
                  min={key.includes("Chars") ? 1 : 0}
                  value={profile.constraints[key] ?? ""}
                  onChange={(e) => {
                    const { [key]: removed, ...rest } = profile.constraints;
                    void removed;
                    const constraints =
                      e.target.value === "" ? rest : { ...rest, [key]: Number(e.target.value) };
                    update({ ...profile, constraints });
                  }}
                />
              </label>
            ))}
          </div>
          <p className="field-hint">
            留空表示不限制；字符按 Unicode 码点计，卡片按全部字符串值累计，不含字段名。
          </p>
          <fieldset>
            <legend>允许的生成状态（至少选一个）</legend>
            {(["generated", "empty", "fact_only_fallback"] as const).map((status) => (
              <label key={status}>
                <input
                  type="checkbox"
                  checked={profile.constraints.allowedGenerationStatuses.includes(status)}
                  onChange={(e) =>
                    update({
                      ...profile,
                      constraints: {
                        ...profile.constraints,
                        allowedGenerationStatuses: e.target.checked
                          ? [...profile.constraints.allowedGenerationStatuses, status]
                          : profile.constraints.allowedGenerationStatuses.filter(
                              (v) => v !== status
                            )
                      }
                    })
                  }
                />
                {status}
              </label>
            ))}
          </fieldset>
        </>
      )}
    </section>
  );
}
