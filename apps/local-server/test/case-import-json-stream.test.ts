import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { CaseImportJsonError, parseCaseDefinitionStream } from "../src/case-import-json-stream.ts";

function dto(caseKey: string): Readonly<Record<string, unknown>> {
  return {
    contractVersion: "cortex.case-definition.v1",
    description: caseKey,
    threshold: 1,
    vars: { task: "route", request_body: { caseKey } },
    metadata: {
      case_id: caseKey,
      req_id: `req-${caseKey}`,
      task_id: `task-${caseKey}`,
      business_module: "chat",
      scenario_tag: "smoke"
    },
    assert: [{ type: "contains", metric: "quality", weight: 1 }]
  };
}

describe("Case import JSON stream", () => {
  it("跨任意字节分块逐项校验并映射，不构造完整数组", async () => {
    const json = JSON.stringify([dto("case-1"), dto("case-2")]);
    const chunks = Array.from(json, (character) => Buffer.from(character));
    const values = [];
    for await (const value of parseCaseDefinitionStream(
      Readable.from(chunks),
      new AbortController().signal
    )) {
      values.push(value);
    }
    expect(values.map((value) => value.caseKey)).toEqual(["case-1", "case-2"]);
  });

  it("结构错误保留输入顺序、Case Key 和字段路径", async () => {
    const invalid = { ...dto("case-2"), threshold: 2 };
    const stream = parseCaseDefinitionStream(
      Readable.from([JSON.stringify([dto("case-1"), invalid])]),
      new AbortController().signal
    );
    expect(await stream.next()).toMatchObject({ value: { caseKey: "case-1" } });
    await expect(stream.next()).rejects.toEqual(
      new CaseImportJsonError("CASE_IMPORT_ITEM_INVALID", 1, "case-2", "threshold")
    );
  });

  it("非法 JSON 和取消使用稳定错误且销毁流", async () => {
    const malformed = parseCaseDefinitionStream(
      Readable.from(["[{"]),
      new AbortController().signal
    );
    await expect(malformed.next()).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const controller = new AbortController();
    controller.abort();
    const source = Readable.from([JSON.stringify([dto("case-1")])]);
    await expect(parseCaseDefinitionStream(source, controller.signal).next()).rejects.toMatchObject(
      {
        code: "CASE_IMPORT_CANCELLED"
      }
    );
    expect(source.destroyed).toBe(true);
  });
});
