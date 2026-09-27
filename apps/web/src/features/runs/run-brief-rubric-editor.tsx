import { Plus, Trash2, ChevronDown, ShieldAlert } from "lucide-react";
import type { ReactElement } from "react";
import type { BriefEvaluationProfile } from "@cortex-eval/contracts/src/brief-evaluation-contracts.ts";
import { Button } from "../../components/ui/button.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";

export type BriefRubric = NonNullable<BriefEvaluationProfile["rubric"]>;

/** Human-editable scoring rules; generation evidence is never part of this editor. */
export function BriefRubricEditor({
  value,
  onChange,
  disabled = false
}: {
  readonly value: BriefRubric;
  readonly onChange: (value: BriefRubric) => void;
  readonly disabled?: boolean;
}): ReactElement {
  const updateDimension = (
    index: number,
    patch: Partial<BriefRubric["dimensions"][number]>
  ): void =>
    onChange({
      ...value,
      dimensions: value.dimensions.map((item, i) => (i === index ? { ...item, ...patch } : item))
    });
  const addDimension = (): void => {
    let number = value.dimensions.length + 1;
    while (value.dimensions.some((item) => item.id === `dimension_${number}`)) number++;
    onChange({
      ...value,
      dimensions: [
        ...value.dimensions,
        { id: `dimension_${number}`, assertion: "", sourceRefs: ["/material"] }
      ]
    });
  };
  return (
    <fieldset className="brief-rubric-editor" disabled={disabled}>
      <div className="brief-rubric-policy">
        <label className="brief-threshold">
          通过阈值{" "}
          <span>
            <input
              aria-label="通过阈值"
              type="number"
              min={0}
              max={value.dimensions.length * 2}
              step={1}
              value={value.minTotalScore}
              onChange={(e) =>
                onChange({
                  ...value,
                  minTotalScore: e.target.value === "" ? 0 : Number(e.target.value)
                })
              }
            />{" "}
            / {value.dimensions.length * 2} 分
          </span>
        </label>
        <label className="brief-checkbox">
          <input
            type="checkbox"
            checked={value.failOnZeroDimension ?? true}
            onChange={(e) => onChange({ ...value, failOnZeroDimension: e.target.checked })}
          />
          任一维度 0 分即不通过
        </label>
      </div>
      <div className="brief-section-heading">
        <div>
          <h3>
            评分维度 <span>{value.dimensions.length}</span>
          </h3>
          <p>每项 0–2 分，评分依据仅来自冻结材料。</p>
        </div>
        <Button variant="outline" size="sm" onClick={addDimension}>
          <Plus aria-hidden="true" />
          添加维度
        </Button>
      </div>
      <div className="brief-dimensions">
        {value.dimensions.map((dimension, index) => (
          <article className="brief-dimension" key={index}>
            <div className="brief-dimension-top">
              <span className="brief-dimension-number">{String(index + 1).padStart(2, "0")}</span>
              <input
                className="brief-dimension-id"
                aria-label={`维度 ${index + 1} 标识`}
                value={dimension.id}
                onChange={(e) => updateDimension(index, { id: e.target.value })}
              />
              <span className="brief-score-badge">0 / 1 / 2 分</span>
              <Button
                variant="ghost"
                size="icon"
                disabled={value.dimensions.length <= 1}
                aria-label={`删除维度 ${index + 1}`}
                onClick={() =>
                  onChange({ ...value, dimensions: value.dimensions.filter((_, i) => i !== index) })
                }
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
            <Textarea
              aria-label={`评分标准 ${index + 1}`}
              placeholder="描述这一维度要判断什么，以及达标要求…"
              rows={3}
              value={dimension.assertion}
              onChange={(e) => updateDimension(index, { assertion: e.target.value })}
            />
            <details className="brief-source-refs">
              <summary>
                <ChevronDown aria-hidden="true" />
                材料引用 <span>{dimension.sourceRefs.length} 处</span>
              </summary>
              <label>
                输入 Bundle 中的路径，每行一处
                <Textarea
                  aria-label={`材料引用 ${index + 1}`}
                  rows={2}
                  value={dimension.sourceRefs.join("\n")}
                  onChange={(e) =>
                    updateDimension(index, { sourceRefs: e.target.value.split("\n") })
                  }
                />
              </label>
              <p>例如 /material、/context。保存时校验路径是否存在。</p>
            </details>
          </article>
        ))}
      </div>
      <section className="brief-hard-fails">
        <div className="brief-section-heading">
          <div>
            <h3>
              <ShieldAlert aria-hidden="true" />
              一票否决规则
            </h3>
            <p>命中任一规则，即使总分达标也不通过。</p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange({ ...value, hardFailRules: [...value.hardFailRules, ""] })}
          >
            <Plus aria-hidden="true" />
            添加规则
          </Button>
        </div>
        {value.hardFailRules.map((rule, index) => (
          <div className="brief-hard-fail" key={index}>
            <span>{index + 1}</span>
            <Textarea
              aria-label={`一票否决规则 ${index + 1}`}
              rows={2}
              value={rule}
              placeholder="例如：编造材料中不存在的事实"
              onChange={(e) =>
                onChange({
                  ...value,
                  hardFailRules: value.hardFailRules.map((item, i) =>
                    i === index ? e.target.value : item
                  )
                })
              }
            />
            <Button
              variant="ghost"
              size="icon"
              disabled={value.hardFailRules.length <= 1}
              aria-label={`删除一票否决规则 ${index + 1}`}
              onClick={() =>
                onChange({
                  ...value,
                  hardFailRules: value.hardFailRules.filter((_, i) => i !== index)
                })
              }
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        ))}
      </section>
      <details className="brief-json-preview">
        <summary>查看 Rubric JSON</summary>
        <pre>{JSON.stringify(value, null, 2)}</pre>
      </details>
    </fieldset>
  );
}
