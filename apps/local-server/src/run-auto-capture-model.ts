/** Only explicit outbound A2UI is renderable evidence, never planner intentions/tool results. */
export function outboundA2ui(parsed: unknown): Record<string, unknown>[] {
  const object = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const root = object(parsed);
  const read = (v: unknown): Record<string, unknown>[] => {
    if (v === undefined || v === null) return [];
    const list = Array.isArray(v) ? v : [v];
    return list.map((item) => {
      const value = object(item);
      if (!Array.isArray(value.messages) || value.messages.length === 0)
        throw new Error("A2UI_PAYLOAD_INVALID");
      return value;
    });
  };
  // The E2E endpoint's ordered stream is authoritative. Do not append duplicate delivery projections.
  if (Object.hasOwn(root, "a2ui")) return read(root.a2ui);
  const messages = Array.isArray(root.delivered_messages) ? root.delivered_messages : [];
  const cards = messages.flatMap((m) => read(object(m).a2ui));
  return cards.length ? cards : read(object(root.final_output).a2ui);
}

/** Fixed local renderer origin, never a Case-provided URL. */
export function captureOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("A2UI_WEB_ORIGIN_INVALID");
  return url.origin;
}

/** No business APIs, credentials, arbitrary remote images or file URLs in replay contexts. */
export function captureResourceAllowed(value: string, origin: string, method: string): boolean {
  const url = new URL(value);
  return (
    method === "GET" &&
    !url.username &&
    !url.password &&
    ((url.origin === origin && url.pathname.startsWith("/static/")) ||
      (url.protocol === "https:" &&
        ["fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname)))
  );
}

export const captureFailureNotes: Readonly<Record<string, string>> = {
  A2UI_PAYLOAD_MISSING: "未取得真实出站 A2UI 数据，无法截图。请检查出卡断言和 E2E 出站采集。",
  A2UI_PAYLOAD_INVALID: "出站 A2UI 数据缺少有效 messages，无法渲染。",
  A2UI_EXECUTION_UNAVAILABLE: "本次执行未保存可用输出，无法采集截图。",
  A2UI_WEB_ORIGIN_INVALID: "截图服务地址配置无效；需使用本机 Web UI 地址。",
  A2UI_CAPTURE_TIMEOUT: "截图采集超时；请检查 Web UI、浏览器和静态资源。",
  A2UI_CAPTURE_CANCELLED: "截图采集被停止；可使用保存的证据重新采集。",
  A2UI_CAPTURE_LIMIT: "截图超过 10 张或单张超过 6 MB，未将不完整截图标记为采集成功。",
  A2UI_RESOURCE_CATALOG_INVALID: "Web UI 资源目录格式无效，请检查生产静态资源配置。",
  A2UI_RESOURCE_LOAD_FAILED: "截图依赖资源加载失败或被隔离策略拒绝，请检查静态资源和网络。",
  A2UI_RUNTIME_ERROR: "Web 卡片运行时异常；未保存不可靠截图。",
  A2UI_ANIMATION_FAILED: "卡片动画加载或渲染失败；未将降级画面标记为采集成功，可重新采集。",
  A2UI_RENDER_FAILED: "Web 卡片渲染失败，请检查 Web UI 静态资源及卡片数据。"
};
