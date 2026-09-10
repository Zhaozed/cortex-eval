import type { StoredRestCaseResult } from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import type { RunReview } from "@cortex-eval/contracts/src/run-review-contracts.ts";
import { captureFailureNotes, outboundA2ui } from "./run-auto-capture-model.ts";
import type { CaptureImage, CaptureRequest } from "./run-auto-capture-renderer.ts";
import type { RunReviewStore } from "./run-review-store.ts";

/** One browser at a time. Capture failures are evidence states, not REST/evaluator failures. */
export class RunAutoCaptureService {
  #tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly store: RunReviewStore,
    readonly render: (input: CaptureRequest) => Promise<CaptureImage[]>
  ) {}
  async collect(result: StoredRestCaseResult, signal: AbortSignal): Promise<void> {
    if (result.definition.metadata.a2uiCapture !== true) return;
    const task = this.#tail.then(async () => {
      const current = await this.store.get(result.runId, result.caseKey);
      // Never replace manually collected evidence or an earlier completed attempt automatically.
      if (current.history.some((event) => event.kind === "CAPTURE")) return;
      await this.#capture(result, current, signal);
    });
    this.#tail = task.catch(() => undefined);
    await task;
  }
  async retry(
    result: StoredRestCaseResult,
    expected: { revision: number; evidenceHash: string },
    signal: AbortSignal
  ): Promise<RunReview> {
    if (result.definition.metadata.a2uiCapture !== true) throw new Error("REVIEW_CAPTURE_DISABLED");
    const task = this.#tail.then(async () => {
      const current = await this.store.get(result.runId, result.caseKey);
      if (current.revision !== expected.revision || current.evidenceHash !== expected.evidenceHash)
        throw new Error("REVIEW_STALE");
      return this.#capture(result, current, signal);
    });
    this.#tail = task.catch(() => undefined);
    return task;
  }
  async #capture(
    result: StoredRestCaseResult,
    current: RunReview,
    signal: AbortSignal
  ): Promise<RunReview> {
    let images: CaptureImage[];
    let note =
      "自动采集 · 本次执行的真实出站 A2UI · Web 渲染回放（非 iOS 实机） · 1000×600 / zh-CN / Asia/Shanghai。未进行视觉评分，待人工复核。";
    let state: "CAPTURED" | "RENDER_FAILED" = "CAPTURED";
    try {
      if (result.status !== "SUCCEEDED" || !result.providerOutput.ok)
        throw new Error("A2UI_EXECUTION_UNAVAILABLE");
      const payloads = outboundA2ui(result.providerOutput.parsedOutput);
      if (!payloads.length) throw new Error("A2UI_PAYLOAD_MISSING");
      if (signal.aborted) throw new Error("A2UI_CAPTURE_CANCELLED");
      images = await this.render({ payloads, signal });
      if (!images.length) throw new Error("A2UI_RENDER_FAILED");
      if (
        images.length > 10 ||
        images.some((image) => Buffer.byteLength(image.base64, "base64") > 6_000_000)
      )
        throw new Error("A2UI_CAPTURE_LIMIT");
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      state = "RENDER_FAILED";
      images = [];
      note =
        captureFailureNotes[code] ??
        "自动截图失败；请确认已配置 Web UI 静态目录或本机地址，且 Playwright Chromium 已安装。可使用已保存输出重新采集，不会调用 Agent。";
    }
    // Optimistic lock protects an approval/capture made while the browser was rendering.
    return this.store.change(
      result.runId,
      result.caseKey,
      {
        expectedRevision: current.revision,
        evidenceHash: current.evidenceHash,
        state,
        note,
        images
      },
      "CAPTURE"
    );
  }
}
