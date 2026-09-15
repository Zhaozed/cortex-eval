import type { DashboardCase } from "./run-dashboard-model.ts";

/** Explain known ingress failures without guessing a business root cause. */
export function executionIssue(row: DashboardCase): string | null {
  if (
    row.rest.status !== "SUCCEEDED" ||
    !("providerOutput" in row.rest) ||
    row.rest.providerOutput.ok
  )
    return null;
  const code = row.rest.providerOutput.err_msg;
  const descriptions: Readonly<Record<string, string>> = {
    EVAL_E2E_CONTEXT_MODE_REQUIRED:
      "本次请求未执行：隔离模式不支持连续多轮，会清除上轮上下文。请先确认测试账号与会话范围，再显式选择客户端会话模式。",
    EVAL_E2E_CLIENT_CONTEXT_REQUIRED:
      "本次请求未执行：客户端会话模式必须明确填写测试账号 uid 和会话 sid。该模式使用真实会话上下文与焦点，不会自动绑定身份。",
    EVAL_E2E_MULTI_TURN_INCOMPLETE:
      "多轮执行未完成：前一轮执行或出站等待未完成，入口已停止后续轮次。已保存的部分结果仍可查看，详见逐轮 Trace 和采集状态。",
    EVAL_E2E_TIMEOUT: "入口等待超时。已保存的部分结果仍可查看；超时不等于已入队的工具操作被撤销。",
    EVAL_E2E_STORAGE_UNAVAILABLE: "入口队列或存储不可用。本次未完成；已保存证据不会丢弃。"
  };
  return `${descriptions[code] ?? "入口返回执行异常，请查看原始响应和执行链路。"}（${code}）`;
}
