import { outboundEvidenceIncomplete } from "@cortex-eval/contracts/src/e2e-evidence.ts";
import type { StoredRestCaseResult } from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import type { RunLivePreview, RunReview } from "@cortex-eval/contracts/src/run-review-contracts.ts";
import { outboundA2ui } from "./run-auto-capture-model.ts";
import { convertBriefA2ui, cortexRootFor } from "./run-brief-a2ui-converter.ts";
import { runRendererSource } from "./run-renderer-source.ts";
import type { RunLivePreviewService } from "./run-live-preview-service.ts";

/** Explicit outbound evidence only; never substitute tool data or planner intentions. */
export async function livePreviewContext(
  result: StoredRestCaseResult,
  renderer: RunLivePreviewService,
  endpoint?: string
): Promise<{ preview: RunLivePreview; live: NonNullable<RunReview["live"]> }> {
  let payloads: Record<string, unknown>[] = [],
    error: string | null = null;
  try {
    if (result.status === "SUCCEEDED" && result.providerOutput.parsedOutput !== undefined)
      payloads = outboundA2ui(result.providerOutput.parsedOutput);
    else error = "本次执行没有保存可用的出站数据。";
    // Brief replay 不落交付态 A2UI；在预览时把 output.public_results 投影为 A2UI 供人工复核。
    // 转换结果只进预览响应，不回写执行证据，裁判输入不受影响。
    if (payloads.length === 0 && error === null) {
      const brief = await convertBriefA2ui(
        result.providerOutput?.parsedOutput,
        cortexRootFor(renderer.staticRoot)
      );
      if (brief !== null) {
        payloads = brief.payloads;
        error = brief.error;
      }
    }
  } catch {
    error = "已记录的 A2UI 数据格式无效，无法渲染。";
  }
  // Only a card that actually exists needs a human eye. The capture opt-in flag alone
  // must not park a zero-card Case in review; missing/forbidden cards are Case assertions.
  const required = payloads.length > 0;
  let origin: string | null = null,
    rendererVersion: string | null = null;
  let previewPath: string | undefined, rendererSource: string | undefined;
  if (payloads.length) {
    try {
      if (!endpoint) throw new Error("A2UI_ENDPOINT_MISSING");
      rendererSource = runRendererSource(endpoint, renderer.staticRoot).identity;
      ({ origin, rendererVersion, previewPath, rendererSource } = await renderer.infoForEndpoint(
        endpoint,
        result.runId
      ));
    } catch (failure) {
      const messages: Record<string, string> = {
        A2UI_ENDPOINT_MISSING: "缺少本次运行冻结的 endpoint，无法确定资源来源。",
        A2UI_ENDPOINT_INVALID: "本次运行的 endpoint 无法解析为受支持的资源地址。",
        A2UI_RESOURCE_CHANGED: "获取期间该环境发生发布，请重新加载以获取一致资源。",
        A2UI_RESOURCE_LIMIT: "资源数量或大小达到隔离服务上限，请检查资源或重启平台释放会话缓存。",
        A2UI_RESOURCE_TYPE_INVALID: "资源响应类型不正确，请检查是否返回了登录页或错误页。",
        A2UI_ASSET_FORBIDDEN: "资源路径或重定向离开了允许的静态目录。"
      };
      const detail = failure instanceof Error ? messages[failure.message] : undefined;
      error = `被测 endpoint 的 Web 渲染资源不可用：${detail ?? "请检查该环境的静态资源、网络或本地 CORTEX_A2UI_STATIC_ROOT 配置。"}不会回退到其他环境。`;
    }
  } else
    error ??=
      "本次执行未记录 A2UI 卡片，无需视觉复核。要求出卡或禁止出卡由 Case 断言检查；人工仍可依据执行链路与文字证据给出最终结论。";
  // 转换得到的 Brief 卡片来自同一证据哈希下的结构化结果，供人工复核卡面；未真实交付给用户。
  const incomplete =
    result.status === "SUCCEEDED" &&
    (!result.providerOutput.ok || outboundEvidenceIncomplete(result.providerOutput.parsedOutput));
  if (incomplete && payloads.length > 0 && error === null)
    error = "仅展示已采集的部分卡片；请求或出站采集未完成。人工可给出最终结论，需填写归因与说明。";
  return {
    preview: {
      runId: result.runId,
      caseKey: result.caseKey,
      evidenceHash: result.resultHash,
      origin,
      rendererVersion,
      ...(previewPath ? { previewPath } : {}),
      ...(rendererSource ? { rendererSource } : {}),
      payloads,
      error
    },
    live: {
      required,
      available: origin !== null && payloads.length > 0 && !incomplete,
      rendererVersion
    }
  };
}
