import "./run-brief-reevaluation.css";
import { useId, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { LockKeyhole, ArrowRight, SlidersHorizontal, FileText, Check, Info } from "lucide-react";
import {
  BriefReevaluationOptionsSchema,
  type BriefReevaluationOptions
} from "@cortex-eval/contracts/src/run-api-contracts.ts";
import {
  DEFAULT_BRIEF_JUDGE_PROMPT,
  type BriefEvaluationProfile
} from "@cortex-eval/contracts/src/brief-evaluation-contracts.ts";
import { Button } from "../../components/ui/button.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { createResourceApi, type ResourceApi } from "../../lib/resource-api.ts";
import { dashboardPages } from "./run-dashboard-model.ts";
import { BriefRubricEditor, type BriefRubric } from "./run-brief-rubric-editor.tsx";

const resources = createResourceApi();

/** Create a new Judge version, keeping evidence locked and making scoring rules human-editable. */
export function BriefReevaluationForm({
  profile,
  evaluatorPrompt,
  pending,
  failed,
  onSubmit,
  onCancel,
  batch = false,
  sampleCount = 1,
  sourceRunId,
  sourceModel,
  resourceApi = resources
}: {
  readonly profile: BriefEvaluationProfile;
  readonly evaluatorPrompt?: string | undefined;
  readonly pending: boolean;
  readonly failed: boolean;
  readonly onSubmit: (value: BriefReevaluationOptions, name: string) => void;
  readonly batch?: boolean;
  readonly sampleCount?: number;
  readonly sourceRunId?: string | undefined;
  readonly sourceModel?: string | undefined;
  readonly onCancel: () => void;
  readonly resourceApi?: ResourceApi;
}): ReactElement {
  const id = useId();
  const [name, setName] = useState(
    `${profile.briefType === "daily" ? "Daily Brief" : "Pre-meeting Brief"} · 裁判校准`
  );
  const [sharedRubric, setSharedRubric] = useState(false);
  const [model, setModel] = useState("");
  const [tab, setTab] = useState<"rubric" | "prompt">("rubric");
  const [prompt, setPrompt] = useState(
    profile.judgePrompt ??
      (profile.rubric
        ? DEFAULT_BRIEF_JUDGE_PROMPT
        : "你是严格的 Brief 事实核对员。仅依据提供的冻结材料与最终生成内容逐项回答。")
  );
  const [extra, setExtra] = useState(evaluatorPrompt ?? "");
  const [rubric, setRubric] = useState<BriefRubric | undefined>(() =>
    profile.rubric ? structuredClone(profile.rubric) : undefined
  );
  const [error, setError] = useState<string | null>(null);
  const models = useQuery({
    queryKey: ["brief-reevaluation-models"],
    queryFn: ({ signal }) =>
      dashboardPages((cursor) =>
        resourceApi.listConfigurations("LLM", { limit: 100, cursor }, signal)
      )
  });
  const selected = useQuery({
    queryKey: ["brief-reevaluation-model", model],
    queryFn: ({ signal }) => resourceApi.getConfiguration("LLM", model, signal),
    enabled: model !== ""
  });
  const appliesRubric = !batch || sharedRubric;
  const submit = (): void => {
    if (!name.trim() || name.trim().length > 120) {
      setError("请填写 1–120 字的版本名称。");
      return;
    }
    if (!prompt.trim()) {
      setError("Judge prompt 不能为空。");
      setTab("prompt");
      return;
    }
    if (appliesRubric && rubric) {
      const empty = rubric.dimensions.findIndex((item) => !item.assertion.trim());
      if (empty >= 0) {
        setError(`请填写第 ${empty + 1} 个维度的评分标准。`);
        setTab("rubric");
        return;
      }
      if (rubric.hardFailRules.some((rule) => !rule.trim())) {
        setError("请填写一票否决规则，或删除空白规则。");
        setTab("rubric");
        return;
      }
      if (rubric.minTotalScore > rubric.dimensions.length * 2) {
        setError("通过阈值不能超过维度满分之和。");
        setTab("rubric");
        return;
      }
    }
    const parsed = BriefReevaluationOptionsSchema.safeParse({
      ...(model ? { evaluatorConfigId: model } : {}),
      judgePrompt: prompt,
      evaluatorPrompt: extra.trim() || null,
      ...(appliesRubric && rubric ? { rubric } : {})
    });
    if (!parsed.success) {
      setError(
        "请检查维度标识（英文、数字、下划线或短横线，不能重复）、材料路径及整数阈值。Prompt 最长 30,000 字。"
      );
      return;
    }
    setError(null);
    onSubmit(parsed.data, name.trim());
  };
  const createRubric = (): void =>
    setRubric({
      dimensions: profile.checklist?.map((item) => ({
        id: item.id,
        assertion: item.assertion,
        sourceRefs: [...item.sourceRefs]
      })) ?? [
        {
          id: "facts",
          assertion: "事实准确，不编造输入材料中不存在的信息",
          sourceRefs: ["/material"]
        }
      ],
      minTotalScore: profile.checklist?.length ?? 1,
      hardFailRules: ["编造输入材料中不存在的事实"]
    });
  return (
    <section className="brief-reevaluation-form" aria-label="固定样本重新评测">
      <div className="brief-evidence-lock">
        <div className="brief-lock-icon">
          <LockKeyhole aria-hidden="true" />
        </div>
        <div>
          <strong>
            {sampleCount} 个固定样本 <span>输入与输出已锁定</span>
          </strong>
          <p>只更换裁判，不重新生成 Brief，也不修改原评测记录。</p>
        </div>
        <span className="brief-lock-check">
          <Check aria-hidden="true" />
          保留原始证据
        </span>
      </div>
      <div className="brief-calibration-layout">
        <aside className="brief-version-panel">
          <div className="brief-panel-eyebrow">新评测版本</div>
          <label>
            版本名称
            <input
              aria-label="评测版本名称"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              disabled={pending}
            />
          </label>
          <label>
            Judge 模型
            <select
              aria-label="Judge 模型"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={pending}
            >
              <option value="">沿用原模型快照</option>
              {models.data?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <div className="brief-model-meta">
            {model === "" ? (
              <>
                <span>当前模型</span>
                <strong>{sourceModel ?? "源 run 的冻结模型"}</strong>
                <p>保留当时的模型参数，不受配置库后续编辑影响。</p>
              </>
            ) : selected.data?.kind === "LLM" ? (
              <>
                <span>新模型</span>
                <strong>{selected.data.definition.model}</strong>
                <p>
                  Temperature {selected.data.definition.temperature} · 配置修订{" "}
                  {selected.data.revision}
                </p>
              </>
            ) : (
              <p>{selected.isError ? "模型读取失败，请重新选择。" : "正在读取模型配置…"}</p>
            )}
          </div>
          {models.isError && (
            <p role="alert">
              模型列表读取失败。
              <Button variant="ghost" size="sm" onClick={() => void models.refetch()}>
                重试
              </Button>
            </p>
          )}
          <div className="brief-version-flow">
            <span>原始样本</span>
            <ArrowRight aria-hidden="true" />
            <span>新裁判版本</span>
          </div>
          <dl className="brief-version-facts">
            <div>
              <dt>样本范围</dt>
              <dd>
                {batch ? "整批" : "单条"} · {sampleCount} 个样本
              </dd>
            </div>
            <div>
              <dt>生成接口</dt>
              <dd>不调用</dd>
            </div>
            <div>
              <dt>旧评分</dt>
              <dd>不复用</dd>
            </div>
            {sourceRunId && (
              <div>
                <dt>来源 Run</dt>
                <dd title={sourceRunId}>{sourceRunId.slice(0, 8)}…</dd>
              </div>
            )}
          </dl>
          <p className="brief-calibration-tip">
            <Info aria-hidden="true" />
            建议每次只改一个变量，方便判断评分差异来自哪里。
          </p>
        </aside>
        <div className="brief-scoring-panel">
          <div className="brief-editor-tabs" role="tablist" aria-label="裁判配置">
            <button
              type="button"
              role="tab"
              id={`${id}-rubric-tab`}
              aria-controls={`${id}-rubric-panel`}
              aria-selected={tab === "rubric"}
              tabIndex={tab === "rubric" ? 0 : -1}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  setTab("prompt");
                  document.getElementById(`${id}-prompt-tab`)?.focus();
                }
              }}
              onClick={() => setTab("rubric")}
            >
              <SlidersHorizontal aria-hidden="true" />
              Rubric 评分标准{rubric && <span>{rubric.dimensions.length} 维</span>}
            </button>
            <button
              type="button"
              role="tab"
              id={`${id}-prompt-tab`}
              aria-controls={`${id}-prompt-panel`}
              aria-selected={tab === "prompt"}
              tabIndex={tab === "prompt" ? 0 : -1}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  setTab("rubric");
                  document.getElementById(`${id}-rubric-tab`)?.focus();
                }
              }}
              onClick={() => setTab("prompt")}
            >
              <FileText aria-hidden="true" />
              Judge Prompt
            </button>
          </div>
          {tab === "rubric" ? (
            <div
              className="brief-editor-body"
              role="tabpanel"
              id={`${id}-rubric-panel`}
              aria-labelledby={`${id}-rubric-tab`}
            >
              {batch && (
                <fieldset className="brief-rubric-scope" disabled={pending}>
                  <legend>如何使用本批样本的评分标准？</legend>
                  <label data-selected={!sharedRubric}>
                    <input
                      type="radio"
                      name={`${id}-scope`}
                      checked={!sharedRubric}
                      onChange={() => setSharedRubric(false)}
                    />
                    <span>
                      <strong>保留各样本原规则</strong>
                      <small>只改模型或 Prompt 时选这里</small>
                    </span>
                  </label>
                  <label data-selected={sharedRubric}>
                    <input
                      type="radio"
                      name={`${id}-scope`}
                      aria-label="统一覆盖所有样本的 Rubric"
                      checked={sharedRubric}
                      onChange={() => setSharedRubric(true)}
                    />
                    <span>
                      <strong>统一编辑 Rubric</strong>
                      <small>将下方规则应用到全部样本</small>
                    </span>
                  </label>
                </fieldset>
              )}
              {!appliesRubric && (
                <div className="brief-retained-note">
                  <LockKeyhole aria-hidden="true" />
                  下方为首个样本的规则预览；每个样本仍使用自己的原始 Rubric。
                </div>
              )}
              {rubric ? (
                <BriefRubricEditor
                  value={rubric}
                  onChange={setRubric}
                  disabled={pending || !appliesRubric}
                />
              ) : (
                <div className="brief-checklist-empty">
                  <SlidersHorizontal aria-hidden="true" />
                  <h3>沿用原 Checklist</h3>
                  <p>
                    当前样本使用 {profile.checklist?.length ?? 0} 项检查规则，不是 0–2 分制 Rubric。
                  </p>
                  {appliesRubric && (
                    <Button variant="outline" disabled={pending} onClick={createRubric}>
                      转换为可编辑评分维度
                    </Button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div
              className="brief-editor-body brief-prompt-editor"
              role="tabpanel"
              id={`${id}-prompt-panel`}
              aria-labelledby={`${id}-prompt-tab`}
            >
              <div className="brief-section-heading">
                <div>
                  <h3>裁判主指令</h3>
                  <p>定义裁判如何理解材料、评分与处理不确定性。</p>
                </div>
                <span className="brief-score-badge">{prompt.length.toLocaleString()} 字</span>
              </div>
              <Textarea
                aria-label="Judge prompt"
                rows={12}
                value={prompt}
                maxLength={30000}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={pending}
              />
              <label>
                补充评判指令 <span className="brief-optional">可选</span>
                <Textarea
                  aria-label="补充评判指令"
                  rows={4}
                  placeholder="例如：重点核查时间、人物归属与未确认事项，不得用常识补齐缺失事实。"
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                  disabled={pending}
                />
              </label>
              <p className="brief-protocol-note">
                <LockKeyhole aria-hidden="true" />
                JSON 返回协议、证据校验和安全约束由平台固定，不需要写进 Prompt。
                {batch && "本批所有样本将统一使用这里的主指令和补充指令。"}
              </p>
            </div>
          )}
        </div>
      </div>
      <footer className="brief-calibration-footer">
        {(error !== null || failed) && (
          <p role="alert" className="brief-form-error">
            {error ?? "创建失败，请检查模型配置、源数据完整性及材料引用。原记录未修改。"}
          </p>
        )}
        <div>
          <p>
            <strong>创建新版本，不覆盖原记录</strong>
            <span>创建不执行；手动开始后才调用 Judge 并产生费用。</span>
          </p>
          <div className="brief-reevaluation-actions">
            <Button variant="outline" onClick={onCancel} disabled={pending}>
              取消
            </Button>
            <Button
              onClick={submit}
              disabled={
                pending || (model !== "" && (selected.data?.kind !== "LLM" || selected.isError))
              }
            >
              {pending ? "正在创建…" : "创建重评版本"}
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
        </div>
      </footer>
    </section>
  );
}
