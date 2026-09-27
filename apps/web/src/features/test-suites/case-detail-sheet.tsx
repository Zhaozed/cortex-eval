import type { CaseDefinitionV1 } from "@cortex-eval/contracts/src/case-contracts.ts";
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { Button } from "../../components/ui/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "../../components/ui/sheet.tsx";
import { resourceKeys, type ResourceApi } from "../../lib/resource-api.ts";

/** Read-only current Case inspection, separate from the mutation editor. */
export interface CaseDetailSheetProps {
  readonly api: ResourceApi;
  readonly suiteId: string;
  readonly caseKey: string;
  readonly onClose: () => void;
}

// Render text, never executable markup from Case data.
function JsonContent({ value }: { readonly value: unknown }): ReactElement {
  return (
    <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded border p-3 text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function bundleRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bundleListCount(snapshot: Record<string, unknown>, key: string): number {
  const value = snapshot[key];
  return Array.isArray(value) ? value.length : 0;
}

/** Brief 请求是结构化 bundle，摘要行给复核动线，完整 JSON 默认折叠。 */
function BriefRequestSummary({
  definition
}: {
  readonly definition: CaseDefinitionV1;
}): ReactElement {
  const bundle = bundleRecord(bundleRecord(definition.vars.request_body).bundle);
  const snapshot = bundleRecord(bundleRecord(bundle.material).snapshot);
  const briefType =
    (bundle.brief_type ?? definition.semanticEvaluation?.brief?.briefType) === "meeting"
      ? "Meeting Brief"
      : "Daily Brief";
  return (
    <p>
      {briefType} · 材料：记忆 {bundleListCount(snapshot, "memories")} 条 · 项目{" "}
      {bundleListCount(snapshot, "projects")} 个 · 人物 {bundleListCount(snapshot, "persons")} 个
    </p>
  );
}

/** Human-readable Brief GT and input with a complete JSON escape hatch for all Case types. */
export function CaseDetailContent({
  definition
}: {
  readonly definition: CaseDefinitionV1;
}): ReactElement {
  const semantic = definition.semanticEvaluation;
  const brief = semantic?.brief;
  const isBrief = brief !== undefined || definition.metadata.business_module.startsWith("brief");
  return (
    <div className="grid min-w-0 gap-6">
      <section aria-label="基本信息" className="grid gap-2">
        <h3>基本信息</h3>
        <p>{definition.description}</p>
        <p>Case 通过阈值：{definition.threshold}</p>
        {brief ? (
          <>
            <p>Brief 类型：{brief.briefType === "daily" ? "Daily Brief" : "Meeting Brief"}</p>
            <p>内容裁判：{brief.judge ?? "JEV"}</p>
            <p>
              {brief.judge === "LLM"
                ? "使用创建 Run 时选定并冻结的 Evaluator 模型。"
                : "使用现有 JEV 服务配置。"}
              不自动切换裁判。
            </p>
            <p>语义通过阈值：{semantic.scorePassThreshold ?? 0.85}</p>
          </>
        ) : null}
      </section>
      <section aria-label="输入材料" className="grid min-w-0 gap-2">
        <h3>输入材料 / 请求参数</h3>
        <p>以下为保存的请求数据，不包含 GT 或裁判配置；Endpoint 在创建 Run 时选择。</p>
        {isBrief ? (
          <>
            <BriefRequestSummary definition={definition} />
            <details className="min-w-0">
              <summary>完整请求 JSON</summary>
              <JsonContent value={definition.vars.request_body} />
            </details>
          </>
        ) : (
          <JsonContent value={definition.vars.request_body} />
        )}
      </section>
      {brief ? (
        <>
          {brief.checklist ? (
          <section aria-label="原子 GT" className="grid min-w-0 gap-2">
            <h3>原子 GT</h3>
            <p>P0 必须覆盖 · P1 补充事实 · P2 禁止出现的内容</p>
            <div className="brief-table-scroll">
              <table className="brief-checklist">
                <thead>
                  <tr>
                    <th>层级 / ID</th>
                    <th>断言</th>
                    <th>材料来源</th>
                  </tr>
                </thead>
                <tbody>
                  {brief.checklist.map((item) => (
                    <tr key={item.id}>
                      <td>
                        {item.tier}
                        <br />
                        <code>{item.id}</code>
                      </td>
                      <td>{item.assertion}</td>
                      <td>
                        {item.sourceRefs.map((ref) => (
                          <p key={ref}>
                            <code>{ref}</code>
                          </p>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          ) : null}
          {brief.rubric ? (
            <section aria-label="评分维度" className="grid min-w-0 gap-2">
              <h3>评分维度（Rubric）</h3>
              <p>
                每维 0-2 分 · 满分 {brief.rubric.dimensions.length * 2} 分 · 通过线{" "}
                {brief.rubric.minTotalScore} 分
                {brief.rubric.failOnZeroDimension ? " · 任一维度 0 分即不通过" : ""}
              </p>
              <div className="brief-table-scroll">
                <table className="brief-checklist">
                  <thead>
                    <tr>
                      <th>维度 ID</th>
                      <th>断言</th>
                      <th>材料来源</th>
                    </tr>
                  </thead>
                  <tbody>
                    {brief.rubric.dimensions.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <code>{item.id}</code>
                        </td>
                        <td>{item.assertion}</td>
                        <td>
                          {item.sourceRefs.map((ref) => (
                            <p key={ref}>
                              <code>{ref}</code>
                            </p>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details className="min-w-0">
                <summary>硬性失败规则（{brief.rubric.hardFailRules.length}）</summary>
                <ul>
                  {brief.rubric.hardFailRules.map((rule) => (
                    <li key={rule}>{rule}</li>
                  ))}
                </ul>
              </details>
            </section>
          ) : null}
          <section aria-label="生成与容量约束" className="grid gap-2">
            <h3>生成与容量约束</h3>
            <p>允许的生成状态：{brief.constraints.allowedGenerationStatuses.join("、")}</p>
            <p>最少卡片数：{brief.constraints.minCards ?? "不限制"}</p>
            <p>最多卡片数：{brief.constraints.maxCards ?? "不限制"}</p>
            <p>每卡字符上限：{brief.constraints.maxCardChars ?? "不限制"}</p>
            <p>全文字符上限：{brief.constraints.maxTextChars ?? "不限制"}</p>
          </section>
        </>
      ) : null}
      <section aria-label="通用检查项" className="grid min-w-0 gap-2">
        <h3>通用检查项</h3>
        <JsonContent value={definition.assert} />
      </section>
      {!brief && semantic ? (
        <section aria-label="语义评测配置" className="grid min-w-0 gap-2">
          <h3>语义评测配置</h3>
          <JsonContent value={semantic} />
        </section>
      ) : null}
      <details className="min-w-0">
        <summary>完整 Case JSON</summary>
        <JsonContent value={definition} />
      </details>
    </div>
  );
}

/** Fetch only when opened; never saves a Case or invokes the Agent/judge. */
export function CaseDetailSheet({
  api,
  suiteId,
  caseKey,
  onClose
}: CaseDetailSheetProps): ReactElement {
  const detail = useQuery({
    queryKey: resourceKeys.caseDetail(suiteId, caseKey),
    queryFn: ({ signal }) => api.getCase(suiteId, caseKey, signal),
    staleTime: 0,
    refetchOnMount: "always"
  });
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-[min(960px,96vw)]">
        <SheetHeader>
          <SheetTitle>Case 详情 · {caseKey}</SheetTitle>
          <SheetDescription>
            只读查看输入材料、评测标准与配置；不会修改用例或执行评测。
          </SheetDescription>
        </SheetHeader>
        {detail.isPending ? <p role="status">正在加载 Case 详情…</p> : null}
        {detail.isError ? (
          <div role="alert">
            <p>Case 详情加载失败，请重试；用例可能已被删除。</p>
            <Button
              type="button"
              disabled={detail.isFetching}
              onClick={() => void detail.refetch()}
            >
              重试
            </Button>
          </div>
        ) : null}
        {detail.isSuccess ? (
          <>
            <p>Case Revision：{detail.data.revision}</p>
            <CaseDetailContent definition={detail.data.definition} />
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
