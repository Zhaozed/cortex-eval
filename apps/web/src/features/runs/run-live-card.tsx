import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RunReview } from "@cortex-eval/contracts/src/run-review-contracts.ts";
import { runReviewApi } from "../../lib/run-review-api.ts";
import { cardReplayFrames } from "./run-card-replay-model.ts";
import { Button } from "../../components/ui/button.tsx";

/** Live read-only production rendering. No PNG generation/upload, no Agent or tool requests. */
export function RunLiveCard({
  review,
  onReady
}: {
  readonly review: RunReview;
  readonly onReady: (version: string | null) => void;
}): ReactElement {
  const frame = useRef<HTMLIFrameElement>(null);
  const [token, setToken] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<"LOADING" | "READY" | "ERROR">("LOADING");
  const [selected, setSelected] = useState<number | null>(null);
  const readyFrames = useRef(new Set<number>());
  const scopeRef = useRef("");
  const [loaded, setLoaded] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const preview = useQuery({
    queryKey: [
      "run-live-preview",
      review.runId,
      review.caseKey,
      review.evidenceHash,
      review.live?.rendererVersion
    ],
    queryFn: ({ signal }) => runReviewApi.preview(review.runId, review.caseKey, signal),
    retry: false,
    staleTime: 0
  });
  const data = preview.data;
  const frames = useMemo(() => cardReplayFrames(data?.payloads ?? []), [data?.payloads]);
  const activeIndex = Math.max(0, Math.min(selected ?? frames.length - 1, frames.length - 1));
  const activeFrame = frames[activeIndex];
  const scope = `${data?.evidenceHash ?? ""}/${data?.rendererVersion ?? ""}`;
  const valid =
    data?.evidenceHash === review.evidenceHash &&
    /^http:\/\/127\.0\.0\.1:\d+$/.test(data.origin ?? "") &&
    data.origin !== window.location.origin &&
    data.rendererVersion !== null;
  useEffect(() => {
    onReady(null);
    setState("LOADING");
    if (scopeRef.current !== scope) {
      readyFrames.current.clear();
      scopeRef.current = scope;
    }
    readyFrames.current.delete(activeIndex);
    setLoaded(readyFrames.current.size);
    if (!valid) return;
    const targetOrigin = data.origin;
    const timer = setTimeout(() => {
      setState("ERROR");
      onReady(null);
    }, 25_000);
    const receive = (event: MessageEvent): void => {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target || event.origin !== targetOrigin) return;
      const message: unknown = event.data;
      if (!message || typeof message !== "object" || !("type" in message)) return;
      if (message.type === "cortex-eval-preview-host") {
        target.postMessage(
          {
            type: "cortex-eval-preview-load",
            token,
            payloads: activeFrame?.payloads ?? data.payloads
          },
          targetOrigin
        );
      } else if (
        message.type === "cortex-eval-preview" &&
        "token" in message &&
        message.token === token &&
        "state" in message
      ) {
        if (message.state === "READY") {
          clearTimeout(timer);
          setState("READY");
          readyFrames.current.add(activeIndex);
          setLoaded(readyFrames.current.size);
          onReady(readyFrames.current.size === frames.length ? data.rendererVersion : null);
        } else if (message.state === "ERROR") {
          clearTimeout(timer);
          setState("ERROR");
          readyFrames.current.delete(activeIndex);
          setLoaded(readyFrames.current.size);
          onReady(null);
        }
      }
    };
    window.addEventListener("message", receive);
    return (): void => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      onReady(null);
    };
  }, [data, valid, token, onReady, activeFrame, activeIndex, frames.length, scope]);
  const replay = (): void => {
    onReady(null);
    setState("LOADING");
    setToken(crypto.randomUUID());
  };
  const selectFrame = (index: number): void => {
    onReady(null);
    setSelected(index);
    setState("LOADING");
    setToken(crypto.randomUUID());
  };
  return (
    <section
      className={`run-live-card${expanded ? " run-live-card-expanded" : ""}`}
      aria-label="A2UI 动态卡片"
    >
      <header className="run-panel-heading">
        <div>
          <h3>A2UI 卡片</h3>
          <span>{state === "READY" ? "已渲染 · 待人工检查" : "Web 只读回放"}</span>
        </div>
        <div className="run-live-card-actions">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              replay();
              void preview.refetch();
            }}
          >
            重新加载
          </Button>
          <Button size="sm" variant="outline" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "收起" : "放大"}
          </Button>
        </div>
      </header>
      <p className="run-muted">本次执行的真实出站数据 · 可滚动、切换和展开 · 不执行真实业务操作</p>
      {frames.length > 1 && (
        <div className="run-card-navigator">
          <div>
            <strong>
              卡面 / 阶段{" "}
              <span>
                {activeIndex + 1} / {frames.length}
              </span>
            </strong>
            <span className="run-muted">
              已加载 {loaded}/{frames.length} · 请逐项人工检查
            </span>
          </div>
          <div>
            <Button
              size="sm"
              variant="outline"
              disabled={activeIndex === 0}
              onClick={() => selectFrame(activeIndex - 1)}
            >
              上一项
            </Button>
            <select
              aria-label="选择 A2UI 卡面或阶段"
              value={activeIndex}
              onChange={(e) => selectFrame(Number(e.target.value))}
            >
              {frames.map((f, i) => (
                <option key={i} value={i}>
                  {f.label}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={activeIndex === frames.length - 1}
              onClick={() => selectFrame(activeIndex + 1)}
            >
              下一项
            </Button>
          </div>
          <p>默认展示最后一项；按出站顺序保留各卡面及更新阶段，删除消息见原始数据。</p>
        </div>
      )}
      {activeFrame?.surface && (
        <p className="run-card-surface">
          单卡面回放 <code>{activeFrame.surface}</code>
        </p>
      )}
      {data?.rendererSource && (
        <p className="run-card-surface">
          渲染资源：<code>{data.rendererSource}</code>
        </p>
      )}
      {preview.isError ? (
        <p role="alert">卡片数据读取失败，请重新加载。</p>
      ) : data?.error ? (
        <p role="alert">{data.error}</p>
      ) : !data ? (
        <p role="status">正在读取卡片…</p>
      ) : !valid ? (
        <p role="alert">执行证据已变化，请重新打开详情。</p>
      ) : (
        <>
          {state === "LOADING" && <p role="status">正在渲染卡片…</p>}
          {state === "ERROR" && (
            <p role="alert">卡片或依赖资源未能完整加载，不能确认视觉通过。请重新加载。</p>
          )}
          <iframe
            key={token}
            ref={frame}
            title="本次执行的 A2UI 动态卡片"
            className="run-live-card-frame"
            src={`${data.origin}${data.previewPath ?? "/preview"}?parent=${encodeURIComponent(window.location.origin)}`}
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
            onLoad={() =>
              frame.current?.contentWindow?.postMessage(
                {
                  type: "cortex-eval-preview-load",
                  token,
                  payloads: activeFrame?.payloads ?? data.payloads
                },
                data.origin ?? ""
              )
            }
          />
        </>
      )}
    </section>
  );
}
