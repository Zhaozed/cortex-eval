import { JsonObjectSchema } from "@cortex-eval/contracts/src/contracts-primitives.ts";
import type { ReactElement, Ref } from "react";

import { Button } from "../../components/ui/button.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { CaseValueFields } from "./case-value-fields.tsx";

/** Form-first request body; raw JSON is an explicit compatibility escape hatch. */
export function CaseRequestFields({
  text,
  onChange,
  error,
  rawRef,
  briefMode = false
}: {
  readonly briefMode?: boolean;
  readonly text: string;
  readonly onChange: (value: string) => void;
  readonly error: boolean;
  readonly rawRef: Ref<HTMLTextAreaElement>;
}): ReactElement {
  let body: ReturnType<typeof JsonObjectSchema.safeParse> | undefined;
  try {
    body = JsonObjectSchema.safeParse(JSON.parse(text));
  } catch {
    /* Keep invalid raw text. */
  }
  return (
    <section className="case-editor-section field-wide">
      <div className="case-section-heading">
        <div>
          <h3>
            <span className="case-section-number">02</span> 请求与测试数据
          </h3>
          <p>填写用户输入和接口参数，保留字段类型。</p>
        </div>
      </div>
      {body?.success ? (
        <>
          {!briefMode && Object.keys(body.data).length === 0 ? (
            <div className="case-request-empty">
              <p>尚未配置请求参数。可逐项添加，也可先填入 Cortex E2E 常用字段。</p>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  onChange(
                    JSON.stringify({
                      text: "",
                      uid: { __cortex_eval_int64: "" },
                      timezone: "Asia/Shanghai",
                      lang: "zh-Hans"
                    })
                  )
                }
              >
                填入 E2E 常用字段
              </Button>
              <p className="field-hint">请填写已授权测试账号的 uid。接口地址由运行配置决定。</p>
            </div>
          ) : null}
          {!briefMode && (
            <details className="case-advanced">
              <summary>Cortex E2E 会话模式（仅适用于 /eval/e2e）</summary>
              <label htmlFor="case-e2e-execution-mode">执行模式</label>
              <select
                id="case-e2e-execution-mode"
                value={typeof body.data.execution_mode === "string" ? body.data.execution_mode : ""}
                onChange={(event) => {
                  const next = { ...body.data };
                  if (event.currentTarget.value) next.execution_mode = event.currentTarget.value;
                  else delete next.execution_mode;
                  onChange(JSON.stringify(next, null, 2));
                }}
              >
                <option value="">沿用入口默认（单轮隔离）</option>
                <option value="isolated">单轮隔离</option>
                <option value="client">客户端会话（支持连续多轮）</option>
              </select>
              <p className="field-hint">
                隔离模式不读取上轮上下文，可能受真实焦点限制而暂缓输出。 客户端会话模式需填写
                uid、sid，会使用该账号的真实上下文与焦点；确认范围后再选择，勿与同账号其他操作并发。
              </p>
            </details>
          )}
          <CaseValueFields
            fixedObject
            dedicatedFields={["execution_mode"]}
            label="请求参数"
            value={body.data}
            suggestions={[
              "text",
              "uid",
              "timezone",
              "lang",
              "time",
              "conversation",
              "sid",
              "task_history",
              "verbose"
            ]}
            onChange={(value) => onChange(JSON.stringify(value, null, 2))}
          />
        </>
      ) : null}
      <details className="case-advanced" open={error || !body?.success ? true : undefined}>
        <summary>高级编辑 · 请求 JSON</summary>
        <label htmlFor="case-request-body">Request Body JSON</label>
        <Textarea
          ref={rawRef}
          id="case-request-body"
          aria-invalid={error}
          aria-describedby={error ? "case-structured-error" : undefined}
          value={text}
          onChange={(e) => onChange(e.currentTarget.value)}
          rows={7}
        />
      </details>
    </section>
  );
}
