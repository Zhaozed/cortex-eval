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
  rawRef
}: {
  readonly text: string;
  readonly onChange: (value: string) => void;
  readonly error: boolean;
  readonly rawRef: Ref<HTMLTextAreaElement>;
}): ReactElement {
  let body;
  try {
    body = JsonObjectSchema.safeParse(JSON.parse(text));
  } catch {
    /* Keep invalid raw text. */
  }
  return (
    <section className="case-editor-section field-wide">
      <div className="case-section-heading">
        <div>
          <h3>请求参数</h3>
          <p>填写发给被测接口的内容。字段类型会保留，不需要编写 JSON。</p>
        </div>
      </div>
      {body?.success ? (
        <>
          {Object.keys(body.data).length === 0 ? (
            <div className="case-request-empty">
              <p>尚未配置请求参数。可逐项添加，也可先填入 Cortex E2E 常用字段。</p>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  onChange(
                    JSON.stringify({
                      text: "",
                      uid: { __cortex_eval_int64: "0" },
                      timezone: "Asia/Shanghai",
                      lang: "zh-Hans"
                    })
                  )
                }
              >
                填入 E2E 常用字段
              </Button>
              <p className="field-hint">
                uid=0 仅为占位，运行前须替换成已授权测试账号。接口地址由运行配置决定。
              </p>
            </div>
          ) : null}
          <CaseValueFields
            fixedObject
            label="请求参数"
            value={body.data}
            suggestions={[
              "text",
              "uid",
              "timezone",
              "lang",
              "time",
              "conversation",
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
