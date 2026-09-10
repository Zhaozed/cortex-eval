import { FIELD_RULE_CATALOG } from "@cortex-eval/contracts/src/assertion-rules/catalog.ts";
import {
  AssertionDefinitionV1Schema,
  type AssertionDefinitionV1
} from "@cortex-eval/contracts/src/case-contracts.ts";
import type { ReactElement } from "react";

import { CaseNumberInput } from "./case-number-input.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { CaseCreatableSelect } from "./case-choice-fields.tsx";
import { compileCaseFieldRule, readCaseFieldRule, type CaseFieldRule } from "./case-field-rule.ts";
import { CaseValueFields } from "./case-value-fields.tsx";

const CHECKS = [
  ...FIELD_RULE_CATALOG.map((rule) => [rule.id, rule.label] as const),
  ["contains", "输出包含文本"],
  ["not-contains", "输出不包含文本"],
  ["equals", "完整输出等于"],
  ["regex", "输出匹配正则表达式"],
  ["is-json", "JSON 结构 / Schema"],
  ["llm-rubric", "AI 语义评分"],
  ["javascript", "自定义 JavaScript（高级）"]
] as const;

/** Guided assertion card with lossless advanced access for imported rules. */
export function CaseAssertionFields({
  text,
  index,
  onChange,
  onRemove,
  metrics,
  error,
  guidedError = null,
  rawRef
}: {
  readonly text: string;
  readonly index: number;
  readonly onChange: (text: string) => void;
  readonly onRemove: () => void;
  readonly metrics: readonly string[];
  readonly error: boolean;
  readonly guidedError?: string | null;
  readonly rawRef: (element: HTMLTextAreaElement | null) => void;
}): ReactElement {
  let assertion: AssertionDefinitionV1 | null = null;
  try {
    const parsed = AssertionDefinitionV1Schema.safeParse(JSON.parse(text));
    if (parsed.success) assertion = parsed.data;
  } catch {
    /* Dirty advanced text remains editable. */
  }
  const current = assertion;
  const rule = current?.type === "javascript" ? readCaseFieldRule(current.value) : null;
  const selected = rule ? `field-${rule.operation}` : (current?.type ?? "");
  const known = CHECKS.some(([type]) => type === selected);
  const update = (patch: Partial<AssertionDefinitionV1>): void => {
    if (current) onChange(JSON.stringify({ ...current, ...patch }, null, 2));
  };
  const updateRule = (patch: Partial<CaseFieldRule>): void => {
    if (rule) update({ value: compileCaseFieldRule({ ...rule, ...patch }) });
  };
  return (
    <section className="case-rule-card">
      <div className="case-section-heading">
        <h3>检查项 {index + 1}</h3>
        <Button
          type="button"
          variant="outline"
          aria-label={`删除检查项 ${index + 1}`}
          onClick={onRemove}
        >
          删除
        </Button>
      </div>
      {current ? (
        <>
          <div className="case-rule-grid">
            <label>
              检查规则
              <select
                aria-label={`检查规则 ${index + 1}`}
                value={selected}
                onChange={(e) => {
                  const type = e.currentTarget.value;
                  const base = { metric: current.metric, weight: current.weight ?? 1 };
                  if (type.startsWith("field-")) {
                    const operation = type.slice(6) as CaseFieldRule["operation"];
                    onChange(
                      JSON.stringify({
                        ...base,
                        type: "javascript",
                        value: compileCaseFieldRule({
                          operation,
                          path: rule?.path ?? "",
                          expected:
                            operation === "type"
                              ? "string"
                              : operation === "count"
                                ? 0
                                : operation === "exists"
                                  ? null
                                  : ""
                        })
                      })
                    );
                  } else
                    onChange(
                      JSON.stringify({
                        ...base,
                        type,
                        value: type === "is-json" ? { type: "object" } : ""
                      })
                    );
                }}
              >
                <option value="" disabled>
                  请选择检查规则
                </option>
                {!known ? <option value={selected}>{selected}（高级配置）</option> : null}
                {CHECKS.map(([value, title]) => (
                  <option key={value} value={value}>
                    {title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              评测指标
              <CaseCreatableSelect
                label={`评测指标 ${index + 1}`}
                value={current.metric}
                options={metrics}
                onChange={(metric) => update({ metric })}
              />
            </label>
          </div>
          <p className="field-hint">
            切换检查规则会替换本项的预期与高级配置。新建规则默认权重为 1。
          </p>
          {rule ? (
            <div className="case-rule-grid">
              <label className="field-wide">
                目标字段
                <Input
                  aria-label={`目标字段 ${index + 1}`}
                  data-guided-target
                  aria-invalid={guidedError !== null}
                  list="case-output-paths"
                  value={rule.path}
                  required
                  placeholder="例如 parsed_output.reply_text"
                  onChange={(e) => updateRule({ path: e.currentTarget.value })}
                />
                <span className="field-hint">
                  从实际输出根对象开始，使用点路径；列表下标例如 items.0.title。缺字段会失败。
                </span>
              </label>
              {rule.operation === "equals" ? (
                <CaseValueFields
                  label={`预期值 ${index + 1}`}
                  value={rule.expected}
                  onChange={(expected) => updateRule({ expected })}
                />
              ) : null}
              {rule.operation === "type" ? (
                <label>
                  预期类型
                  <select
                    aria-label={`预期类型 ${index + 1}`}
                    value={typeof rule.expected === "string" ? rule.expected : "string"}
                    onChange={(e) => updateRule({ expected: e.currentTarget.value })}
                  >
                    {["string", "number", "boolean", "object", "array", "null"].map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {rule.operation === "count" ? (
                <label>
                  预期数量
                  <CaseNumberInput
                    label={`预期数量 ${index + 1}`}
                    min={0}
                    step={1}
                    value={typeof rule.expected === "number" ? rule.expected : 0}
                    onChange={(expected) => updateRule({ expected })}
                  />
                </label>
              ) : null}
            </div>
          ) : null}
          {known &&
          !rule &&
          ["contains", "not-contains", "equals", "regex", "llm-rubric"].includes(current.type) ? (
            <>
              {current.rubricPrompt ? (
                <p className="field-hint">
                  使用已有评分 Prompt：{current.rubricPrompt}
                  。引用及扩展配置保持不变，可在高级配置中修改。
                </p>
              ) : current.type === "equals" ? (
                <CaseValueFields
                  label={`预期值 ${index + 1}`}
                  value={current.value === undefined ? "" : current.value}
                  onChange={(value) => update({ value })}
                />
              ) : (
                <label>
                  {current.type === "llm-rubric" ? "语义评分标准" : "预期文本"}
                  <Textarea
                    data-guided-target
                    aria-invalid={guidedError !== null}
                    aria-label={
                      current.type === "llm-rubric"
                        ? `语义评分标准 ${index + 1}`
                        : `预期值 ${index + 1}`
                    }
                    value={typeof current.value === "string" ? current.value : ""}
                    required
                    rows={3}
                    onChange={(e) => update({ value: e.currentTarget.value })}
                  />
                </label>
              )}
              {current.type === "llm-rubric" ? (
                <p className="field-hint">运行时使用配置的评测模型，不是视觉审核。</p>
              ) : null}
            </>
          ) : null}
          {current.type === "is-json" ? (
            current.value === undefined ? (
              <div>
                <p className="field-hint">仅验证 JSON 格式，未设置额外结构约束。</p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => update({ value: { type: "object" } })}
                >
                  添加结构约束
                </Button>
              </div>
            ) : (
              <CaseValueFields
                label={`结构约束 ${index + 1}`}
                value={current.value}
                onChange={(value) => update({ value })}
              />
            )
          ) : null}
          {current.type === "javascript" && !rule ? (
            <label>
              自定义检查代码
              <Textarea
                aria-label={`检查代码 ${index + 1}`}
                rows={6}
                value={typeof current.value === "string" ? current.value : ""}
                onChange={(e) => update({ value: e.currentTarget.value })}
              />
              <span className="field-hint">
                高级规则由研发维护；只检查已有证据，不应发起业务操作。
              </span>
            </label>
          ) : null}
          {!known ? (
            <p className="field-hint">
              此已有规则暂不支持表单编辑，完整配置已保留。展开高级配置编辑，不会自动转换。
            </p>
          ) : null}
        </>
      ) : null}
      {guidedError ? <p className="form-error">{guidedError}</p> : null}
      <details className="case-advanced" open={error || !current ? true : undefined}>
        <summary>高级配置 · 权重、阈值与原始 JSON</summary>
        <label htmlFor={`case-assertion-${index}`}>Assertion JSON {index + 1}</label>
        <Textarea
          ref={rawRef}
          id={`case-assertion-${index}`}
          aria-invalid={error}
          aria-describedby={error ? "case-structured-error" : undefined}
          rows={8}
          value={text}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      </details>
    </section>
  );
}
