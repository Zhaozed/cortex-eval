import type { AgentAuthoringRule } from "@cortex-eval/contracts/src/assertion-rules/agent-rule-authoring.ts";
import type { AgentExecutionExpectation } from "@cortex-eval/contracts/src/assertion-rules/agent-rules.ts";
import type { JsonValue } from "@cortex-eval/contracts/src/contracts-primitives.ts";
import { useState, type ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { CaseValueFields } from "./case-value-fields.tsx";
import { CaseNumberInput } from "./case-number-input.tsx";

export const emptyExecution = (): AgentExecutionExpectation => ({
  tool: "",
  args: {},
  outcome: "success"
});

function StringList({
  label,
  values,
  onChange
}: {
  readonly label: string;
  readonly values: readonly string[];
  readonly onChange: (v: string[]) => void;
}): ReactElement {
  return (
    <div className="case-rule-string-list">
      <span className="case-control-label">{label}</span>
      {values.map((value, i) => (
        <div className="case-inline-field" key={i}>
          <Input
            data-guided-target
            aria-label={`${label} ${i + 1}`}
            value={value}
            required
            onChange={(e) => onChange(values.map((v, n) => (n === i ? e.currentTarget.value : v)))}
          />
          <Button
            type="button"
            variant="ghost"
            aria-label={`删除${label} ${i + 1}`}
            onClick={() => onChange(values.filter((_, n) => n !== i))}
          >
            移除
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" onClick={() => onChange([...values, ""])}>
        ＋ 添加{label}
      </Button>
    </div>
  );
}

/** Typed result path rows; map keys never silently overwrite an existing path. */
function ResultMap({
  label,
  value,
  kind,
  onChange
}: {
  readonly label: string;
  readonly value: Readonly<Record<string, JsonValue>>;
  readonly kind: "value" | "set" | "instant";
  readonly onChange: (v: Record<string, JsonValue>) => void;
}): ReactElement {
  const [key, setKey] = useState("");
  const path = key.trim();
  const duplicate = Object.hasOwn(value, path);
  return (
    <div className="case-result-map">
      <h4>{label}</h4>
      {Object.entries(value).map(([path, expected]) => (
        <div className="case-result-row" key={path}>
          <div className="case-result-path">
            <code>{path}</code>
            <Button
              type="button"
              variant="ghost"
              aria-label={`删除${label} ${path}`}
              onClick={() =>
                onChange(Object.fromEntries(Object.entries(value).filter(([k]) => k !== path)))
              }
            >
              移除
            </Button>
          </div>
          {kind === "instant" ? (
            <Input
              aria-label={`${label} ${path}`}
              placeholder="2026-09-10T09:00:00+08:00"
              value={typeof expected === "string" ? expected : ""}
              required
              onChange={(e) => onChange({ ...value, [path]: e.currentTarget.value })}
            />
          ) : (
            <CaseValueFields
              label={`${label} ${path}`}
              value={expected}
              {...(kind === "set" ? { allowedTypes: ["array"] } : {})}
              onChange={(v) => onChange({ ...value, [path]: v })}
            />
          )}
        </div>
      ))}
      <div className="case-inline-field">
        <Input
          aria-label={`新增${label}路径`}
          placeholder="相对工具业务结果的路径，如 items.0.title"
          value={key}
          onChange={(e) => setKey(e.currentTarget.value)}
        />
        <Button
          type="button"
          variant="outline"
          disabled={!path || duplicate || path.split(".").some((p) => !p.trim())}
          onClick={() => {
            onChange({ ...value, [path]: kind === "set" ? [] : "" });
            setKey("");
          }}
        >
          添加
        </Button>
      </div>
      {duplicate ? <p className="form-error">该路径已存在</p> : null}
    </div>
  );
}

/** Every shared Agent rule parameter is editable without JSON or executable source. */
export function CaseAgentRuleFields({
  rule,
  onChange
}: {
  readonly rule: AgentAuthoringRule;
  readonly onChange: (rule: AgentAuthoringRule) => void;
}): ReactElement {
  const [pendingOutcome, setPendingOutcome] = useState<{
    index: number;
    outcome: "success" | "failure";
  } | null>(null);
  if (rule.kind === "agent-reply") {
    const options = rule.options;
    return (
      <div className="case-agent-fields">
        <div className="case-rule-grid">
          <label>
            回复类型
            <select
              data-guided-target
              aria-label="回复类型"
              value={options.type}
              onChange={(e) =>
                onChange({
                  ...rule,
                  options: { ...options, type: e.currentTarget.value as "QUESTION" | "NOTICE" }
                })
              }
            >
              <option value="NOTICE">NOTICE · 告知 / 回答</option>
              <option value="QUESTION">QUESTION · 提问 / 澄清</option>
            </select>
          </label>
          <label>
            交付要求
            <select
              aria-label="交付要求"
              value={options.delivered ? "delivered" : "decision"}
              onChange={(e) =>
                onChange({
                  ...rule,
                  options: { ...options, delivered: e.currentTarget.value === "delivered" }
                })
              }
            >
              <option value="delivered">必须有终局回复交付证据</option>
              <option value="decision">只检查决策回复</option>
            </select>
          </label>
        </div>
        <label className="case-inline-check">
          <input
            type="checkbox"
            checked={options.exactText !== undefined}
            onChange={(e) => {
              const rest = { type: options.type, delivered: options.delivered };
              onChange({
                ...rule,
                options: e.currentTarget.checked ? { ...rest, exactText: "" } : rest
              });
            }}
          />
          精确匹配固定文案
        </label>
        {options.exactText !== undefined ? (
          <Textarea
            aria-label="固定回复文案"
            required
            value={options.exactText}
            onChange={(e) =>
              onChange({ ...rule, options: { ...options, exactText: e.currentTarget.value } })
            }
          />
        ) : (
          <p className="field-hint">检查非空正文与类型；自由文本是否答对，请另加 AI 语义评分。</p>
        )}
      </div>
    );
  }
  if (rule.kind === "agent-call-policy")
    return (
      <div className="case-agent-fields">
        <StringList
          label={rule.policy.mode === "forbid" ? "禁止工具" : "受限工具"}
          values={rule.policy.tools}
          onChange={(tools) => onChange({ ...rule, policy: { ...rule.policy, tools } })}
        />
        {rule.policy.mode === "limit" ? (
          <label>
            每个工具最多调用次数
            <CaseNumberInput
              label="每个工具最多调用次数"
              value={rule.policy.maxCalls}
              min={0}
              step={1}
              onChange={(maxCalls) => onChange({ ...rule, policy: { ...rule.policy, maxCalls } })}
            />
          </label>
        ) : null}
        {rule.policy.mode === "limit" ? (
          <p className="field-hint">
            每个工具单独计数，包括已记录的重试；不按参数去重，未列出的工具不受限制。
          </p>
        ) : null}
        <p className="field-hint">
          按实际工具名称精确匹配，大小写敏感。禁止写入时请列出所有相关写工具；此规则用于事后验收，不拦截真实操作。
        </p>
      </div>
    );
  const update = (index: number, patch: Partial<AgentExecutionExpectation>): void =>
    onChange({
      ...rule,
      expectations: rule.expectations.map((e, i) => (i === index ? { ...e, ...patch } : e))
    });
  const changeOutcome = (index: number, outcome: "success" | "failure"): void => {
    const execution = rule.expectations[index];
    if (!execution) return;
    const next = {
      tool: execution.tool,
      args: execution.args,
      outcome,
      ...(outcome === "failure" ? { errorCode: "" } : {})
    };
    onChange({ ...rule, expectations: rule.expectations.map((v, i) => (i === index ? next : v)) });
    setPendingOutcome(null);
  };
  return (
    <div className="case-agent-fields">
      <p className="case-rule-scope">
        完整执行清单 · 无序匹配 · 每项恰好一次 · 额外或重复执行会失败
      </p>
      {rule.expectations.length === 0 ? (
        <p className="case-rule-notice">
          当前预期：不执行任何工具。必须采集到空的实际执行列表才通过。
        </p>
      ) : null}
      {rule.expectations.map((execution, index) => (
        <section className="case-execution-expectation" key={index}>
          <div className="case-section-heading">
            <h4>预期执行 {index + 1}</h4>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                onChange({ ...rule, expectations: rule.expectations.filter((_, i) => i !== index) })
              }
            >
              移除此执行
            </Button>
          </div>
          <div className="case-rule-grid">
            <label>
              工具名称
              <Input
                data-guided-target
                aria-label={`工具名称 ${index + 1}`}
                required
                placeholder="填写接口契约中的真实工具名"
                value={execution.tool}
                onChange={(e) => update(index, { tool: e.currentTarget.value })}
              />
            </label>
            <label>
              预期终态
              <select
                aria-label={`预期终态 ${index + 1}`}
                value={execution.outcome}
                onChange={(e) => {
                  const outcome = e.currentTarget.value as "success" | "failure";
                  if (outcome === execution.outcome) return;
                  const hasChecks = Boolean(
                    Boolean(execution.errorCode) ||
                    Object.keys(execution.fields ?? {}).length ||
                    Object.keys(execution.sets ?? {}).length ||
                    Object.keys(execution.instants ?? {}).length ||
                    execution.resourceIds?.length
                  );
                  if (hasChecks) setPendingOutcome({ index, outcome });
                  else changeOutcome(index, outcome);
                }}
              >
                <option value="success">执行成功</option>
                <option value="failure">按预期失败</option>
              </select>
            </label>
          </div>
          {pendingOutcome?.index === index ? (
            <div role="alert" className="case-rule-switch">
              <p>切换终态会清除原来的错误码或业务结果检查，调用参数保留。</p>
              <Button type="button" variant="outline" onClick={() => setPendingOutcome(null)}>
                保留当前终态
              </Button>
              <Button type="button" onClick={() => changeOutcome(index, pendingOutcome.outcome)}>
                确认切换终态
              </Button>
            </div>
          ) : null}
          <div className="case-result-map">
            <h4>调用参数</h4>
            <p className="field-hint">
              仅比较填写的参数，允许其他参数。嵌套对象及列表按完整值比较。
            </p>
            <CaseValueFields
              fixedObject
              label={`执行 ${index + 1} 参数`}
              value={{ ...execution.args }}
              onChange={(args) => update(index, { args: args as Record<string, JsonValue> })}
            />
          </div>
          {execution.outcome === "failure" ? (
            <label>
              预期错误码
              <Input
                aria-label={`预期错误码 ${index + 1}`}
                required
                value={execution.errorCode ?? ""}
                onChange={(e) => update(index, { errorCode: e.currentTarget.value })}
              />
              <span className="field-hint">只验证失败终态与错误码，不执行成功结果检查。</span>
            </label>
          ) : (
            <details
              className="case-business-checks"
              open={
                Boolean(
                  Object.keys(execution.fields ?? {}).length ||
                  Object.keys(execution.sets ?? {}).length ||
                  Object.keys(execution.instants ?? {}).length ||
                  execution.resourceIds?.length
                ) || undefined
              }
            >
              <summary>
                业务结果检查 <span>字段 / 集合 / 时间 / 资源 ID</span>
              </summary>
              <ResultMap
                label="结果字段"
                kind="value"
                value={execution.fields ?? {}}
                onChange={(fields) => update(index, { fields })}
              />
              <ResultMap
                label="无序集合"
                kind="set"
                value={Object.fromEntries(
                  Object.entries(execution.sets ?? {}).map(([k, v]) => [k, [...v]])
                )}
                onChange={(sets) => update(index, { sets: sets as Record<string, JsonValue[]> })}
              />
              <p className="field-hint">集合检查数量与成员一致，禁止重复，不检查顺序。</p>
              <ResultMap
                label="时间字段"
                kind="instant"
                value={execution.instants ?? {}}
                onChange={(instants) =>
                  update(index, { instants: instants as Record<string, string> })
                }
              />
              <p className="field-hint">填写带时区时间；按同一时刻比较，而非字符串格式。</p>
              <StringList
                label="资源 ID 路径"
                values={execution.resourceIds ?? []}
                onChange={(resourceIds) => update(index, { resourceIds })}
              />
            </details>
          )}
        </section>
      ))}
      <Button
        type="button"
        variant="outline"
        onClick={() =>
          onChange({ ...rule, expectations: [...rule.expectations, emptyExecution()] })
        }
      >
        ＋ 添加预期执行
      </Button>
    </div>
  );
}
